"use client";

import {
  ArrowLeft,
  ArrowsOut,
  BookOpenText,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CheckCircle,
  CirclesFour,
  Code,
  Crosshair,
  DeviceMobile,
  DotsThree,
  GearSix,
  HandTap,
  House,
  ListBullets,
  MagnifyingGlass,
  Pause,
  PaperPlaneTilt,
  PlugsConnected,
  Robot,
  ShieldCheck,
  SlidersHorizontal,
  SquaresFour,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ControlPlaneEndpoint,
  controlPlaneFetch,
  liveControlPlaneBaseUrl,
  resolveControlPlaneEndpoint,
} from "./control-plane-endpoint";
import { LiveScreen, type LiveFrame } from "./live-screen";
import {
  inferIntentSwipe,
  mapCameraPointToScreen,
  mapContainedClientPoint,
} from "./pointer-geometry";
import {
  PRESSURE_PRESETS,
  type PressurePreset,
  touchZForPressure,
} from "./touch-pressure";

const POLL_INTERVAL_MS = 700;
const HOVER_MOVE_INTERVAL_MS = 120;
const LIVE_TOUCH_MOVE_INTERVAL_MS = 70;
const LIVE_TOUCH_KEEPALIVE_MS = 450;
const GENERAL_AGENT_UI_ENABLED =
  process.env.NEXT_PUBLIC_SCREENHAND_LOCAL_CONTROL_PLANE_PROXY === "1";

type Availability = { available: boolean; reason?: string };

type DeviceCapabilities = {
  observation: {
    screenshot: Availability;
    liveFrames: Availability;
  };
  actions: {
    status: Availability;
    hold: Availability;
    resume: Availability;
    home: Availability;
    hover_move?: Availability;
    touch_down?: Availability;
    touch_move?: Availability;
    touch_up?: Availability;
    touch_keepalive?: Availability;
    tap: Availability;
    long_press: Availability;
    swipe: Availability;
    input_text?: Availability;
    phone_key?: Availability;
    wait: Availability;
  };
};

type ScreenHandDevice = {
  id: string;
  kind: string;
  status: "running" | "offline";
  connected: boolean;
  connectedAt: number | null;
  lastSeenAt: number | null;
  state: {
    cameraReady?: boolean;
    cameraDetail?: string;
    videoMode?: "wired" | "camera_fallback" | "waiting";
    videoDetail?: string;
      grbl?: {
      connected?: boolean;
      homed?: boolean;
      state?: string;
        calibrationActive?: boolean;
        activeOperation?: {
          type?: string;
          status?: string;
        } | null;
      liveTouch?: {
        active?: boolean;
        expiresInMs?: number;
      } | null;
      tapProfile?: {
        touchZ?: number;
        minimumTouchZ?: number;
        maximumTouchZ?: number;
      };
    };
    touchMapping?: {
      appScreenBounds?: {
        left: number;
        top: number;
        right: number;
        bottom: number;
      };
      systemNavigation?: Partial<Record<
        "back" | "home" | "enter",
        Availability & {
          strategy?: string;
          requiredPlacement?: {
            direction: "toward-screen-top";
            minimumMm: number;
          };
        }
      >>;
    } | null;
  } | null;
  screen: {
    width: number;
    height: number;
    rawWidth?: number;
    rawHeight?: number;
    rectified?: boolean;
    imagePoints?: [PointerPoint, PointerPoint, PointerPoint, PointerPoint] | null;
    sequence: number;
    capturedAt: number;
    source: string;
  } | null;
  capabilities: DeviceCapabilities;
  demo?: boolean;
};

type DevicesResponse = {
  ok: boolean;
  protocolVersion: string;
  devices: ScreenHandDevice[];
};

type PointerPoint = { x: number; y: number };
type AutoSetupPreview = {
  ok: true;
  status:
    | "ready"
    | "automatic_baseline_ready"
    | "unknown_phone_detected"
    | "baseline_required"
    | "manual_review";
  deviceId: string;
  reason: string;
  homed: boolean;
  frame: { width: number; height: number; sequence: number };
  activeImagePoints: [PointerPoint, PointerPoint, PointerPoint, PointerPoint];
  proposedImagePoints: [PointerPoint, PointerPoint, PointerPoint, PointerPoint] | null;
  referenceCapturedAt: string | null;
  referenceReuse?: {
    source: "current_version" | "previous_version" | "none";
    status: "local" | "compatible" | "incompatible" | "missing" | "disabled";
    reason: string;
    savedCalibrationId?: string;
    activeCalibrationId: string;
  };
  registration: {
    confidence: number;
    elapsedMs: number;
    meanDriftPx: number;
    maximumDriftPx: number;
  } | null;
  automaticBaseline?: {
    frameCount: number;
    confidence: number;
    score: number;
    meanDeviationPx: number;
    maximumDeviationPx: number;
    elapsedMs: number;
  } | null;
  unknownPhoneCandidate?: {
    canonicalScreen: { width: number; height: number; aspectRatio: number };
    physicalScreen: { widthMm: number; heightMm: number };
    confidence: number;
    score: number;
    elapsedMs: number;
    meanDeviationPx: number;
    maximumDeviationPx: number;
    navigationAssessment:
      | "edge_gesture_candidate"
      | "on_screen_home_button_candidate"
      | "physical_home_button_candidate"
      | "unknown";
    contactDepthAssessment: {
      mode: "shadow";
      strategy: "camera-surface-intersection-v1";
      status: "observation_required";
      requiresZObservableCamera: true;
      requiresCompliantContactProof: true;
      actionReady: false;
    };
    physicalHomeButtonEvidence?: {
      observation: {
        status: "detected" | "not_detected" | "unobservable";
        confidence: number;
        actionReady: false;
      };
      machinePoint: PointerPoint | null;
      withinMovementBounds: boolean;
      mappingExtrapolated: true;
    };
    onScreenNavigationEvidence?: {
      observation: {
        status: "detected" | "not_detected";
        strategy: "gesture_handle" | "three_button" | "unknown";
        confidence: number;
        actionReady: false;
      };
      machinePoint: PointerPoint | null;
      withinMovementBounds: boolean | null;
      mappingExtrapolated: false;
    };
    xyReady: true;
    touchDepthReady: false;
    actionReady: false;
    blockers: string[];
  } | null;
};
type ClientPointer = { clientX: number; clientY: number };
type PointerSession = {
  pointerId: number;
  startedAt: number;
  start: PointerPoint;
  current: PointerPoint;
};
type InteractionMode = "standard" | "live_mouse";
type LiveTouchSession = {
  pointerId: number;
  sessionId: string;
  current: PointerPoint;
  frameSequence: number;
  downAccepted: boolean;
  released: boolean;
  downRequest: Promise<boolean>;
  lastMoveRequest: Promise<boolean>;
};

type ActionPayload =
  | { type: "hover_move"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number }
  | { type: "touch_down"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; sessionId: string; touchZ?: number }
  | { type: "touch_move"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; sessionId: string }
  | { type: "touch_up"; sessionId: string }
  | { type: "touch_keepalive"; sessionId: string }
  | { type: "tap"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; touchZ?: number }
  | { type: "long_press"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; durationMs: number; touchZ?: number }
  | { type: "swipe"; start: PointerPoint; end: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; durationMs: number; touchZ?: number }
  | { type: "phone_key"; key: "back" | "home" | "enter" }
  | { type: "home"; confirmation: "CLEAR_WORKSPACE_AND_HOME" }
  | { type: "resume" }
  | { type: "hold" };

type AgentCommandResult = {
  status: "planned" | "completed" | "blocked" | "failed" | "timed_out";
  reason: string;
  steps: Array<{
    stepId: string;
    status: "pending" | "running" | "completed" | "blocked" | "uncertain";
    reason: string;
  }>;
  program?: {
    steps: Array<{
      operation: string;
      objective: string;
      sideEffect: string;
    }>;
    compiler: {
      strategy: "local" | "model" | "fallback";
      elapsedMs: number;
      cacheHit: boolean;
    };
  };
  metrics: {
    totalMs: number;
    compileMs?: number;
    executionMs?: number;
    actions: number;
    observations?: number;
    recoveries?: number;
  };
};

type RealtimeAgentHealth = {
  ok: boolean;
  visionReady: boolean;
  controlPlaneUrl: string;
  universalTaskCompilerReady: boolean;
  upstream: {
    deviceId: string;
    reachable: boolean;
    connected: boolean;
    homed: boolean;
    screenshotAvailable: boolean;
    tapAvailable: boolean;
    readyForPreview: boolean;
    readyForExecute: boolean;
    blockReason: string | null;
  };
};

const unavailable: Availability = { available: false, reason: "Device offline" };
const emptyCapabilities: DeviceCapabilities = {
  observation: { screenshot: unavailable, liveFrames: unavailable },
  actions: {
    status: { available: true },
    hold: { available: true },
    resume: unavailable,
    home: unavailable,
    hover_move: unavailable,
    touch_down: unavailable,
    touch_move: unavailable,
    touch_up: unavailable,
    touch_keepalive: unavailable,
    tap: unavailable,
    long_press: unavailable,
    swipe: unavailable,
    wait: { available: true },
  },
};

function demoDevices(): ScreenHandDevice[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `screenhand-demo-${String(index + 1).padStart(2, "0")}`,
    kind: "physical_robot",
    status: index === 7 ? "offline" : "running",
    connected: index !== 7,
    connectedAt: Date.now() - (index + 1) * 93_000,
    lastSeenAt: Date.now(),
    state: {
      cameraReady: index !== 7,
      cameraDetail: "USB Camera2 · 720×1280",
      videoMode: "camera_fallback",
      videoDetail: "Physical camera",
      grbl: {
        connected: index !== 7,
        homed: index !== 7,
        state: index === 7 ? "Offline" : "Idle",
        calibrationActive: index !== 7,
      },
    },
    screen: {
      width: 720,
      height: 1280,
      sequence: 200 + index,
      capturedAt: Date.now(),
      source: "demo",
    },
    capabilities: index === 7
      ? emptyCapabilities
      : {
          observation: { screenshot: { available: true }, liveFrames: { available: true } },
          actions: {
            status: { available: true },
            hold: { available: true },
            resume: { available: false, reason: "Demo controller is already idle" },
            home: { available: false, reason: "Demo device is already homed" },
            hover_move: { available: true },
            touch_down: { available: true },
            touch_move: { available: true },
            touch_up: { available: true },
            touch_keepalive: { available: true },
            tap: { available: true },
            long_press: { available: true },
            swipe: { available: true },
            phone_key: { available: true },
            wait: { available: true },
          },
        },
    demo: true,
  }));
}

function titleFor(device: ScreenHandDevice, index: number) {
  if (device.id.startsWith("screenhand-demo-")) return `ScreenHand ${String(index + 1).padStart(2, "0")}`;
  if (device.id === "black-arm-01") return "ScreenHand 01";
  return device.id;
}

function shortId(device: ScreenHandDevice) {
  return device.id.replace(/^screenhand-/, "").replace(/^black-arm-/, "ARM-").toUpperCase();
}

function connectionLabel(device: ScreenHandDevice) {
  if (!device.connected) return "Offline";
  if (!device.state?.grbl?.homed) return "Homing required";
  if (!device.capabilities.actions.tap.available) return "Safety locked";
  return "Ready";
}

function actionError(device: ScreenHandDevice, controlEnabled = true) {
  if (!controlEnabled && device.capabilities.actions.tap.available) {
    return "View-only mode is active. Click Enable control to send touch actions.";
  }
  return device.capabilities.actions.tap.reason ?? "Touch is locked until this physical device is calibrated and homed.";
}

function AgentCommandBar({
  device,
  controlEnabled,
  onToast,
}: {
  device: ScreenHandDevice | null;
  controlEnabled: boolean;
  onToast: (message: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState<"dry_run" | "execute" | null>(null);
  const [result, setResult] = useState<AgentCommandResult | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<RealtimeAgentHealth | null>(null);
  const [runtimeError, setRuntimeError] = useState("Connecting to realtime Agent…");

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/realtime-agent-api/health", { cache: "no-store" });
        const payload = await response.json() as RealtimeAgentHealth & { error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || `Realtime Agent health failed (${response.status})`);
        }
        if (!cancelled) {
          setRuntimeHealth(payload);
          setRuntimeError("");
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeHealth(null);
          setRuntimeError(error instanceof Error ? error.message : "Realtime Agent is offline");
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const sameDevice = Boolean(
    device && runtimeHealth?.upstream.deviceId === device.id,
  );
  const canPreview = Boolean(
    device && runtimeHealth?.ok && runtimeHealth.universalTaskCompilerReady,
  );
  const canExecute = Boolean(
    canPreview && sameDevice && controlEnabled && runtimeHealth?.upstream.readyForExecute,
  );
  const executeBlocker = !device
    ? "Select a device first."
    : runtimeError
      ? runtimeError
      : !runtimeHealth?.universalTaskCompilerReady
        ? "The universal Task IR compiler is not ready."
        : !sameDevice
          ? `Realtime Agent is attached to ${runtimeHealth?.upstream.deviceId ?? "another device"}.`
          : runtimeHealth.upstream.blockReason
            ? runtimeHealth.upstream.blockReason
            : !controlEnabled
              ? "Enable physical control before running a command."
              : null;

  const submit = async (mode: "dry_run" | "execute") => {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || !device || running || !canPreview) return;
    if (mode === "execute") {
      if (!canExecute) {
        onToast(executeBlocker ?? "Physical execution is safety locked.");
        return;
      }
      const confirmed = window.confirm(
        `Run this command on ${device.id}?\n\n${trimmedGoal}\n\nThe robotic arm will move.`,
      );
      if (!confirmed) return;
    }
    setRunning(mode);
    setResult(null);
    try {
      const response = await fetch("/realtime-agent-api/api/v1/realtime/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: trimmedGoal,
          deviceId: device.id,
          mode,
          accessMode: "full_access",
          timeoutMs: mode === "execute" ? 300_000 : 45_000,
        }),
      });
      const submitted = await response.json() as {
        error?: string;
        result?: AgentCommandResult;
      };
      if (!submitted.result) {
        throw new Error(submitted.error || `Agent request failed (${response.status})`);
      }
      setResult(submitted.result);
      onToast(submitted.result.reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent command failed";
      setResult({
        status: "failed",
        reason: message,
        steps: [],
        metrics: {
          totalMs: 0,
          actions: 0,
        },
      });
      onToast(message);
    } finally {
      setRunning(null);
    }
  };

  const runtimeSummary = runtimeError
    ? runtimeError
    : runtimeHealth?.upstream.readyForExecute
      ? `Realtime ready · ${runtimeHealth.upstream.deviceId}`
      : runtimeHealth?.upstream.blockReason ?? "Realtime Agent is warming up";

  return (
    <section className="agent-command-bar" aria-label="Natural language mobile agent">
      <div className="agent-command-icon"><Robot size={22} weight="fill" /></div>
      <div className="agent-command-copy">
        <strong>ScreenHand Agent</strong>
        <span>{runtimeSummary}. Preview never moves hardware.</span>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void submit("dry_run"); }}>
        <input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="例如：打开 Telegram、点击 Continue、返回首页"
          aria-label="Agent command"
          disabled={!canPreview || running !== null}
        />
        <button
          type="submit"
          disabled={!canPreview || !goal.trim() || running !== null}
          title={canPreview ? "Compile the complete Task IR without moving hardware" : runtimeSummary}
        >
          {running === "dry_run" ? "Planning…" : "Preview"}
        </button>
        <button
          type="button"
          className="agent-run-button"
          disabled={!canExecute || !goal.trim() || running !== null}
          onClick={() => void submit("execute")}
          title={canExecute ? "Run through the realtime Agent and protected physical API" : executeBlocker ?? "Physical execution is locked"}
        >
          <PaperPlaneTilt size={15} weight="fill" />
          {running === "execute" ? "Running…" : "Run"}
        </button>
      </form>
      {result ? (
        <div className={`agent-command-result ${result.status}`}>
          <strong>{result.status.replace("_", " ")}</strong>
          <span>{result.reason}</span>
          <small>
            {result.program
              ? `${result.program.steps.length} steps · ${result.program.compiler.strategy}`
              : `${result.steps.length} recorded steps`}
            {` · ${result.metrics.actions} actions · ${result.metrics.totalMs} ms`}
          </small>
        </div>
      ) : null}
    </section>
  );
}

function DeviceTile({
  device,
  index,
  endpoint,
  controlEnabled,
  selected,
  onSelect,
  onAction,
  onHover,
  onLiveTouch,
  onFullscreen,
  onPosition,
  onAutoSetup,
}: {
  device: ScreenHandDevice;
  index: number;
  endpoint: ControlPlaneEndpoint | null;
  controlEnabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onAction: (device: ScreenHandDevice, action: ActionPayload) => Promise<boolean>;
  onHover: (device: ScreenHandDevice, action: ActionPayload) => Promise<void>;
  onLiveTouch: (
    device: ScreenHandDevice,
    action: ActionPayload,
    options?: { keepalive?: boolean },
  ) => Promise<boolean>;
  onFullscreen: (device: ScreenHandDevice) => void;
  onPosition: (device: ScreenHandDevice) => void;
  onAutoSetup: (device: ScreenHandDevice) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mouseTargetRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<PointerSession | null>(null);
  const deviceRef = useRef(device);
  const liveTouchRef = useRef<LiveTouchSession | null>(null);
  const liveMoveTimerRef = useRef<number | null>(null);
  const pendingLiveMoveRef = useRef<{ point: PointerPoint; frameSequence: number } | null>(null);
  const lastLiveMoveSentRef = useRef<{ point: PointerPoint; at: number } | null>(null);
  const lastLiveSignalAtRef = useRef(0);
  const hoverTimerRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<PointerPoint | null>(null);
  const lastHoverSentRef = useRef<{ point: PointerPoint; at: number } | null>(null);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamDetail, setStreamDetail] = useState("");
  const [pressed, setPressed] = useState(false);
  const [pressurePreset, setPressurePreset] = useState<PressurePreset>("natural");
  // Intent gestures are the everyday cloud-phone experience. Live mouse is
  // an explicit precision mode for press-and-hold or exact physical dragging.
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("standard");

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  const canTouch = controlEnabled && device.connected && device.capabilities.actions.tap.available;
  const canUsePhoneNavigation = (key: "back" | "home") => {
    const keyAvailability = device.state?.touchMapping?.systemNavigation?.[key];
    return controlEnabled && device.connected &&
      device.capabilities.actions.phone_key?.available === true &&
      keyAvailability?.available !== false;
  };
  const homePlacement = device.state?.touchMapping?.systemNavigation?.home
    ?.requiredPlacement;
  const canHover = interactionMode === "live_mouse" && controlEnabled && device.connected &&
    device.capabilities.actions.hover_move?.available === true;
  const supportsLiveTouch = Boolean(
    device.capabilities.actions.touch_down?.available === true &&
    device.capabilities.actions.touch_move?.available === true &&
    device.capabilities.actions.touch_up &&
    device.capabilities.actions.touch_keepalive,
  );
  const canStartLiveTouch = controlEnabled && device.connected &&
    device.capabilities.actions.touch_down?.available === true;
  const canInteract = interactionMode === "live_mouse"
    ? canStartLiveTouch || pressed
    : canTouch;
  const frameWidth = frame?.width ?? device.screen?.rawWidth ?? device.screen?.width ?? 720;
  const frameHeight = frame?.height ?? device.screen?.rawHeight ?? device.screen?.height ?? 1280;
  const width = device.screen?.width ?? frame?.width ?? 720;
  const height = device.screen?.height ?? frame?.height ?? 1280;
  const sequence = frame?.sequence ?? device.screen?.sequence ?? 0;
  const tapProfile = device.state?.grbl?.tapProfile;
  const maximumTouchZ = Number(tapProfile?.maximumTouchZ ?? tapProfile?.touchZ);
  const minimumTouchZ = Number(
    tapProfile?.minimumTouchZ ??
    (Number.isFinite(maximumTouchZ) ? maximumTouchZ - 0.5 : Number.NaN),
  );
  const selectedTouchZ = touchZForPressure(pressurePreset, {
    minimum: minimumTouchZ,
    maximum: maximumTouchZ,
  });
  const touchDepth = selectedTouchZ === null ? {} : { touchZ: selectedTouchZ };

  const clearPendingLiveMove = useCallback(() => {
    pendingLiveMoveRef.current = null;
    if (liveMoveTimerRef.current !== null) {
      window.clearTimeout(liveMoveTimerRef.current);
      liveMoveTimerRef.current = null;
    }
  }, []);

  const releaseLiveTouch = useCallback((reason: string, updateUi = true) => {
    const session = liveTouchRef.current;
    if (!session || session.released) return;
    session.released = true;
    liveTouchRef.current = null;
    clearPendingLiveMove();
    lastLiveMoveSentRef.current = null;
    if (updateUi) setPressed(false);
    void session.downRequest
      .catch(() => false)
      .then(() => session.lastMoveRequest.catch(() => false))
      .then(() => onLiveTouch(
        deviceRef.current,
        { type: "touch_up", sessionId: session.sessionId },
        { keepalive: true },
      ))
      .then((released) => {
        if (!released) console.warn(`ScreenHand live-touch release was not acknowledged (${reason})`);
      })
      .catch((error) => console.warn("ScreenHand live-touch release failed", error));
  }, [clearPendingLiveMove, onLiveTouch]);

  const dispatchPendingLiveMove = useCallback(() => {
    liveMoveTimerRef.current = null;
    const pending = pendingLiveMoveRef.current;
    pendingLiveMoveRef.current = null;
    const session = liveTouchRef.current;
    if (!pending || !session || session.released || !session.downAccepted) return;
    const now = performance.now();
    lastLiveMoveSentRef.current = { point: pending.point, at: now };
    lastLiveSignalAtRef.current = now;
    const request = onLiveTouch(deviceRef.current, {
      type: "touch_move",
      point: pending.point,
      viewport: { width, height },
      frameSequence: pending.frameSequence,
      sessionId: session.sessionId,
    });
    session.lastMoveRequest = request;
    void request.then((accepted) => {
      if (!accepted && liveTouchRef.current === session) {
        releaseLiveTouch("move rejected");
      }
    }).catch(() => {
      if (liveTouchRef.current === session) releaseLiveTouch("move request failed");
    });
  }, [height, onLiveTouch, releaseLiveTouch, width]);

  const scheduleLiveMove = useCallback((point: PointerPoint, frameSequence: number) => {
    const session = liveTouchRef.current;
    if (!session || session.released || !session.downAccepted || !frameSequence) return;
    const last = lastLiveMoveSentRef.current;
    const deadband = Math.min(width, height) * 0.002;
    if (last && Math.hypot(point.x - last.point.x, point.y - last.point.y) < deadband) return;
    pendingLiveMoveRef.current = { point, frameSequence };
    if (liveMoveTimerRef.current !== null) return;
    const elapsed = last ? performance.now() - last.at : LIVE_TOUCH_MOVE_INTERVAL_MS;
    liveMoveTimerRef.current = window.setTimeout(
      dispatchPendingLiveMove,
      Math.max(0, LIVE_TOUCH_MOVE_INTERVAL_MS - elapsed),
    );
  }, [dispatchPendingLiveMove, height, width]);

  const cameraPointFromEvent = useCallback((event: ClientPointer) => {
    const media = stageRef.current?.querySelector(":scope > canvas, :scope > img");
    if (!media) return null;
    return mapContainedClientPoint(
      { x: event.clientX, y: event.clientY },
      media.getBoundingClientRect(),
      { width: frameWidth, height: frameHeight },
    );
  }, [frameHeight, frameWidth]);

  const pointFromEvent = useCallback((event: ClientPointer) => {
    const cameraPoint = cameraPointFromEvent(event);
    if (!cameraPoint) return null;
    const imagePoints = device.screen?.imagePoints;
    if (frame?.rectified === false && imagePoints) {
      return mapCameraPointToScreen(cameraPoint, imagePoints, { width, height });
    }
    return cameraPoint;
  }, [cameraPointFromEvent, device.screen?.imagePoints, frame?.rectified, height, width]);

  const hideMouseTarget = useCallback(() => {
    const target = mouseTargetRef.current;
    if (!target) return;
    target.style.opacity = "0";
    target.style.visibility = "hidden";
  }, []);

  const moveMouseTarget = useCallback((event: ClientPointer) => {
    const cameraPoint = cameraPointFromEvent(event);
    const bounds = stageRef.current?.getBoundingClientRect();
    const target = mouseTargetRef.current;
    if (!cameraPoint || !bounds || bounds.width <= 0 || bounds.height <= 0 || !target) {
      hideMouseTarget();
      return pointFromEvent(event);
    }
    const point = pointFromEvent(event);
    target.style.left = `${Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))}px`;
    target.style.top = `${Math.max(0, Math.min(bounds.height, event.clientY - bounds.top))}px`;
    target.style.opacity = "1";
    target.style.visibility = "visible";
    const label = target.firstElementChild;
    if (label) {
      label.textContent = point
        ? `${Math.round(Math.max(0, Math.min(100, (point.x / width) * 100)))}%, ${Math.round(Math.max(0, Math.min(100, (point.y / height) * 100)))}%`
        : "Outside screen";
    }
    return point;
  }, [cameraPointFromEvent, height, hideMouseTarget, pointFromEvent, width]);

  const trackMouse = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || interactionMode !== "live_mouse") {
      return pointFromEvent(event);
    }
    return moveMouseTarget(event);
  };

  const dispatchPendingHover = useCallback(() => {
    hoverTimerRef.current = null;
    const point = pendingHoverRef.current;
    pendingHoverRef.current = null;
    if (!point || !canHover || !sequence || pointerRef.current || liveTouchRef.current) return;
    lastHoverSentRef.current = { point, at: performance.now() };
    void onHover(device, {
      type: "hover_move",
      point,
      viewport: { width, height },
      frameSequence: sequence,
    });
  }, [canHover, device, height, onHover, sequence, width]);

  const scheduleHover = useCallback((point: PointerPoint) => {
    if (!canHover || !sequence || pointerRef.current || liveTouchRef.current) return;
    const last = lastHoverSentRef.current;
    const deadband = Math.min(width, height) * 0.006;
    if (last && Math.hypot(point.x - last.point.x, point.y - last.point.y) < deadband) return;
    pendingHoverRef.current = point;
    if (hoverTimerRef.current !== null) return;
    const elapsed = last ? performance.now() - last.at : HOVER_MOVE_INTERVAL_MS;
    hoverTimerRef.current = window.setTimeout(
      dispatchPendingHover,
      Math.max(0, HOVER_MOVE_INTERVAL_MS - elapsed),
    );
  }, [canHover, dispatchPendingHover, height, sequence, width]);

  useEffect(() => {
    if (canHover) return;
    pendingHoverRef.current = null;
    lastHoverSentRef.current = null;
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, [canHover]);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    if (liveMoveTimerRef.current !== null) window.clearTimeout(liveMoveTimerRef.current);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const session = liveTouchRef.current;
      const now = performance.now();
      if (
        !session ||
        session.released ||
        !session.downAccepted ||
        now - lastLiveSignalAtRef.current < LIVE_TOUCH_KEEPALIVE_MS
      ) return;
      lastLiveSignalAtRef.current = now;
      void onLiveTouch(deviceRef.current, {
        type: "touch_keepalive",
        sessionId: session.sessionId,
      }).then((accepted) => {
        if (!accepted && liveTouchRef.current === session) {
          releaseLiveTouch("keepalive rejected");
        }
      }).catch(() => {
        if (liveTouchRef.current === session) releaseLiveTouch("keepalive failed");
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [onLiveTouch, releaseLiveTouch]);

  useEffect(() => {
    if (interactionMode !== "live_mouse") {
      hideMouseTarget();
      return;
    }
    const handleMouseMove = (event: MouseEvent) => {
      const point = moveMouseTarget(event);
      if (point) scheduleHover(point);
    };
    window.addEventListener("mousemove", handleMouseMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener("mousemove", handleMouseMove, true);
    };
  }, [hideMouseTarget, interactionMode, moveMouseTarget, scheduleHover]);

  useEffect(() => {
    const failSafeRelease = () => {
      hideMouseTarget();
      releaseLiveTouch("browser lost focus");
    };
    const releaseWhenHidden = () => {
      if (document.visibilityState === "hidden") failSafeRelease();
    };
    window.addEventListener("blur", failSafeRelease);
    window.addEventListener("pagehide", failSafeRelease);
    document.addEventListener("visibilitychange", releaseWhenHidden);
    return () => {
      window.removeEventListener("blur", failSafeRelease);
      window.removeEventListener("pagehide", failSafeRelease);
      document.removeEventListener("visibilitychange", releaseWhenHidden);
    };
  }, [hideMouseTarget, releaseLiveTouch]);

  useEffect(() => {
    const releaseOnGlobalPointerEnd = (event: PointerEvent) => {
      const session = liveTouchRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      releaseLiveTouch(
        event.type === "pointerup"
          ? "mouse released outside control surface"
          : "pointer cancelled outside control surface",
      );
    };
    window.addEventListener("pointerup", releaseOnGlobalPointerEnd);
    window.addEventListener("pointercancel", releaseOnGlobalPointerEnd);
    return () => {
      window.removeEventListener("pointerup", releaseOnGlobalPointerEnd);
      window.removeEventListener("pointercancel", releaseOnGlobalPointerEnd);
    };
  }, [releaseLiveTouch]);

  useEffect(() => {
    if (controlEnabled && device.connected) return;
    const timer = window.setTimeout(
      () => releaseLiveTouch("control or device disconnected"),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [controlEnabled, device.connected, releaseLiveTouch]);

  useEffect(() => () => releaseLiveTouch("screen unmounted", false), [releaseLiveTouch]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onSelect();
    if (!event.isPrimary || event.button !== 0) return;
    const point = trackMouse(event);
    pendingHoverRef.current = null;
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (!point) return;
    if (interactionMode === "live_mouse") {
      if (!canStartLiveTouch || !sequence || liveTouchRef.current) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointers and a few embedded browsers cannot capture the
        // pointer. The window-level pointer-end listener still guarantees a
        // matching release without discarding the initial mouse-down.
      }
      const sessionId = `mouse-${crypto.randomUUID()}`;
      const session: LiveTouchSession = {
        pointerId: event.pointerId,
        sessionId,
        current: point,
        frameSequence: sequence,
        downAccepted: false,
        released: false,
        downRequest: Promise.resolve(false),
        lastMoveRequest: Promise.resolve(true),
      };
      liveTouchRef.current = session;
      lastLiveMoveSentRef.current = { point, at: performance.now() };
      lastLiveSignalAtRef.current = performance.now();
      setPressed(true);
      const request = onLiveTouch(device, {
        type: "touch_down",
        point,
        viewport: { width, height },
        frameSequence: sequence,
        sessionId,
        ...touchDepth,
      });
      session.downRequest = request;
      void request.then((accepted) => {
        session.downAccepted = accepted;
        if (!accepted && liveTouchRef.current === session) {
          releaseLiveTouch("touch down rejected");
          return;
        }
        if (accepted && liveTouchRef.current === session) {
          lastLiveSignalAtRef.current = performance.now();
          scheduleLiveMove(session.current, session.frameSequence);
        }
      }).catch(() => {
        if (liveTouchRef.current === session) releaseLiveTouch("touch down failed");
      });
      return;
    }
    if (!canTouch || !sequence) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer-up delivered on the control surface still completes the
      // gesture even when an embedded browser cannot establish capture.
    }
    pointerRef.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      start: point,
      current: point,
    };
    setPressed(true);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = trackMouse(event);
    const liveSession = liveTouchRef.current;
    if (liveSession?.pointerId === event.pointerId) {
      if (point) {
        liveSession.current = point;
        liveSession.frameSequence = sequence;
        scheduleLiveMove(point, sequence);
      }
      return;
    }
    if (pointerRef.current?.pointerId !== event.pointerId) return;
    if (point) pointerRef.current.current = point;
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerPoint = trackMouse(event);
    const liveSession = liveTouchRef.current;
    if (liveSession?.pointerId === event.pointerId) {
      if (pointerPoint && liveSession.downAccepted && sequence) {
        liveSession.current = pointerPoint;
        liveSession.frameSequence = sequence;
        clearPendingLiveMove();
        const last = lastLiveMoveSentRef.current;
        if (!last || Math.hypot(pointerPoint.x - last.point.x, pointerPoint.y - last.point.y) >= 1) {
          const request = onLiveTouch(device, {
            type: "touch_move",
            point: pointerPoint,
            viewport: { width, height },
            frameSequence: sequence,
            sessionId: liveSession.sessionId,
          });
          liveSession.lastMoveRequest = request;
        }
      }
      releaseLiveTouch("mouse released");
      return;
    }
    const session = pointerRef.current;
    pointerRef.current = null;
    setPressed(false);
    if (!session || session.pointerId !== event.pointerId || !canTouch || !sequence) return;
    const current = pointerPoint ?? session.current;
    const durationMs = Math.round(performance.now() - session.startedAt);
    const viewport = { width, height };
    const inferredSwipe = inferIntentSwipe(session.start, current, viewport);
    if (inferredSwipe && device.capabilities.actions.swipe.available) {
      void onAction(device, {
        type: "swipe",
        start: inferredSwipe.start,
        end: inferredSwipe.end,
        viewport,
        frameSequence: sequence,
        durationMs: inferredSwipe.durationMs,
        ...touchDepth,
      });
      return;
    }
    if (durationMs >= 520 && device.capabilities.actions.long_press.available) {
      void onAction(device, {
        type: "long_press",
        point: current,
        viewport,
        frameSequence: sequence,
        durationMs: Math.min(durationMs, 2_500),
        ...touchDepth,
      });
      return;
    }
    void onAction(device, { type: "tap", point: current, viewport, frameSequence: sequence, ...touchDepth });
  };

  const pointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (liveTouchRef.current?.pointerId === event.pointerId) {
      releaseLiveTouch("pointer cancelled");
    }
    pointerRef.current = null;
    setPressed(false);
    if (event.pointerType === "mouse") hideMouseTarget();
  };

  const chooseInteractionMode = (mode: InteractionMode) => {
    if (mode === interactionMode) return;
    if (interactionMode === "live_mouse") releaseLiveTouch("mode changed");
    pointerRef.current = null;
    setPressed(false);
    setInteractionMode(mode);
  };

  const sendPhoneNavigation = (key: "back" | "home") => {
    onSelect();
    if (pressed) return;
    if (!canUsePhoneNavigation(key)) {
      if (key === "home" && homePlacement) onAutoSetup(device);
      return;
    }
    void onAction(device, { type: "phone_key", key });
  };

  const status = connectionLabel(device);
  return (
    <article className={`wall-device ${selected ? "selected" : ""}`} aria-label={`${titleFor(device, index)} device`}>
      <div className="wall-device-toolbar">
        <div className={`device-presence ${device.connected ? "online" : ""}`}>
          <span />
          {device.connected ? "Live" : "Offline"}
        </div>
        <div className="device-toolbar-actions">
          <button type="button" aria-label={`Position ${titleFor(device, index)}`} onClick={() => onPosition(device)}>
            <Crosshair size={15} />
          </button>
          <button type="button" aria-label={`Open ${titleFor(device, index)} fullscreen`} onClick={() => onFullscreen(device)}>
            <ArrowsOut size={15} />
          </button>
          <button type="button" aria-label={`More options for ${titleFor(device, index)}`} onClick={onSelect}>
            <DotsThree size={17} weight="bold" />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`wall-screen ${canInteract ? "interactive" : ""} ${pressed ? "pressed" : ""} ${interactionMode === "live_mouse" ? "live-mouse" : "standard-mode"}`}
        style={{ aspectRatio: `${frameWidth} / ${frameHeight}` }}
        onPointerDown={pointerDown}
        onPointerEnter={(event) => { trackMouse(event); }}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && pointerRef.current?.pointerId !== event.pointerId) hideMouseTarget();
        }}
        onPointerCancel={pointerCancel}
        onLostPointerCapture={pointerCancel}
        aria-label={canInteract
          ? `${interactionMode === "live_mouse" ? "Live mouse" : "Standard"} physical phone control surface`
          : interactionMode === "live_mouse"
            ? device.capabilities.actions.touch_down?.reason ?? actionError(device, controlEnabled)
            : actionError(device, controlEnabled)}
      >
        {device.demo ? (
          // The static demo is already cropped to the physical phone viewport.
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/demo-phonefarm-screen.png" alt="Demo physical phone screen" draggable={false} />
        ) : endpoint && device.connected ? (
          <LiveScreen
            controlPlaneUrl={liveControlPlaneBaseUrl(endpoint)}
            accessToken={endpoint.accessToken}
            deviceId={device.id}
            raw
            onFrame={setFrame}
            onConnection={(connected, detail) => {
              setStreamConnected(connected);
              setStreamDetail(detail ?? "");
              if (!connected) releaseLiveTouch("video stream disconnected");
            }}
          />
        ) : (
          <div className="screen-empty">
            <DeviceMobile size={34} weight="thin" />
            <strong>{device.connected ? "Waiting for camera" : "Device offline"}</strong>
            <span>{device.state?.cameraDetail ?? "Connect camera and controller USB"}</span>
          </div>
        )}
        {!device.demo && device.connected && !streamConnected ? (
          <div className="screen-stream-state"><span />{streamDetail || "Connecting video"}</div>
        ) : null}
        <div
          ref={mouseTargetRef}
          className={`wall-mouse-target ${canInteract ? "ready" : "locked"} ${pressed ? "pressed" : ""}`}
          aria-hidden="true"
        >
          <span />
        </div>
        {!controlEnabled && device.connected ? (
          <div className="inspect-badge">View only</div>
        ) : null}
        {controlEnabled && !device.capabilities.actions.tap.available ? (
          <div className="locked-badge"><ShieldCheck size={13} /> Safety locked</div>
        ) : null}
        {interactionMode === "live_mouse" && pressed ? (
          <div className="live-contact-badge"><span /> Mouse contact</div>
        ) : null}
      </div>

      <div className="wall-touch-controls">
        <div className="system-navigation-controls" aria-label={`System navigation for ${titleFor(device, index)}`}>
          <button
            type="button"
            className="system-navigation-button"
            onClick={() => sendPhoneNavigation("back")}
            disabled={!canUsePhoneNavigation("back") || pressed}
            title={device.state?.touchMapping?.systemNavigation?.back?.reason ?? device.capabilities.actions.phone_key?.reason ?? "Calibrated system Back gesture"}
          >
            <ArrowLeft size={14} /> Back
          </button>
          <button
            type="button"
            className="system-navigation-button"
            onClick={() => sendPhoneNavigation("home")}
            disabled={pressed || (!canUsePhoneNavigation("home") && !homePlacement)}
            title={homePlacement
              ? `Open Vision setup: move the phone toward screen top by at least ${homePlacement.minimumMm.toFixed(1)} mm`
              : device.state?.touchMapping?.systemNavigation?.home?.reason ??
                device.capabilities.actions.phone_key?.reason ??
                "Calibrated physical or gesture Home"}
          >
            <House size={14} /> Home
          </button>
        </div>
        <div className="interaction-mode-selector" aria-label={`Interaction mode for ${titleFor(device, index)}`}>
          <button
            type="button"
            className={interactionMode === "standard" ? "active" : ""}
            aria-pressed={interactionMode === "standard"}
            title="Click to tap; a short drag infers and sends a complete directional swipe"
            onClick={() => chooseInteractionMode("standard")}
          >
            Intent gestures
          </button>
          <button
            type="button"
            className={interactionMode === "live_mouse" ? "active" : ""}
            aria-pressed={interactionMode === "live_mouse"}
            disabled={!supportsLiveTouch}
            title={supportsLiveTouch
              ? "Mouse down presses; mouse up releases"
              : device.capabilities.actions.touch_down?.reason ??
                "Update the local hardware service to enable live mouse control"}
            onClick={() => chooseInteractionMode("live_mouse")}
          >
            Live mouse
          </button>
        </div>
        <div className="pressure-selector" aria-label={`Touch pressure for ${titleFor(device, index)}`}>
          {PRESSURE_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={pressurePreset === preset.id ? "active" : ""}
              onClick={() => setPressurePreset(preset.id)}
              title={selectedTouchZ === null ? preset.label : `${preset.label} touch pressure`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {homePlacement ? (
        <div className="system-navigation-warning">
          <WarningCircle size={13} />
          Move phone toward screen top ≥ {homePlacement.minimumMm.toFixed(1)} mm, then run Vision setup to enable Home.
        </div>
      ) : null}

      <button type="button" className="wall-device-meta" onClick={onSelect}>
        <span className={`device-radio ${selected ? "selected" : ""}`}>{selected ? <CheckCircle size={18} weight="fill" /> : null}</span>
        <span className="device-meta-copy">
          <strong>{titleFor(device, index)}</strong>
          <small>Physical phone · {shortId(device)}</small>
        </span>
        <span className={`device-state-pill ${status.toLowerCase().replace(" ", "-")}`}>{status}</span>
      </button>
    </article>
  );
}

function PlacementModal({
  device,
  index,
  endpoint,
  onClose,
}: {
  device: ScreenHandDevice;
  index: number;
  endpoint: ControlPlaneEndpoint;
  onClose: () => void;
}) {
  const router = useRouter();
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamDetail, setStreamDetail] = useState("Connecting camera");
  const [checks, setChecks] = useState([false, false, false]);
  const ready = streamConnected && checks.every(Boolean);
  const guideState = ready ? "ready" : checks[0] ? "close" : "adjust";
  const checklist = [
    { title: "Whole screen visible", detail: "The complete display and all four corners are in view." },
    { title: "Four corners inside guide", detail: "Keep the screen edges inside the target outline." },
    { title: "Reduce glare", detail: "Adjust the angle or lighting until icons and both edges stay visible." },
  ];

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="placement-layer" role="dialog" aria-modal="true" aria-labelledby="placement-title" data-testid="placement-dialog">
      <section className="placement-dialog">
        <header className="placement-header">
          <div>
            <strong id="placement-title">Position device</strong>
            <span>Align the phone under the camera before calibration.</span>
          </div>
          <div className={`placement-camera-state ${streamConnected ? "connected" : ""}`}>
            <span />
            {streamConnected ? "Camera connected" : streamDetail}
          </div>
          <button type="button" className="placement-close" onClick={onClose} aria-label="Close position device"><X size={18} /></button>
        </header>

        <div className="placement-body">
          <div className="placement-viewer">
            <div
              className="placement-feed"
              style={{ aspectRatio: `${frame?.width ?? 720} / ${frame?.height ?? 1280}` }}
            >
              <LiveScreen
                controlPlaneUrl={liveControlPlaneBaseUrl(endpoint)}
                accessToken={endpoint.accessToken}
                deviceId={device.id}
                raw
                onFrame={setFrame}
                onConnection={(connected, detail) => {
                  setStreamConnected(connected);
                  setStreamDetail(detail || (connected ? "Camera connected" : "Connecting camera"));
                }}
              />
              <div className={`placement-guide ${guideState}`} aria-hidden="true">
                <span className="guide-corner top-left" />
                <span className="guide-corner top-right" />
                <span className="guide-corner bottom-right" />
                <span className="guide-corner bottom-left" />
                <span className="guide-top"><CaretUp size={16} weight="fill" /> TOP</span>
              </div>
            </div>
            <div className="placement-nudge left"><CaretLeft size={24} weight="bold" /><span>Move left</span></div>
            <div className="placement-nudge right"><CaretRight size={24} weight="bold" /><span>Move right</span></div>
            <div className="placement-nudge down"><CaretDown size={24} weight="bold" /><span>Move down</span></div>
          </div>

          <aside className="placement-checklist">
            <div className="placement-checklist-title">
              <strong>Follow the steps to get a clear view</strong>
              <span>{titleFor(device, index)} · {frame ? `${frame.width}×${frame.height}` : "Waiting for frame"}</span>
            </div>
            <div className="placement-checks">
              {checklist.map((item, itemIndex) => (
                <button
                  type="button"
                  key={item.title}
                  className={checks[itemIndex] ? "checked" : ""}
                  aria-pressed={checks[itemIndex]}
                  onClick={() => setChecks((current) => current.map((value, indexValue) => indexValue === itemIndex ? !value : value))}
                >
                  <span className="placement-check-number">
                    {checks[itemIndex] ? <CheckCircle size={24} weight="fill" /> : itemIndex + 1}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                    <em>{checks[itemIndex] ? "Confirmed" : "Tap to confirm"}</em>
                  </span>
                </button>
              ))}
            </div>

            <div className="placement-tip">
              <Camera size={19} />
              <p><strong>Phone does not fit?</strong><span>Loosen the screw behind the camera, move it up or down, then tighten it again.</span></p>
            </div>

            <div className="placement-actions">
              <button type="button" className="placement-secondary" onClick={onClose}>Close</button>
              <button
                type="button"
                className="placement-primary"
                disabled={!ready}
                onClick={() => router.push(`/calibrate?deviceId=${encodeURIComponent(device.id)}`)}
              >
                <Crosshair size={17} /> Continue to calibration
              </button>
              {!ready ? <small>Confirm all three checks to continue.</small> : <small className="ready-copy">Ready for four-corner calibration.</small>}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

type WorkspaceView = "devices" | "connections" | "developer";

const ACTION_CAPABILITIES: Array<{
  key: keyof DeviceCapabilities["actions"];
  label: string;
  detail: string;
}> = [
  { key: "status", label: "Status", detail: "Read controller and motion state" },
  { key: "hold", label: "Hold", detail: "Immediately pause physical motion" },
  { key: "resume", label: "Resume", detail: "Release a safe controller hold" },
  { key: "home", label: "Home", detail: "Run an explicitly confirmed homing cycle" },
  { key: "hover_move", label: "Hover move", detail: "Move above a screen point without touching" },
  { key: "touch_down", label: "Live touch down", detail: "Lower the stylus for a mouse-held contact" },
  { key: "touch_move", label: "Live touch move", detail: "Follow the mouse while the stylus remains down" },
  { key: "touch_up", label: "Live touch up", detail: "Raise the stylus without waiting for gesture inference" },
  { key: "touch_keepalive", label: "Live touch keepalive", detail: "Keep an active contact alive under the driver watchdog" },
  { key: "tap", label: "Tap", detail: "Touch a point from an exact camera frame" },
  { key: "long_press", label: "Long press", detail: "Press a point with calibrated duration and depth" },
  { key: "swipe", label: "Swipe", detail: "Move between two calibrated screen points" },
  { key: "input_text", label: "Input text", detail: "Type through a verified physical keyboard profile" },
  { key: "phone_key", label: "Phone key", detail: "Send calibrated Back, Enter, or physical/gesture Home" },
  { key: "wait", label: "Wait", detail: "Pause a deterministic workflow step" },
];

function CopyCodeButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" className="copy-code-button" onClick={() => void copy()}>
      {copied ? <CheckCircle size={14} weight="fill" /> : <Code size={14} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeSample({ title, value }: { title: string; value: string }) {
  return (
    <section className="developer-code-card">
      <div><strong>{title}</strong><CopyCodeButton value={value} /></div>
      <pre>{value}</pre>
    </section>
  );
}

async function autoSetupRequest<T>(
  deviceId: string,
  operation: "preview" | "reference" | "run",
  body: Record<string, unknown> = {},
) {
  const response = await fetch(
    `/auto-setup-api/v1/devices/${encodeURIComponent(deviceId)}/${operation}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Auto setup failed (${response.status})`);
  }
  return payload;
}

function AutoSetupModal({
  device,
  index,
  onClose,
  onComplete,
}: {
  device: ScreenHandDevice;
  index: number;
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const [preview, setPreview] = useState<AutoSetupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setPreview(await autoSetupRequest<AutoSetupPreview>(device.id, "preview"));
    } catch (value) {
      setError(value instanceof Error ? value.message : "Vision preflight failed");
    } finally {
      setBusy(false);
    }
  }, [device.id]);

  useEffect(() => {
    let cancelled = false;
    void autoSetupRequest<AutoSetupPreview>(device.id, "preview")
      .then((value) => {
        if (!cancelled) setPreview(value);
      })
      .catch((value: unknown) => {
        if (!cancelled) {
          setError(value instanceof Error ? value.message : "Vision preflight failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [device.id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const saveReference = async () => {
    if (!preview) return;
    const adoptVisionProposal = preview.proposedImagePoints !== null;
    const confirmed = window.confirm(
      "Save this camera frame as the trusted visual reference?\n\n" +
      "Only continue when all four overlay corners match the physical screen exactly. " +
      "This confirms the visible outline, not physical touch accuracy or contact depth. " +
      (adoptVisionProposal
        ? "The detected outline will replace the old camera corners without moving the arm."
        : "If they do not match, use manual calibration once instead."),
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await autoSetupRequest(device.id, "reference", {
        frameSequence: preview.frame.sequence,
        adoptVisionProposal,
        confirmation: adoptVisionProposal
          ? "VISION_PROPOSAL_MATCHES_PHYSICAL_SCREEN"
          : "CURRENT_PLACEMENT_MATCHES_ACTIVE_CALIBRATION",
      });
      onComplete("Visual reference saved; future reconnects can restore the screen automatically");
      setPreview(await autoSetupRequest<AutoSetupPreview>(device.id, "preview"));
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to save visual reference");
    } finally {
      setBusy(false);
    }
  };

  const runAutoSetup = async () => {
    if (
      !preview ||
      (preview.status !== "ready" && preview.status !== "automatic_baseline_ready")
    ) return;
    const confirmed = window.confirm(
      `Auto setup ${titleFor(device, index)}?\n\n` +
      "The camera verified the phone placement. The arm may now run its Home cycle. " +
      "The phone camera cannot see the entire travel path: keep hands, cables, and loose objects clear, then click OK.",
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      const result = await autoSetupRequest<{
        status: string;
        moved: boolean;
        profileUpdated: boolean;
      }>(device.id, "run", {
        confirmation: "CLEAR_WORKSPACE_AND_AUTO_SETUP",
      });
      onComplete(
        result.moved
          ? "Home completed and the visual screen map was activated"
          : "The visual screen map was activated; Home was already complete",
      );
      onClose();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Automatic setup failed");
    } finally {
      setBusy(false);
    }
  };

  const points = preview?.proposedImagePoints ?? preview?.activeImagePoints ?? null;
  const polygon = points?.map((point) => `${point.x},${point.y}`).join(" ") ?? "";
  const frameUrl = preview
    ? `/api/frame?raw=1&deviceId=${encodeURIComponent(device.id)}&sequence=${preview.frame.sequence}`
    : "";
  const statusLabel = preview?.status === "ready"
    ? "Vision ready"
    : preview?.status === "automatic_baseline_ready"
      ? "Automatic reference ready"
      : preview?.status === "unknown_phone_detected"
        ? "New phone — touch setup required"
        : preview?.status === "baseline_required"
          ? "One-time reference"
          : preview?.status === "manual_review"
            ? "Review required"
            : "Analyzing";
  const overlayLabel = preview?.status === "ready"
    ? "Registered corners"
    : preview?.status === "automatic_baseline_ready"
      ? "Three-frame verified corners"
      : preview?.status === "unknown_phone_detected"
        ? "XY mapped — touch locked"
        : preview?.status === "manual_review"
          ? "Untrusted active corners"
          : preview?.proposedImagePoints
            ? "Proposed corners — verify once"
            : "Saved corners — verify once";
  const visionConfidence = preview?.registration?.confidence ??
    preview?.automaticBaseline?.confidence ??
    preview?.unknownPhoneCandidate?.confidence;
  const visionLatency = preview?.registration?.elapsedMs ??
    preview?.automaticBaseline?.elapsedMs ??
    preview?.unknownPhoneCandidate?.elapsedMs;
  const driftLabel = preview?.registration
    ? `${preview.registration.meanDriftPx.toFixed(1)} px`
    : preview?.automaticBaseline
      ? `${preview.automaticBaseline.meanDeviationPx.toFixed(1)} px across ` +
        `${preview.automaticBaseline.frameCount} frames`
      : preview?.unknownPhoneCandidate
        ? `${preview.unknownPhoneCandidate.meanDeviationPx.toFixed(1)} px across 3 frames`
        : "—";
  const physicalHomeEvidence = preview?.unknownPhoneCandidate
    ?.physicalHomeButtonEvidence;
  const onScreenNavigationEvidence = preview?.unknownPhoneCandidate
    ?.onScreenNavigationEvidence;
  const navigationLabel = preview?.unknownPhoneCandidate?.blockers.includes(
    "navigation_evidence_conflict",
  )
    ? "Conflicting evidence — locked"
    : onScreenNavigationEvidence?.observation.status === "detected"
      ? onScreenNavigationEvidence.observation.strategy === "gesture_handle"
        ? "Gesture navigation found — touch locked"
        : onScreenNavigationEvidence.withinMovementBounds
          ? "On-screen Home found — touch locked"
          : "On-screen Home found — out of range"
      : physicalHomeEvidence?.observation.status === "detected"
        ? physicalHomeEvidence.withinMovementBounds
          ? "Physical Home found — touch locked"
          : "Physical Home found — out of range"
        : preview?.unknownPhoneCandidate?.navigationAssessment ===
          "edge_gesture_candidate"
          ? "Edge gesture candidate"
          : preview?.unknownPhoneCandidate?.navigationAssessment ===
              "physical_home_button_candidate"
            ? "Physical Home evidence needed"
            : "Not verified";

  return (
    <div className="placement-layer" role="dialog" aria-modal="true" aria-labelledby="auto-setup-title">
      <section className="placement-dialog auto-setup-dialog">
        <header className="placement-header">
          <div>
            <strong id="auto-setup-title">Vision auto setup</strong>
            <span>{titleFor(device, index)} · camera-only placement recovery</span>
          </div>
          <div className={`auto-setup-state ${preview?.status ?? "loading"}`}>
            <span /> {busy ? "Analyzing camera" : statusLabel}
          </div>
          <button type="button" className="placement-close" disabled={busy} onClick={onClose} aria-label="Close auto setup"><X size={18} /></button>
        </header>

        <div className="auto-setup-body">
          <div className="auto-setup-viewer">
            {preview && frameUrl ? (
              <div
                className={`auto-setup-frame ${preview.status}`}
                style={{ aspectRatio: `${preview.frame.width} / ${preview.frame.height}` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frameUrl} alt="Exact physical camera frame used for visual setup" />
                {points ? (
                  <svg viewBox={`0 0 ${preview.frame.width} ${preview.frame.height}`} aria-label="Detected phone screen corners">
                    <polygon points={polygon} />
                    {points.map((point, pointIndex) => (
                      <g key={`${point.x}-${point.y}`}>
                        <circle cx={point.x} cy={point.y} r="8" />
                        <text x={point.x + 14} y={point.y + 8}>{pointIndex + 1}</text>
                      </g>
                    ))}
                  </svg>
                ) : null}
                {points ? <span className="auto-setup-overlay-label">{overlayLabel}</span> : null}
              </div>
            ) : <div className="auto-setup-loading">Reading the latest physical camera frame…</div>}
          </div>

          <aside className="auto-setup-summary">
            <div>
              <strong>{statusLabel}</strong>
              <p>{error || preview?.reason || "Waiting for the vision preflight."}</p>
              {preview?.referenceReuse ? <p role="status"><strong>{preview.referenceReuse.status === "incompatible" ? "Previous reference needs review" : preview.referenceReuse.source === "previous_version" ? "Previous reference found" : "Visual reference"}</strong><br />{preview.referenceReuse.reason}</p> : null}
            </div>

            <dl>
              <div><dt>Camera frame</dt><dd>{preview ? `${preview.frame.width}×${preview.frame.height}` : "—"}</dd></div>
              <div><dt>Home state</dt><dd>{preview?.status === "unknown_phone_detected" ? "Locked" : preview?.homed ? "Complete" : "Required"}</dd></div>
              <div><dt>Confidence</dt><dd>{visionConfidence === undefined ? "—" : `${Math.round(visionConfidence * 100)}%`}</dd></div>
              <div><dt>{preview?.automaticBaseline ? "Frame stability" : "Mean drift"}</dt><dd>{driftLabel}</dd></div>
              <div><dt>Vision latency</dt><dd>{visionLatency === undefined ? "—" : `${visionLatency.toFixed(1)} ms`}</dd></div>
              {preview?.unknownPhoneCandidate ? (
                <>
                  <div><dt>Station XY</dt><dd>Shadow ready</dd></div>
                  <div><dt>Touch depth</dt><dd>Locked</dd></div>
                  <div><dt>Contact observer</dt><dd>Camera Z required</dd></div>
                  <div><dt>Navigation</dt><dd>{navigationLabel}</dd></div>
                </>
              ) : null}
            </dl>

            <div className="auto-setup-note">
              <ShieldCheck size={19} />
              <p><strong>Fail-closed startup</strong><span>{preview?.status === "unknown_phone_detected"
                ? "The station understands this screen only in read-only XY Shadow mode. Touch, Home, and profile activation stay blocked until contact depth and navigation are verified."
                : "Low confidence, excessive movement, changed camera resolution, or out-of-range coordinates stop before Home."}</span></p>
            </div>

            <div className="auto-setup-actions">
              <button type="button" className="placement-secondary" disabled={busy} onClick={() => void refresh()}>Retry vision</button>
              {preview?.status === "baseline_required" || preview?.status === "manual_review" ? (
                <button type="button" className="placement-primary" disabled={busy} onClick={() => void saveReference()}>
                  {preview.proposedImagePoints
                    ? "Use detected corners & save"
                    : "Save verified reference"}
                </button>
              ) : null}
              {preview?.status === "ready" || preview?.status === "automatic_baseline_ready" ? (
                <button type="button" className="placement-primary" disabled={busy} onClick={() => void runAutoSetup()}>
                  {preview.status === "automatic_baseline_ready" ? "Home & activate automatically" : "Home & restore"}
                </button>
              ) : null}
              {preview?.status === "manual_review" || preview?.status === "baseline_required" || preview?.status === "unknown_phone_detected" ? (
                <Link className="auto-setup-manual" href={`/calibrate?deviceId=${encodeURIComponent(device.id)}`}>Open manual calibration</Link>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function ConnectionsWorkspace({
  devices,
  endpoint,
  endpointError,
  onOpenDevice,
  onCalibrate,
  onAutoSetup,
}: {
  devices: ScreenHandDevice[];
  endpoint: ControlPlaneEndpoint | null;
  endpointError: string;
  onOpenDevice: (deviceId: string) => void;
  onCalibrate: (device: ScreenHandDevice) => void;
  onAutoSetup: (device: ScreenHandDevice) => void;
}) {
  const installCommand = "curl -fsSL --proto '=https' --tlsv1.2 https://screenhand-remote-console.alhazaranwar205.chatgpt.site/install.sh | bash";
  return (
    <div className="platform-view connections-view">
      <section className="platform-hero">
        <div>
          <span className="platform-eyebrow"><PlugsConnected size={15} /> Local-first runtime</span>
          <h1>Connect hardware once. Keep every workflow on your network.</h1>
          <p>ScreenHand runs beside the robot arm, so camera frames, device state, and control commands stay on the customer&apos;s own machine.</p>
        </div>
        <div className={`runtime-card ${endpointError ? "offline" : ""}`}>
          <span className="system-dot" />
          <div><strong>{endpointError ? "Local service offline" : "Local service healthy"}</strong><small>{endpoint?.baseUrl ?? "http://127.0.0.1:3013"}</small></div>
        </div>
      </section>

      <section className="setup-grid">
        {[
          ["01", "Run guided setup", "Check the Mac, install dependencies, and start the local platform with one documented flow.", installCommand],
          ["02", "Bind USB hardware", "Assign a stable device ID to one controller topology and one camera identity.", "config/device-fleet.json"],
          ["03", "Home and calibrate", "Clear the workspace, home the machine, then verify camera corners and touch depth.", "/calibrate"],
          ["04", "Verify your integration", "Run health checks, inspect OpenAPI, and send idempotent test actions.", "screenhand doctor"],
        ].map(([number, title, detail, command]) => (
          <article className="setup-step" key={number}>
            <span>{number}</span>
            <div><strong>{title}</strong><p>{detail}</p><code>{command}</code></div>
          </article>
        ))}
      </section>

      <section className="connection-section">
        <div className="platform-section-heading">
          <div><strong>Connected hardware</strong><span>Every safety dependency is visible before control is enabled.</span></div>
          <span>{devices.length} device{devices.length === 1 ? "" : "s"}</span>
        </div>
        {devices.length ? (
          <div className="connection-table">
            <div className="connection-row connection-head">
              <span>Device</span><span>Camera</span><span>Controller</span><span>Homing</span><span>Touch gate</span><span />
            </div>
            {devices.map((device, index) => (
              <div className="connection-row" key={device.id}>
                <div className="connection-device"><DeviceMobile size={19} /><span><strong>{titleFor(device, index)}</strong><small>{device.id}</small></span></div>
                <span className={device.state?.cameraReady ? "good" : "bad"}>{device.state?.cameraReady ? "Live" : "Missing"}</span>
                <span className={device.state?.grbl?.connected ? "good" : "bad"}>{device.state?.grbl?.connected ? "Connected" : "Offline"}</span>
                <span className={device.state?.grbl?.homed ? "good" : "warn"}>{device.state?.grbl?.homed ? "Complete" : "Required"}</span>
                <span className={device.capabilities.actions.tap.available ? "good" : "warn"}>{device.capabilities.actions.tap.available ? "Ready" : "Locked"}</span>
                <div className="connection-actions">
                  <button type="button" onClick={() => onOpenDevice(device.id)}>Open</button>
                  <button type="button" disabled={device.demo || !device.connected} onClick={() => onAutoSetup(device)}>Auto setup</button>
                  <button type="button" disabled={!device.state?.grbl?.homed} onClick={() => onCalibrate(device)}>Calibrate</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="platform-empty"><PlugsConnected size={34} weight="thin" /><strong>No hardware registered</strong><p>Connect a supported controller and UVC camera, then start the local fleet runtime.</p></div>
        )}
      </section>

      <section className="local-surfaces">
        <article><SquaresFour size={20} /><strong>Dashboard</strong><span>Human operation and live video</span><code>127.0.0.1:3012</code></article>
        <article><Code size={20} /><strong>Control API</strong><span>REST, receipts, and WebSocket frames</span><code>127.0.0.1:3013</code></article>
        <article><CirclesFour size={20} /><strong>MCP server</strong><span>Typed tools for compatible developer platforms</span><code>screenhand mcp</code></article>
      </section>
    </div>
  );
}

function DeveloperWorkspace({
  devices,
  selectedDevice,
  endpoint,
  onSelectDevice,
}: {
  devices: ScreenHandDevice[];
  selectedDevice: ScreenHandDevice | null;
  endpoint: ControlPlaneEndpoint | null;
  onSelectDevice: (deviceId: string) => void;
}) {
  const baseUrl = endpoint?.baseUrl ?? "http://127.0.0.1:3013";
  const deviceId = selectedDevice?.id ?? "black-arm-01";
  const listExample = `curl ${baseUrl}/api/v1/devices`;
  const tapExample = `curl -X POST ${baseUrl}/api/v1/devices/${deviceId}/actions \\\n+  -H 'Content-Type: application/json' \\\n+  -d '{\n    "idempotencyKey": "my-workflow-step-1",\n    "action": {\n      "type": "tap",\n      "point": { "x": 360, "y": 780 },\n      "viewport": { "width": 720, "height": 1560 },\n      "frameSequence": 123\n    }\n  }'`;
  const mcpConfig = `{
  "mcpServers": {
    "screenhand": {
      "command": "screenhand",
      "args": ["mcp"],
      "env": {
        "SCREENHAND_API_URL": "${baseUrl}"
      }
    }
  }
}`;

  return (
    <div className="platform-view developer-view">
      <section className="developer-hero">
        <div>
          <span className="platform-eyebrow"><Code size={15} /> Developer platform</span>
          <h1>Every physical capability, exposed as a stable contract.</h1>
          <p>Build test automation, device labs, QA products, and internal workflows without writing serial commands or bypassing hardware safety.</p>
        </div>
        <div className="developer-hero-actions">
          <div><span>Local API base</span><code>{baseUrl}</code></div>
          <Link href="/docs" target="_blank"><BookOpenText size={15} /> Developer docs</Link>
          <Link href="/agent-guide.txt" target="_blank"><CirclesFour size={15} /> Agent handoff</Link>
          <button type="button" disabled={!endpoint} onClick={() => endpoint && window.open(new URL("/api/v1/openapi.json", endpoint.baseUrl), "_blank", "noopener,noreferrer")}><Code size={15} /> OpenAPI 3.1</button>
        </div>
      </section>

      <section className="developer-metrics">
        <article><strong>11</strong><span>action primitives</span></article>
        <article><strong>2</strong><span>observation channels</span></article>
        <article><strong>REST + WS</strong><span>transport contracts</span></article>
        <article><strong>MCP</strong><span>stdio tool server</span></article>
      </section>

      <section className="capability-section">
        <div className="platform-section-heading">
          <div><strong>Capability matrix</strong><span>The live device response is the source of truth. Unavailable actions always include a reason.</span></div>
          {devices.length ? (
            <select value={selectedDevice?.id ?? ""} onChange={(event) => onSelectDevice(event.target.value)} aria-label="Capability device">
              {devices.map((device) => <option value={device.id} key={device.id}>{device.id}</option>)}
            </select>
          ) : <span>No device connected</span>}
        </div>
        <div className="capability-grid">
          <article className="capability-card">
            <div><Camera size={18} /><strong>Observation</strong></div>
            <ul>
              <li><span>Screenshot</span><b className={selectedDevice?.capabilities.observation.screenshot.available ? "available" : "unavailable"}>{selectedDevice?.capabilities.observation.screenshot.available ? "Available" : "Unavailable"}</b></li>
              <li><span>Live frames</span><b className={selectedDevice?.capabilities.observation.liveFrames.available ? "available" : "unavailable"}>{selectedDevice?.capabilities.observation.liveFrames.available ? "Available" : "Unavailable"}</b></li>
            </ul>
          </article>
          {ACTION_CAPABILITIES.map(({ key, label, detail }) => {
            const availability = selectedDevice?.capabilities.actions[key];
            return (
              <article className="capability-card" key={key}>
                <div><HandTap size={18} /><strong>{label}</strong><b className={availability?.available ? "available" : "unavailable"}>{availability?.available ? "Available" : "Locked"}</b></div>
                <p>{detail}</p>
                {!availability?.available && availability?.reason ? <small>{availability.reason}</small> : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="api-contract-section">
        <div className="platform-section-heading"><div><strong>Infrastructure API</strong><span>Small primitives compose into reliable enterprise workflows.</span></div><span>Protocol 2026-07-29</span></div>
        <div className="endpoint-list">
          {[
            ["GET", "/api/v1/devices", "Fleet and capability state"],
            ["GET", "/api/v1/devices/:deviceId", "One device and its safety gates"],
            ["GET", "/api/v1/devices/:deviceId/screenshot", "Latest or exact camera frame"],
            ["WS", "/api/live/socket?deviceId=…", "Low-latency image stream"],
            ["POST", "/api/v1/devices/:deviceId/actions", "Submit an idempotent primitive"],
            ["GET", "/api/v1/devices/:deviceId/actions/:receiptId", "Wait for physical completion"],
          ].map(([method, path, detail]) => <div key={`${method}-${path}`}><b className={method.toLowerCase()}>{method}</b><code>{path}</code><span>{detail}</span></div>)}
        </div>
      </section>

      <section className="developer-samples">
        <CodeSample title="List devices" value={listExample} />
        <CodeSample title="Send a calibrated tap" value={tapExample} />
        <CodeSample title="Connect through MCP" value={mcpConfig} />
      </section>

      <section className="developer-safety-note">
        <ShieldCheck size={22} weight="fill" />
        <div><strong>Safety remains below every integration.</strong><span>API and MCP clients cannot bypass frame freshness, device identity, homing, calibration, reachability, touch-depth limits, or the local hardware Hold.</span></div>
      </section>
    </div>
  );
}

export function DashboardContent() {
  const [activeView, setActiveView] = useState<WorkspaceView>("devices");
  const [endpoint, setEndpoint] = useState<ControlPlaneEndpoint | null>(null);
  const [endpointError, setEndpointError] = useState("");
  const [devices, setDevices] = useState<ScreenHandDevice[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [controlEnabled, setControlEnabled] = useState(false);
  const [layout, setLayout] = useState<"grid" | "compact">("grid");
  const [toast, setToast] = useState("");
  const [fullscreenDevice, setFullscreenDevice] = useState<ScreenHandDevice | null>(null);
  const [placementDevice, setPlacementDevice] = useState<ScreenHandDevice | null>(null);
  const [autoSetupDevice, setAutoSetupDevice] = useState<ScreenHandDevice | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const resolved = resolveControlPlaneEndpoint();
      setEndpoint(resolved.endpoint);
      setEndpointError(resolved.error);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const demo = new URLSearchParams(window.location.search).get("demo") === "1";
      if (demo) {
        const next = demoDevices();
        if (!cancelled) {
          setDevices(next);
          setSelectedId((current) => current || next[0].id);
        }
        return;
      }
      if (!endpoint) {
        if (!cancelled) setDevices([]);
        return;
      }
      try {
        const response = await controlPlaneFetch(endpoint, "/api/v1/devices", { cache: "no-store" });
        if (!response.ok) throw new Error(`Control plane returned ${response.status}`);
        const payload = await response.json() as DevicesResponse;
        if (!cancelled) {
          setDevices(payload.devices);
          setEndpointError("");
          setSelectedId((current) => payload.devices.some((device) => device.id === current)
            ? current
            : payload.devices[0]?.id ?? "");
        }
      } catch (error) {
        if (!cancelled) setEndpointError(error instanceof Error ? error.message : "Control plane unavailable");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [endpoint]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredDevices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((device, index) => `${device.id} ${titleFor(device, index)}`.toLowerCase().includes(needle));
  }, [devices, query]);

  const onlineCount = devices.filter((device) => device.connected).length;
  const readyCount = devices.filter((device) => device.capabilities.actions.tap.available).length;
  const selectedDevice = devices.find((device) => device.id === selectedId) ?? null;
  const controlActive = controlEnabled && readyCount > 0;

  useEffect(() => {
    if (placementDevice) return;
    const target = devices.find((device) =>
      !device.demo &&
      device.connected &&
      device.state?.grbl?.homed &&
      !device.capabilities.actions.tap.available
    );
    if (!target) return;
    const key = `screenhand-placement-shown:${target.id}`;
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
    const timer = window.setTimeout(() => {
      setPlacementDevice(target);
      setSelectedId(target.id);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [devices, placementDevice]);

  const sendAction = useCallback(async (device: ScreenHandDevice, action: ActionPayload) => {
    if (device.demo) {
      setToast(`${action.type.replace("_", " ")} sent to ${device.id}`);
      return true;
    }
    if (!endpoint) {
      setToast("The local ScreenHand service is not connected");
      return false;
    }
    try {
      const response = await controlPlaneFetch(endpoint, `/api/v1/devices/${encodeURIComponent(device.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `dashboard-${device.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          action,
        }),
      });
      const payload = await response.json() as { error?: string; receipt?: { id?: string } };
      if (!response.ok) throw new Error(payload.error || `Action failed (${response.status})`);
      setToast(`${action.type.replace("_", " ")} accepted by ${titleFor(device, devices.indexOf(device))}`);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Action failed");
      return false;
    }
  }, [devices, endpoint]);

  const sendHover = useCallback(async (device: ScreenHandDevice, action: ActionPayload) => {
    if (device.demo || !endpoint || action.type !== "hover_move") return;
    try {
      const response = await controlPlaneFetch(endpoint, `/api/v1/devices/${encodeURIComponent(device.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `dashboard-hover-${device.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          action,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `Hover move failed (${response.status})`);
      }
    } catch (error) {
      console.warn("ScreenHand hover move rejected", error);
    }
  }, [endpoint]);

  const sendLiveTouch = useCallback(async (
    device: ScreenHandDevice,
    action: ActionPayload,
    options: { keepalive?: boolean } = {},
  ) => {
    if (device.demo) return true;
    if (!endpoint || ![
      "touch_down",
      "touch_move",
      "touch_up",
      "touch_keepalive",
    ].includes(action.type)) return false;
    try {
      const response = await controlPlaneFetch(
        endpoint,
        `/api/v1/devices/${encodeURIComponent(device.id)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `dashboard-live-${device.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            action,
          }),
          keepalive: options.keepalive === true,
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `Live touch failed (${response.status})`);
      }
      const payload = await response.json() as {
        receipt?: { id?: string; status?: string; error?: string };
        result?: {
          receipt?: { id?: string; status?: string; error?: string };
        };
      };
      if (action.type === "touch_down") {
        const receiptId = String(
          payload.result?.receipt?.id ?? payload.receipt?.id ?? "",
        );
        if (!receiptId) throw new Error("Live touch did not return an action receipt");
        const deadline = Date.now() + 6_500;
        while (Date.now() < deadline) {
          const receiptResponse = await controlPlaneFetch(
            endpoint,
            `/api/v1/devices/${encodeURIComponent(device.id)}/actions/${encodeURIComponent(receiptId)}`,
            { cache: "no-store" },
          );
          const receiptPayload = await receiptResponse.json() as {
            error?: string;
            receipt?: { status?: string; error?: string };
          };
          if (!receiptResponse.ok) {
            throw new Error(receiptPayload.error || "Unable to verify live contact");
          }
          if (receiptPayload.receipt?.status === "completed") return true;
          if (receiptPayload.receipt?.status === "failed") {
            throw new Error(
              receiptPayload.receipt.error || "The hardware driver rejected live contact",
            );
          }
          await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 40));
        }
        throw new Error("Timed out waiting for the stylus to make contact");
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : `${action.type} failed`;
      console.warn(`ScreenHand ${action.type} rejected`, error);
      setToast(message);
      return false;
    }
  }, [endpoint]);

  const holdAll = async () => {
    const online = devices.filter((device) => device.connected);
    if (!online.length) return;
    setBusy(true);
    await Promise.all(online.map((device) => sendAction(device, { type: "hold" })));
    setControlEnabled(false);
    setBusy(false);
    setToast(`Emergency hold sent to ${online.length} device${online.length === 1 ? "" : "s"}`);
  };

  const toggleControl = async () => {
    if (controlActive) {
      setControlEnabled(false);
      return;
    }
    if (readyCount > 0) {
      setControlEnabled(true);
      return;
    }

    const resumable = devices.find((device) =>
      device.connected && device.capabilities.actions.resume.available
    );
    if (resumable) {
      setBusy(true);
      try {
        const accepted = await sendAction(resumable, { type: "resume" });
        if (accepted) {
          setControlEnabled(true);
          setSelectedId(resumable.id);
          setToast(`Controller resumed for ${titleFor(resumable, devices.indexOf(resumable))}; control will enable when Idle is confirmed`);
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    const target = selectedDevice?.connected
      ? selectedDevice
      : devices.find((device) => device.connected) ?? null;
    if (!target) {
      setToast("Connect a ScreenHand camera and controller first");
      return;
    }

    setControlEnabled(false);
    setSelectedId(target.id);
    setDetailsOpen(true);
    setToast(`Control locked: ${actionError(target)}`);
    if (target.state?.grbl?.homed) setPlacementDevice(target);
  };

  const homeMachine = async (device: ScreenHandDevice) => {
    const confirmed = window.confirm(
      `Home ${titleFor(device, devices.indexOf(device))}?\n\n` +
      "The arm will move through its homing cycle. Keep hands, cables, and loose objects clear, then click OK.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await sendAction(device, {
        type: "home",
        confirmation: "CLEAR_WORKSPACE_AND_HOME",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="device-wall-shell">
      <aside className="wall-rail" aria-label="Primary navigation">
        <div className="wall-mark"><CirclesFour size={24} weight="fill" /></div>
        <nav>
          <button type="button" className={activeView === "devices" ? "active" : ""} aria-label="Devices" onClick={() => { setActiveView("devices"); setDetailsOpen(false); setQuery(""); }}><SquaresFour size={20} weight={activeView === "devices" ? "fill" : "regular"} /></button>
          <button type="button" className={activeView === "connections" ? "active" : ""} aria-label="Connections" onClick={() => { setActiveView("connections"); setDetailsOpen(false); }}><PlugsConnected size={20} weight={activeView === "connections" ? "fill" : "regular"} /></button>
          <button type="button" className={activeView === "developer" ? "active" : ""} aria-label="Developer" onClick={() => { setActiveView("developer"); setDetailsOpen(false); }}><Code size={20} weight={activeView === "developer" ? "fill" : "regular"} /></button>
        </nav>
        <button type="button" className={`rail-settings ${activeView === "connections" ? "active" : ""}`} aria-label="Local settings" onClick={() => { setActiveView("connections"); setDetailsOpen(false); }}><GearSix size={20} /></button>
      </aside>

      <section className="wall-workspace">
        {activeView === "devices" ? <>
        <header className="wall-header">
          <div className="wall-title">
            <strong>Devices</strong>
            <span>{onlineCount} online · {devices.length} connected</span>
          </div>
          <label className="wall-search">
            <MagnifyingGlass size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search devices" aria-label="Search devices" />
            <kbd>⌘ K</kbd>
          </label>
          <div className="wall-header-actions">
            <div className="layout-toggle" aria-label="Layout">
              <button type="button" className={layout === "grid" ? "active" : ""} onClick={() => setLayout("grid")} aria-label="Grid view"><SquaresFour size={16} /></button>
              <button type="button" className={layout === "compact" ? "active" : ""} onClick={() => setLayout("compact")} aria-label="Compact view"><ListBullets size={16} /></button>
            </div>
            <button type="button" className="filter-button" onClick={() => setDetailsOpen((value) => !value)}><SlidersHorizontal size={16} /> Details</button>
            <button type="button" className="hold-button" disabled={busy || onlineCount === 0} onClick={() => void holdAll()}><Pause size={16} weight="fill" /> Hold all</button>
            <button
              type="button"
              className={`control-toggle ${controlActive ? "enabled" : ""}`}
              disabled={busy || onlineCount === 0}
              onClick={() => void toggleControl()}
            >
              <HandTap size={17} weight={controlActive ? "fill" : "regular"} />
              {controlActive ? "Control enabled" : readyCount === 0 ? "Complete setup" : "Enable control"}
            </button>
          </div>
        </header>

        <div className="wall-statusbar">
          <div><span className={`system-dot ${endpointError ? "error" : ""}`} />{endpointError ? "Local service unavailable" : "Local system healthy"}</div>
          <div className="statusbar-center">
            <span><WifiHigh size={14} /> {onlineCount} live</span>
            <span><ShieldCheck size={14} /> {readyCount} ready for touch</span>
            {controlActive ? <span className="control-warning"><WarningCircle size={14} weight="fill" /> Physical control is live</span> : <span>View-only mode</span>}
          </div>
          <span>API 2026-07-29</span>
        </div>

        <section className="agent-command-bar" aria-label="Autonomous task console">
          <div className="agent-command-copy"><strong>任务控制台</strong><span>输入自然语言后直接执行；实时进度、停止任务、详细日志和问题记录。</span></div>
          <a href="/tasks" className="filter-button">进入任务入口 →</a>
        </section>
        <section className="agent-command-bar" aria-label="Local perception experiment">
          <div className="agent-command-copy"><strong>本地视觉实验</strong><span>OCR、页面状态、识别框与耗时。观察页不发送机械臂动作。</span></div>
          <a href="/perception" className="filter-button">打开识别面板 →</a>
          {process.env.NEXT_PUBLIC_SCREENHAND_LOCAL_PERCEPTION_ONLY === "1" ? <span>观察页不执行任务 · 请使用任务控制台</span> : null}
        </section>
        {GENERAL_AGENT_UI_ENABLED && process.env.NEXT_PUBLIC_SCREENHAND_LOCAL_PERCEPTION_ONLY !== "1" ? (
          <AgentCommandBar
            device={selectedDevice}
            controlEnabled={controlActive}
            onToast={setToast}
          />
        ) : null}

        {devices.length === 0 ? (
          <div className="wall-empty-state">
            {endpointError ? <WifiSlash size={40} weight="thin" /> : <PlugsConnected size={40} weight="thin" />}
            <strong>{endpointError ? "ScreenHand service is offline" : "Connect your first ScreenHand"}</strong>
            <p>{endpointError || "Plug in the camera USB and controller USB. The device will appear here automatically."}</p>
            <code>screenhand onboard</code>
          </div>
        ) : (
          <div className={`device-grid ${layout}`}>
            {filteredDevices.map((device) => (
              <DeviceTile
                key={device.id}
                device={device}
                index={devices.indexOf(device)}
                endpoint={endpoint}
                controlEnabled={controlActive}
                selected={selectedId === device.id}
                onSelect={() => setSelectedId(device.id)}
                onAction={sendAction}
                onHover={sendHover}
                onLiveTouch={sendLiveTouch}
                onFullscreen={setFullscreenDevice}
                onPosition={setPlacementDevice}
                onAutoSetup={setAutoSetupDevice}
              />
            ))}
          </div>
        )}</> : null}

        {activeView === "connections" ? (
          <ConnectionsWorkspace
            devices={devices}
            endpoint={endpoint}
            endpointError={endpointError}
            onOpenDevice={(deviceId) => {
              setSelectedId(deviceId);
              setActiveView("devices");
              setDetailsOpen(true);
            }}
            onCalibrate={(device) => setPlacementDevice(device)}
            onAutoSetup={(device) => setAutoSetupDevice(device)}
          />
        ) : null}

        {activeView === "developer" ? (
          <DeveloperWorkspace
            devices={devices}
            selectedDevice={selectedDevice}
            endpoint={endpoint}
            onSelectDevice={setSelectedId}
          />
        ) : null}
      </section>

      {detailsOpen ? (
        <aside className="device-inspector">
          <div className="inspector-header"><strong>Device details</strong><button type="button" onClick={() => setDetailsOpen(false)} aria-label="Close details"><X size={17} /></button></div>
          {selectedDevice ? (
            <>
              <div className="inspector-device"><DeviceMobile size={24} /><div><strong>{titleFor(selectedDevice, devices.indexOf(selectedDevice))}</strong><span>{selectedDevice.id}</span></div></div>
              <dl>
                <div><dt>Connection</dt><dd className={selectedDevice.connected ? "good" : "bad"}>{selectedDevice.connected ? "Online" : "Offline"}</dd></div>
                <div><dt>Video</dt><dd>{selectedDevice.state?.videoMode === "wired" ? "Wired" : "Physical camera"}</dd></div>
                <div><dt>Controller</dt><dd>{selectedDevice.state?.grbl?.connected ? "Connected" : "Disconnected"}</dd></div>
                <div><dt>Motion state</dt><dd>{selectedDevice.state?.grbl?.state ?? "Unknown"}</dd></div>
                <div><dt>Homing</dt><dd>{selectedDevice.state?.grbl?.homed ? "Complete" : "Required"}</dd></div>
                <div><dt>Touch gate</dt><dd>{selectedDevice.capabilities.actions.tap.available ? "Ready" : "Locked"}</dd></div>
              </dl>
              {!selectedDevice.capabilities.actions.tap.available ? <div className="inspector-notice"><ShieldCheck size={18} /><p><strong>Physical actions are blocked</strong><span>{actionError(selectedDevice)}</span></p></div> : null}
              {selectedDevice.capabilities.actions.home.available ? (
                <button type="button" className="inspector-position-button inspector-home-button" disabled={busy} onClick={() => void homeMachine(selectedDevice)}>
                  <Crosshair size={17} /> {busy ? "Starting homing…" : "Home machine"}
                </button>
              ) : null}
              {selectedDevice.capabilities.actions.resume.available ? (
                <button type="button" className="inspector-position-button" disabled={busy} onClick={() => void sendAction(selectedDevice, { type: "resume" })}>
                  <HandTap size={17} /> Resume from Hold
                </button>
              ) : null}
              <button type="button" className="inspector-position-button" disabled={busy || !selectedDevice.state?.grbl?.homed} onClick={() => setPlacementDevice(selectedDevice)}>
                <Crosshair size={17} /> Position and calibrate
              </button>
              <button type="button" className="inspector-position-button" disabled={busy || selectedDevice.demo || !selectedDevice.connected} onClick={() => setAutoSetupDevice(selectedDevice)}>
                <CirclesFour size={17} /> Vision auto setup
              </button>
              <div className="api-example"><div><Code size={15} /> Infrastructure API</div><pre>{`POST /api/v1/devices/${selectedDevice.id}/actions\n{ "action": { "type": "tap", ... } }`}</pre></div>
            </>
          ) : <p className="inspector-placeholder">Select a device to inspect its connection and safety state.</p>}
        </aside>
      ) : null}

      {fullscreenDevice ? (
        <div className="fullscreen-layer" role="dialog" aria-modal="true" aria-label={`${fullscreenDevice.id} fullscreen`}>
          <button type="button" className="fullscreen-close" onClick={() => setFullscreenDevice(null)} aria-label="Close fullscreen"><X size={20} /></button>
          <div
            className="fullscreen-phone"
            style={{
              aspectRatio: `${fullscreenDevice.screen?.rawWidth ?? fullscreenDevice.screen?.width ?? 720} / ${fullscreenDevice.screen?.rawHeight ?? fullscreenDevice.screen?.height ?? 1280}`,
            }}
          >
            {fullscreenDevice.demo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/demo-phonefarm-screen.png" alt="Demo physical phone screen" />
            ) : endpoint ? (
              <LiveScreen controlPlaneUrl={liveControlPlaneBaseUrl(endpoint)} accessToken={endpoint.accessToken} deviceId={fullscreenDevice.id} raw onFrame={() => {}} onConnection={() => {}} />
            ) : null}
          </div>
          <strong>{titleFor(fullscreenDevice, devices.indexOf(fullscreenDevice))}</strong>
          <span>Live physical camera</span>
        </div>
      ) : null}

      {placementDevice && endpoint ? (
        <PlacementModal
          device={placementDevice}
          index={devices.indexOf(placementDevice)}
          endpoint={endpoint}
          onClose={() => setPlacementDevice(null)}
        />
      ) : null}

      {autoSetupDevice ? (
        <AutoSetupModal
          device={autoSetupDevice}
          index={devices.indexOf(autoSetupDevice)}
          onClose={() => setAutoSetupDevice(null)}
          onComplete={setToast}
        />
      ) : null}

      {toast ? <div className="wall-toast"><CheckCircle size={17} weight="fill" />{toast}</div> : null}
    </main>
  );
}
