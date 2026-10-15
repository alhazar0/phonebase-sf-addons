import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { decode } from "jpeg-js";
import WebSocket from "ws";
import { loadScreenHandCalibrationProfile } from "../agent/calibration-profile";

const CONTROL_PLANE_URL = process.env.SCREENHAND_CONTROL_PLANE_URL ??
  "http://127.0.0.1:3013";
const DRIVER_URL = process.env.SCREENHAND_BLACK_DRIVER_URL ?? "http://127.0.0.1:3014";
const DEVICE_ID = process.env.SCREENHAND_BLACK_DEVICE_ID ?? "black-arm-01";
const CALIBRATION_PATH = process.env.SCREENHAND_CALIBRATION_PATH ?? "build/black-arm-calibration.json";
const PROFILE_ID = process.env.SCREENHAND_BLACK_PROFILE_ID ?? (
  loadScreenHandCalibrationProfile(CALIBRATION_PATH)?.id ?? "unconfigured"
);
const CAMERA_NAME = process.env.SCREENHAND_BLACK_CAMERA ?? "USB Camera2";
const CAMERA_IDENTITY_PREFIX = process.env.SCREENHAND_BLACK_CAMERA_IDENTITY?.trim() ?? "";
const CAMERA_INPUT_RESOLVED = process.env.SCREENHAND_BLACK_CAMERA_RESOLVED === "1";
const CAMERA_STREAM_PORT = Number(process.env.SCREENHAND_BLACK_CAMERA_STREAM_PORT ?? 0);
const CAPTURE_SIZE = process.env.SCREENHAND_BLACK_CAPTURE_SIZE?.trim() ?? "1920x1080";
const CAPTURE_FPS = Number(process.env.SCREENHAND_BLACK_CAPTURE_FPS ?? 30);
const DIGITAL_CAMERA_NAME = process.env.SCREENHAND_DIGITAL_CAMERA?.trim() ?? "";
const FRAME_WIDTH = 720;
const FRAME_HEIGHT = 1280;
const DIGITAL_FRAME_WIDTH = 720;
const DIGITAL_FRAME_HEIGHT = 1560;
const STREAM_STALE_MS = 2_500;
const AUTO_HOME = process.env.SCREENHAND_BLACK_AUTO_HOME !== "0";
if (!new Set(["640x480", "1280x720", "1920x1080"]).has(CAPTURE_SIZE)) {
  throw new Error(`Unsupported physical camera capture size: ${CAPTURE_SIZE}`);
}
if (!new Set([5, 15, 30]).has(CAPTURE_FPS)) {
  throw new Error(`Unsupported physical camera capture frame rate: ${CAPTURE_FPS}`);
}
if (
  CAMERA_STREAM_PORT &&
  (!Number.isInteger(CAMERA_STREAM_PORT) || CAMERA_STREAM_PORT < 3_000 || CAMERA_STREAM_PORT > 65_535)
) {
  throw new Error(`Invalid physical camera stream port: ${CAMERA_STREAM_PORT}`);
}
const MOVEMENT_BOUNDS = {
  minimumX: Number(process.env.SCREENHAND_BLACK_MIN_X ?? 5.8),
  maximumX: Number(process.env.SCREENHAND_BLACK_MAX_X ?? 78.5),
  minimumY: Number(process.env.SCREENHAND_BLACK_MIN_Y ?? 10.5),
  maximumY: Number(process.env.SCREENHAND_BLACK_MAX_Y ?? 168),
};
const CALIBRATION_MOVEMENT_BOUNDS = {
  minimumX: Number(process.env.SCREENHAND_BLACK_CALIBRATION_MIN_X ?? 1),
  maximumX: Number(process.env.SCREENHAND_BLACK_CALIBRATION_MAX_X ?? 82),
  minimumY: Number(process.env.SCREENHAND_BLACK_CALIBRATION_MIN_Y ?? 1),
  maximumY: Number(process.env.SCREENHAND_BLACK_CALIBRATION_MAX_Y ?? 170),
};

type DriverRecovery = {
  status?: "running" | "complete" | "failed" | "manual-reference";
  error?: string;
  initial?: Record<string, unknown>;
  current?: Record<string, unknown>;
  steps?: Array<Record<string, unknown>>;
};

type DriverStatus = {
  ok: boolean;
  connected: boolean;
  homed: boolean;
  state: string;
  normalized_z: number;
  position: { x: number; y: number; z: number; a?: number };
  limit_pins?: string;
  reference_mode?: "unreferenced" | "sensor-home" | "manual";
  controller_position?: { x: number; y: number; z: number; a?: number };
  coordinate_offset?: { x: number; y: number; z: number; a?: number };
  recovery?: DriverRecovery;
  live_touch?: { active: boolean; expiresInMs: number };
  error?: string;
};

type DriverHealth = {
  ok?: boolean;
  profile?: {
    liveTouchTimeoutMs?: number;
  };
};

type NodeCommand = {
  type: "command";
  id: string;
  deviceId: string;
  expiresAt: number;
  ttlMs: number;
  action: "status" | "hold" | "home" | "resume" | "jog" | "hover_move" | "touch_down" | "touch_move" | "touch_up" | "touch_keepalive" | "tap" | "long_press" | "swipe" | "system_edge_swipe" | "system_edge_tap" | "input_text";
  params?: Record<string, unknown>;
};

type Operation = {
  id: string;
  type: string;
  status: "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
};

const state = {
  appVersion: "0.1.15",
  hardware: "black-arm-direct",
  controlPlaneConnected: false,
  cameraReady: false,
  cameraDetail: "Starting built-in UVC camera",
  digitalReady: false,
  digitalConnected: false,
  digitalDetail: "Starting wired iPhone video",
  videoMode: "waiting" as "wired" | "camera_fallback" | "waiting",
  videoDetail: "Waiting for wired iPhone video",
  grbl: {
    connected: false,
    homed: false,
    state: "OFFLINE",
    x: 0,
    y: 0,
    z: 0,
    physicalZ: 0,
    limitPins: "",
    referenceMode: "unreferenced" as "unreferenced" | "sensor-home" | "manual",
    coordinateOffset: null as DriverStatus["coordinate_offset"] | null,
    baud: 95_200,
    error: "",
    recovery: null as DriverRecovery | null,
    liveTouch: null as DriverStatus["live_touch"] | null,
    liveTouchSupported: false,
    liveTouchReason: "Verifying continuous-contact driver support",
    startupMode: AUTO_HOME ? "auto-home" : "manual-home",
    startupStatus: "waiting" as "waiting" | "recovering" | "ready" | "failed",
    startupError: "",
    activeOperation: null as Operation | null,
    lastOperation: {} as Operation | Record<string, never>,
    calibrationActive: true,
    calibrationRemainingMs: 86_400_000,
    movementBounds: MOVEMENT_BOUNDS,
    calibrationMovementBounds: CALIBRATION_MOVEMENT_BOUNDS,
    tapProfile: {
      id: PROFILE_ID,
      hoverZ: 1,
      touchZ: 10,
      minimumTouchZ: Number(process.env.SCREENHAND_BLACK_MIN_TOUCH_Z ?? 9.5),
      sequenceReleaseZ: Number(process.env.SCREENHAND_BLACK_SEQUENCE_RELEASE_Z ?? 8.5),
      maximumTouchZ: Number(process.env.SCREENHAND_BLACK_MAX_Z ?? 10),
      supportsLongPress: true,
      supportsSwipe: true,
    },
  },
};

let socket: WebSocket | null = null;
let stopped = false;
let driverCapabilitiesLastCheckedAt = 0;
let camera: ChildProcess | null = null;
let digitalCamera: ChildProcess | null = null;
let cameraStreamServer: Server | null = null;
let cameraStreamSocket: Socket | null = null;
let cameraBuffer = Buffer.alloc(0);

function listedAvFoundationVideoDevices() {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "",
  ], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const videoSection = output.split("AVFoundation audio devices:")[0] ?? output;
  return [...videoSection.matchAll(/\[(\d+)\]\s+([^\r\n]+)/g)].map((match) => ({
    index: match[1],
    name: match[2].trim(),
  }));
}

function listedSystemCameras() {
  const result = spawnSync("system_profiler", [
    "SPCameraDataType", "-json", "-detailLevel", "mini",
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("Unable to read macOS camera identities; physical camera remains locked");
  }
  const parsed = JSON.parse(result.stdout) as {
    SPCameraDataType?: Array<Record<string, unknown>>;
  };
  return (parsed.SPCameraDataType ?? []).map((camera) => ({
    name: String(camera._name ?? "").trim(),
    uniqueId: String(camera["spcamera_unique-id"] ?? "").trim(),
  }));
}

function validatedPhysicalCameraInput(input: string) {
  const devices = listedAvFoundationVideoDevices();
  let selected: (typeof devices)[number] | undefined;
  if (CAMERA_INPUT_RESOLVED) {
    if (!/^\d+$/.test(input)) {
      throw new Error("Supervisor supplied an invalid resolved camera input");
    }
    selected = { index: input, name: "USB Camera2" };
  } else if (CAMERA_IDENTITY_PREFIX) {
    const prefix = CAMERA_IDENTITY_PREFIX.toLowerCase();
    const systemCameras = listedSystemCameras();
    const identityMatches = systemCameras.filter((camera) =>
      camera.uniqueId.toLowerCase().startsWith(prefix)
    );
    if (identityMatches.length !== 1) {
      throw new Error(
        `Camera identity ${CAMERA_IDENTITY_PREFIX} matched ${identityMatches.length} devices; ` +
        "physical camera remains locked",
      );
    }
    const identity = identityMatches[0];
    const ordinal = systemCameras
      .filter((camera) => camera.name === identity.name)
      .indexOf(identity);
    selected = devices.filter((device) => device.name === identity.name)[ordinal];
  } else {
    selected = /^\d+$/.test(input)
      ? devices.find((device) => device.index === input)
      : devices.find((device) => device.name === input);
  }
  if (!selected) {
    throw new Error(
      `Camera ${CAMERA_IDENTITY_PREFIX || input} is not present; physical camera remains locked`,
    );
  }
  if (!/^USB Camera2$/i.test(selected.name)) {
    throw new Error(
      `Refusing camera ${selected.index} (${selected.name}); only the robot USB Camera2 is allowed`,
    );
  }
  return selected.index;
}
let digitalCameraBuffer = Buffer.alloc(0);
let pendingFrame: Buffer | null = null;
let pendingDigitalFrame: Buffer | null = null;
let frameUploadActive = false;
let digitalFrameUploadActive = false;
let lastCameraFrameAt = 0;
let lastDigitalFrameAt = 0;
let lastDigitalSignalCheckAt = 0;
let digitalSignalActive = false;
let driverRecoveryAttempted = false;
const recentCommandIds = new Set<string>();
let pendingHoverMove: NodeCommand | null = null;
let hoverMoveActive = false;
let pendingLiveTouchMove: NodeCommand | null = null;
let liveTouchMoveActive = false;
let liveTouchTransitionQueue: Promise<void> = Promise.resolve();

function looksLikeCaptureCardStandby(frame: Buffer) {
  try {
    const image = decode(frame, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
      maxResolutionInMP: 2,
    });
    if (image.width !== DIGITAL_FRAME_WIDTH || image.height !== DIGITAL_FRAME_HEIGHT) {
      return false;
    }
    const rgb = (x: number, y: number) => {
      const offset = (y * image.width + x) * 4;
      return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    };
    const cyan = ([red, green, blue]: number[]) =>
      red < 45 && green > 225 && blue > 175;
    const white = ([red, green, blue]: number[]) =>
      red > 235 && green > 235 && blue > 235;
    // The receiver/capture adapter emits this fixed cyan-and-white card when
    // the iPhone is not mirroring. Treat it as "capture hardware online, no
    // phone signal" instead of advertising a false Wired HD session.
    const standbyCard = [
      rgb(360, 20),
      rgb(700, 20),
      rgb(360, 200),
      rgb(360, 1_000),
    ].every(cyan) && [rgb(20, 20), rgb(50, 600)].every(white);
    const blackOrProtected = [
      rgb(40, 40),
      rgb(360, 40),
      rgb(680, 40),
      rgb(40, 780),
      rgb(360, 780),
      rgb(680, 780),
      rgb(40, 1_500),
      rgb(360, 1_500),
      rgb(680, 1_500),
    ].every((sample) => Math.max(...sample) < 14);
    return standbyCard || blackOrProtected;
  } catch {
    return false;
  }
}

function refreshVideoState(now = Date.now()) {
  if (lastCameraFrameAt > 0 && now - lastCameraFrameAt > STREAM_STALE_MS) {
    state.cameraReady = false;
    state.cameraDetail = "Built-in camera frame is stale";
  }
  if (lastDigitalFrameAt > 0 && now - lastDigitalFrameAt > STREAM_STALE_MS) {
    state.digitalReady = false;
    state.digitalConnected = false;
    state.digitalDetail = "Waiting for iPhone wired video output";
  }
  if (state.digitalReady) {
    state.videoMode = "wired";
    state.videoDetail = "Wired HD screen";
  } else if (state.cameraReady) {
    state.videoMode = "camera_fallback";
    state.videoDetail = "Built-in camera fallback; wired video will restore automatically";
  } else {
    state.videoMode = "waiting";
    state.videoDetail = "Waiting for a live phone image";
  }
}

function socketUrl() {
  const url = new URL("/api/node/socket", CONTROL_PLANE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

async function readDriverStatus(): Promise<DriverStatus> {
  const response = await fetch(`${DRIVER_URL}/api/status`, {
    signal: AbortSignal.timeout(1_500),
    cache: "no-store",
  });
  const value = await response.json() as DriverStatus;
  if (!response.ok || !value.ok) {
    throw new Error(value.error ?? `Black arm driver returned ${response.status}`);
  }
  return value;
}

async function postDriverStatus(route: string, timeoutMs: number): Promise<DriverStatus> {
  const response = await fetch(`${DRIVER_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json() as {
    ok?: boolean;
    error?: string;
    status?: DriverStatus;
  };
  if (!response.ok || payload.ok !== true || !payload.status) {
    throw new Error(payload.error ?? `Black arm driver returned ${response.status}`);
  }
  return payload.status;
}

async function refreshDriverCapabilities(force = false) {
  const now = Date.now();
  if (!force && now - driverCapabilitiesLastCheckedAt < 5_000) return;
  driverCapabilitiesLastCheckedAt = now;
  try {
    const response = await fetch(`${DRIVER_URL}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    const payload = await response.json() as DriverHealth;
    const watchdogMs = Number(payload.profile?.liveTouchTimeoutMs);
    const supported = response.ok && payload.ok === true &&
      Number.isFinite(watchdogMs) && watchdogMs >= 500;
    state.grbl.liveTouchSupported = supported;
    state.grbl.liveTouchReason = supported
      ? "Continuous-contact driver verified"
      : "The running hardware driver does not support continuous mouse contact; restart it with the matching ScreenHand feature driver.";
  } catch {
    state.grbl.liveTouchSupported = false;
    state.grbl.liveTouchReason =
      "Unable to verify continuous-contact support from the hardware driver.";
  }
}

function applyStatus(value: DriverStatus) {
  state.grbl.connected = value.connected;
  state.grbl.homed = value.homed;
  state.grbl.state = value.state;
  state.grbl.x = value.position.x;
  state.grbl.y = value.position.y;
  state.grbl.z = value.normalized_z;
  state.grbl.physicalZ = value.position.z;
  state.grbl.limitPins = value.limit_pins ?? "";
  state.grbl.referenceMode = value.reference_mode ?? (value.homed ? "sensor-home" : "unreferenced");
  state.grbl.coordinateOffset = value.coordinate_offset ?? null;
  state.grbl.recovery = value.recovery ?? null;
  state.grbl.liveTouch = value.live_touch ?? null;
  state.grbl.error = "";
}

async function refreshStatus(): Promise<DriverStatus | null> {
  try {
    const [status] = await Promise.all([
      readDriverStatus(),
      refreshDriverCapabilities(),
    ]);
    applyStatus(status);
    return status;
  } catch (error) {
    state.grbl.connected = false;
    state.grbl.state = "OFFLINE";
    state.grbl.error = error instanceof Error ? error.message : "Black arm driver offline";
    return null;
  }
}

async function ensureDriverReady(status: DriverStatus | null) {
  if (!AUTO_HOME || !status || status.homed || driverRecoveryAttempted || stopped) return;
  if (status.recovery?.status === "failed") {
    driverRecoveryAttempted = true;
    state.grbl.startupStatus = "failed";
    state.grbl.startupError = status.recovery.error ?? "Automatic homing recovery failed";
    return;
  }

  driverRecoveryAttempted = true;
  state.grbl.startupStatus = "recovering";
  state.grbl.startupError = "";
  sendHeartbeat();
  try {
    const recovered = await postDriverStatus("/api/home-machine", 55_000);
    applyStatus(recovered);
    if (!recovered.homed || recovered.state !== "Idle") {
      throw new Error(`Automatic homing ended in ${recovered.state}`);
    }
    state.grbl.startupStatus = "ready";
  } catch (error) {
    const current = await refreshStatus();
    state.grbl.startupStatus = "failed";
    state.grbl.startupError = current?.recovery?.error ??
      (error instanceof Error ? error.message : "Automatic homing recovery failed");
  } finally {
    sendHeartbeat();
  }
}

function sendHeartbeat() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "heartbeat",
    deviceId: DEVICE_ID,
    at: Date.now(),
    state,
  }));
}

function sendCommandResult(command: NodeCommand, ok: boolean, input: {
  error?: string;
  result?: unknown;
} = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "event",
    deviceId: DEVICE_ID,
    name: "command-result",
    payload: {
      id: command.id,
      action: command.action,
      ok,
      ...(input.error ? { error: input.error } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      state,
    },
  }));
}

function rememberCommand(id: string) {
  if (recentCommandIds.has(id)) return false;
  recentCommandIds.add(id);
  while (recentCommandIds.size > 64) {
    const first = recentCommandIds.values().next().value;
    if (typeof first !== "string") break;
    recentCommandIds.delete(first);
  }
  return true;
}

function driverRoute(command: NodeCommand) {
  if (command.action === "jog" && command.params?.mode === "calibration") {
    return "/api/calibration/move";
  }
  if (command.action === "jog") return "/api/move";
  if (command.action === "hover_move") return "/api/move";
  if (command.action === "touch_down") return "/api/live-touch/down";
  if (command.action === "touch_move") return "/api/live-touch/move";
  if (command.action === "touch_up") return "/api/live-touch/up";
  if (command.action === "touch_keepalive") return "/api/live-touch/keepalive";
  if (command.action === "tap") return "/api/tap";
  if (command.action === "input_text") return "/api/tap_sequence";
  if (command.action === "long_press") return "/api/long_press";
  if (command.action === "swipe") return "/api/swipe";
  if (command.action === "system_edge_swipe") return "/api/system-edge-swipe";
  if (command.action === "system_edge_tap") return "/api/system-edge-tap";
  if (command.action === "hold") return "/api/hold";
  if (command.action === "home") return "/api/home-machine";
  if (command.action === "resume") return "/api/resume";
  return null;
}

function hoverMoveError(command: NodeCommand): string | null {
  const x = Number(command.params?.x);
  const y = Number(command.params?.y);
  const profileId = String(command.params?.profileId ?? "");
  if (profileId !== PROFILE_ID) return "Hover calibration profile mismatch";
  if (!Number.isFinite(x) || x < MOVEMENT_BOUNDS.minimumX || x > MOVEMENT_BOUNDS.maximumX) {
    return "Hover X is outside the verified movement bounds";
  }
  if (!Number.isFinite(y) || y < MOVEMENT_BOUNDS.minimumY || y > MOVEMENT_BOUNDS.maximumY) {
    return "Hover Y is outside the verified movement bounds";
  }
  if (!state.grbl.connected || !state.grbl.homed) return "The arm is not connected and homed";
  if (!state.grbl.calibrationActive) return "The local calibration safety window is locked";
  if (state.grbl.activeOperation) return "Another physical operation is already running";
  if (state.grbl.state !== "Idle") return `The controller is ${state.grbl.state}, not Idle`;
  if (Math.abs(Number(state.grbl.z)) > 0.02) return "The stylus is not at the verified hover height";
  return null;
}

function systemEdgeSwipeError(command: NodeCommand): string | null {
  const params = command.params ?? {};
  const startX = Number(params.startX);
  const startY = Number(params.startY);
  const endX = Number(params.endX);
  const endY = Number(params.endY);
  const boundary = String(params.boundary ?? "");
  const profileId = String(params.profileId ?? "");
  if (profileId !== PROFILE_ID) return "System-edge calibration profile mismatch";
  if (params.confirmation !== "CALIBRATED_SYSTEM_EDGE_GESTURE") {
    return "System-edge gesture confirmation is missing";
  }
  if (![startX, startY, endX, endY].every(Number.isFinite)) {
    return "System-edge gesture coordinates are invalid";
  }
  const inside = (x: number, y: number, bounds: typeof MOVEMENT_BOUNDS) =>
    x >= bounds.minimumX && x <= bounds.maximumX &&
    y >= bounds.minimumY && y <= bounds.maximumY;
  if (!inside(startX, startY, CALIBRATION_MOVEMENT_BOUNDS)) {
    return "System-edge start is outside calibration travel";
  }
  if (!inside(endX, endY, MOVEMENT_BOUNDS)) {
    return "System-edge end is outside normal touch bounds";
  }
  const extension = boundary === "minimumX"
    ? MOVEMENT_BOUNDS.minimumX - startX
    : boundary === "maximumX"
      ? startX - MOVEMENT_BOUNDS.maximumX
      : boundary === "minimumY"
        ? MOVEMENT_BOUNDS.minimumY - startY
        : boundary === "maximumY"
          ? startY - MOVEMENT_BOUNDS.maximumY
          : Number.NaN;
  const inward = boundary === "minimumX"
    ? endX > startX && startY >= MOVEMENT_BOUNDS.minimumY && startY <= MOVEMENT_BOUNDS.maximumY
    : boundary === "maximumX"
      ? endX < startX && startY >= MOVEMENT_BOUNDS.minimumY && startY <= MOVEMENT_BOUNDS.maximumY
      : boundary === "minimumY"
        ? endY > startY && startX >= MOVEMENT_BOUNDS.minimumX && startX <= MOVEMENT_BOUNDS.maximumX
        : boundary === "maximumY"
          ? endY < startY && startX >= MOVEMENT_BOUNDS.minimumX && startX <= MOVEMENT_BOUNDS.maximumX
          : false;
  if (!inward || !Number.isFinite(extension) || extension <= 0 || extension > 6) {
    return "System-edge gesture is not a bounded inward swipe";
  }
  if (!state.grbl.connected || !state.grbl.homed) return "The arm is not connected and homed";
  if (!state.grbl.calibrationActive) return "The local calibration safety window is locked";
  if (state.grbl.activeOperation) return "Another physical operation is already running";
  if (state.grbl.state !== "Idle") return `The controller is ${state.grbl.state}, not Idle`;
  if (Math.abs(Number(state.grbl.z)) > 0.02) return "The stylus is not at the verified hover height";
  return null;
}

function systemEdgeTapError(command: NodeCommand): string | null {
  const params = command.params ?? {};
  const x = Number(params.x);
  const y = Number(params.y);
  const boundary = String(params.boundary ?? "");
  if (String(params.profileId ?? "") !== PROFILE_ID) {
    return "System-edge tap calibration profile mismatch";
  }
  if (params.confirmation !== "CALIBRATED_SYSTEM_EDGE_TAP") {
    return "System-edge tap confirmation is missing";
  }
  if (
    !Number.isFinite(x) || !Number.isFinite(y) ||
    x < CALIBRATION_MOVEMENT_BOUNDS.minimumX ||
    x > CALIBRATION_MOVEMENT_BOUNDS.maximumX ||
    y < CALIBRATION_MOVEMENT_BOUNDS.minimumY ||
    y > CALIBRATION_MOVEMENT_BOUNDS.maximumY
  ) return "System-edge tap is outside calibration travel";
  const extension = boundary === "minimumX"
    ? MOVEMENT_BOUNDS.minimumX - x
    : boundary === "maximumX"
      ? x - MOVEMENT_BOUNDS.maximumX
      : boundary === "minimumY"
        ? MOVEMENT_BOUNDS.minimumY - y
        : boundary === "maximumY"
          ? y - MOVEMENT_BOUNDS.maximumY
          : Number.NaN;
  const crossAxisSafe = boundary === "minimumX" || boundary === "maximumX"
    ? y >= MOVEMENT_BOUNDS.minimumY && y <= MOVEMENT_BOUNDS.maximumY
    : x >= MOVEMENT_BOUNDS.minimumX && x <= MOVEMENT_BOUNDS.maximumX;
  if (!crossAxisSafe || !Number.isFinite(extension) || extension <= 0 || extension > 10) {
    return "System-edge tap is not a bounded single-edge target";
  }
  if (!state.grbl.connected || !state.grbl.homed) return "The arm is not connected and homed";
  if (!state.grbl.calibrationActive) return "The local calibration safety window is locked";
  if (state.grbl.activeOperation) return "Another physical operation is already running";
  if (state.grbl.state !== "Idle") return `The controller is ${state.grbl.state}, not Idle`;
  if (Math.abs(Number(state.grbl.z)) > 0.02) return "The stylus is not at the verified hover height";
  return null;
}

function cancelPendingHoverMove(reason: string) {
  if (!pendingHoverMove) return;
  sendCommandResult(pendingHoverMove, true, {
    result: { superseded: true, reason },
  });
  pendingHoverMove = null;
}

async function drainHoverMoves() {
  if (hoverMoveActive) return;
  hoverMoveActive = true;
  try {
    while (pendingHoverMove && !stopped) {
      const command = pendingHoverMove;
      pendingHoverMove = null;
      if (Date.now() > Number(command.expiresAt)) {
        sendCommandResult(command, false, { error: "Hover command expired before execution" });
        continue;
      }
      const safetyError = hoverMoveError(command);
      if (safetyError) {
        sendCommandResult(command, false, { error: safetyError });
        continue;
      }
      try {
        const response = await fetch(`${DRIVER_URL}/api/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command.params ?? {}),
          signal: AbortSignal.timeout(6_000),
        });
        const payload = await response.json() as {
          ok?: boolean;
          error?: string;
          status?: DriverStatus;
        };
        if (!response.ok || payload.ok !== true || !payload.status) {
          throw new Error(payload.error ?? `Black arm driver returned ${response.status}`);
        }
        applyStatus(payload.status);
        sendCommandResult(command, true, { result: payload.status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Black arm hover move failed";
        await refreshStatus();
        sendCommandResult(command, false, { error: message });
      }
      sendHeartbeat();
    }
  } finally {
    hoverMoveActive = false;
    if (pendingHoverMove && !stopped) void drainHoverMoves();
  }
}

function queueHoverMove(command: NodeCommand) {
  const safetyError = hoverMoveError(command);
  if (safetyError) {
    sendCommandResult(command, false, { error: safetyError });
    return;
  }
  cancelPendingHoverMove("A newer mouse position replaced this hover target");
  pendingHoverMove = command;
  void drainHoverMoves();
}

function liveTouchMoveError(command: NodeCommand): string | null {
  const x = Number(command.params?.x);
  const y = Number(command.params?.y);
  const profileId = String(command.params?.profileId ?? "");
  const sessionId = String(command.params?.sessionId ?? "").trim();
  if (profileId !== PROFILE_ID) return "Live-touch calibration profile mismatch";
  if (!sessionId || sessionId.length > 160) return "Live-touch session id is invalid";
  if (!Number.isFinite(x) || x < MOVEMENT_BOUNDS.minimumX || x > MOVEMENT_BOUNDS.maximumX) {
    return "Live-touch X is outside the verified movement bounds";
  }
  if (!Number.isFinite(y) || y < MOVEMENT_BOUNDS.minimumY || y > MOVEMENT_BOUNDS.maximumY) {
    return "Live-touch Y is outside the verified movement bounds";
  }
  if (!state.grbl.connected || !state.grbl.homed) return "The arm is not connected and homed";
  if (!state.grbl.calibrationActive) return "The local calibration safety window is locked";
  if (state.grbl.activeOperation) return "Another physical operation is already running";
  if (state.grbl.state !== "Idle") return `The controller is ${state.grbl.state}, not Idle`;
  if (state.grbl.liveTouch?.active !== true) return "No verified live mouse contact is active";
  return null;
}

function cancelPendingLiveTouchMove(reason: string) {
  if (!pendingLiveTouchMove) return;
  sendCommandResult(pendingLiveTouchMove, true, {
    result: { superseded: true, reason },
  });
  pendingLiveTouchMove = null;
}

async function drainLiveTouchMoves() {
  if (liveTouchMoveActive) return;
  liveTouchMoveActive = true;
  try {
    while (pendingLiveTouchMove && !stopped) {
      const command = pendingLiveTouchMove;
      pendingLiveTouchMove = null;
      if (Date.now() > Number(command.expiresAt)) {
        sendCommandResult(command, false, {
          error: "Live-touch move expired before execution",
        });
        continue;
      }
      const executeMove = liveTouchTransitionQueue.then(async () => {
        const safetyError = liveTouchMoveError(command);
        if (safetyError) {
          sendCommandResult(command, false, { error: safetyError });
          return;
        }
        try {
          const response = await fetch(`${DRIVER_URL}/api/live-touch/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(command.params ?? {}),
            signal: AbortSignal.timeout(6_000),
          });
          const payload = await response.json() as {
            ok?: boolean;
            error?: string;
            status?: DriverStatus;
          };
          if (!response.ok || payload.ok !== true || !payload.status) {
            throw new Error(payload.error ?? `Black arm driver returned ${response.status}`);
          }
          applyStatus(payload.status);
          sendCommandResult(command, true, { result: payload.status });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Black arm live-touch move failed";
          await refreshStatus();
          sendCommandResult(command, false, { error: message });
        }
        sendHeartbeat();
      });
      liveTouchTransitionQueue = executeMove.catch(() => undefined);
      await executeMove;
    }
  } finally {
    liveTouchMoveActive = false;
    if (pendingLiveTouchMove && !stopped) void drainLiveTouchMoves();
  }
}

function queueLiveTouchMove(command: NodeCommand) {
  cancelPendingLiveTouchMove("A newer mouse position replaced this drag target");
  pendingLiveTouchMove = command;
  void drainLiveTouchMoves();
}

async function executeCommand(command: NodeCommand) {
  if (!command.id || !rememberCommand(command.id)) {
    sendCommandResult(command, false, { error: "Duplicate or empty command id" });
    return;
  }
  if (Date.now() > Number(command.expiresAt) || command.ttlMs <= 0 || command.ttlMs > 5_000) {
    sendCommandResult(command, false, { error: "Command expired before execution" });
    return;
  }
  if (command.action === "status") {
    await refreshStatus();
    sendCommandResult(command, true, { result: state.grbl });
    sendHeartbeat();
    return;
  }
  if (command.action === "hover_move") {
    queueHoverMove(command);
    return;
  }
  if (command.action === "touch_move") {
    queueLiveTouchMove(command);
    return;
  }

  cancelPendingHoverMove(`A ${command.action} command replaced the pending hover target`);
  if (command.action !== "touch_keepalive") {
    cancelPendingLiveTouchMove(`A ${command.action} command ended the pending drag target`);
  }
  if (command.action === "touch_down") {
    const safetyError = hoverMoveError(command);
    if (safetyError) {
      sendCommandResult(command, false, { error: safetyError });
      return;
    }
  }
  if (command.action === "system_edge_swipe") {
    const safetyError = systemEdgeSwipeError(command);
    if (safetyError) {
      sendCommandResult(command, false, { error: safetyError });
      return;
    }
  }
  if (command.action === "system_edge_tap") {
    const safetyError = systemEdgeTapError(command);
    if (safetyError) {
      sendCommandResult(command, false, { error: safetyError });
      return;
    }
  }

  const route = driverRoute(command);
  if (!route) {
    sendCommandResult(command, false, { error: `Unsupported action: ${command.action}` });
    return;
  }

  const isTouch = [
    "tap",
    "long_press",
    "swipe",
    "system_edge_swipe",
    "system_edge_tap",
    "input_text",
  ].includes(command.action);
  const isCalibrationMove = command.action === "jog" && command.params?.mode === "calibration";
  const isTrackedOperation = isTouch || command.action === "home" || isCalibrationMove;
  if (isTrackedOperation) {
    state.grbl.activeOperation = {
      id: command.id,
      type: command.action,
      status: "running",
      startedAt: Date.now(),
    };
    state.grbl.lastOperation = {};
    if (command.action === "home") {
      state.grbl.startupStatus = "recovering";
      state.grbl.startupError = "";
    }
    sendCommandResult(command, true);
    sendHeartbeat();
  }

  try {
    const response = await fetch(`${DRIVER_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command.params ?? {}),
      signal: AbortSignal.timeout(command.action === "input_text"
        ? 90_000
        : command.action === "home"
        ? 60_000
        : command.action === "long_press"
          ? 8_000
          : 6_000),
    });
    const payload = await response.json() as {
      ok?: boolean;
      error?: string;
      status?: DriverStatus;
    };
    if (!response.ok || payload.ok !== true || !payload.status) {
      throw new Error(payload.error ?? `Black arm driver returned ${response.status}`);
    }
    applyStatus(payload.status);
    if (isTrackedOperation) {
      state.grbl.activeOperation = null;
      state.grbl.lastOperation = {
        id: command.id,
        type: command.action,
        status: "completed",
        completedAt: Date.now(),
        result: payload.status,
      };
      if (command.action === "home") state.grbl.startupStatus = "ready";
    } else {
      sendCommandResult(command, true, { result: payload.status });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Black arm action failed";
    await refreshStatus();
    if (isTrackedOperation) {
      state.grbl.activeOperation = null;
      state.grbl.lastOperation = {
        id: command.id,
        type: command.action,
        status: "failed",
        completedAt: Date.now(),
        error: message,
      };
      if (command.action === "home") {
        state.grbl.startupStatus = "failed";
        state.grbl.startupError = message;
      }
    } else {
      sendCommandResult(command, false, { error: message });
    }
  }
  sendHeartbeat();
}

function dispatchCommand(command: NodeCommand) {
  if (
    (command.action === "touch_down" || command.action === "touch_move") &&
    state.grbl.liveTouchSupported !== true
  ) {
    sendCommandResult(command, false, {
      error: state.grbl.liveTouchReason,
    });
    return;
  }
  if (["touch_down", "touch_up", "touch_keepalive"].includes(command.action)) {
    const executeTransition = liveTouchTransitionQueue.then(() => executeCommand(command));
    liveTouchTransitionQueue = executeTransition.catch(() => undefined);
    return;
  }
  void executeCommand(command);
}

function connectControlPlane() {
  if (stopped) return;
  const next = new WebSocket(socketUrl());
  socket = next;
  next.on("open", async () => {
    state.controlPlaneConnected = true;
    await refreshDriverCapabilities(true);
    const driverStatus = await refreshStatus();
    if (driverStatus?.homed) {
      driverRecoveryAttempted = true;
      state.grbl.startupStatus = "ready";
    } else {
      void ensureDriverReady(driverStatus);
    }
    sendHeartbeat();
    process.stdout.write(`Black arm node connected as ${DEVICE_ID}\n`);
  });
  next.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as NodeCommand | { type?: string };
      if (message.type === "command") dispatchCommand(message as NodeCommand);
    } catch (error) {
      process.stderr.write(`Invalid control plane message: ${String(error)}\n`);
    }
  });
  next.on("close", () => {
    state.controlPlaneConnected = false;
    if (!stopped) setTimeout(connectControlPlane, 800).unref();
  });
  next.on("error", () => next.close());
}

async function uploadFrames() {
  if (frameUploadActive) return;
  frameUploadActive = true;
  try {
    while (pendingFrame && !stopped) {
      const frame = pendingFrame;
      pendingFrame = null;
      try {
        const capturedAt = Date.now();
        const response = await fetch(`${CONTROL_PLANE_URL}/api/frame/jpeg`, {
          method: "POST",
          headers: {
            "Content-Type": "image/jpeg",
            "X-ScreenHand-Frame-Width": String(FRAME_WIDTH),
            "X-ScreenHand-Frame-Height": String(FRAME_HEIGHT),
            "X-ScreenHand-Captured-At": String(capturedAt),
            "X-ScreenHand-Device-Id": DEVICE_ID,
            "X-ScreenHand-Frame-Source": "black-arm-built-in-uvc",
            "X-ScreenHand-Frame-Role": "verification",
            // Keep camera nodes compatible with control planes released before
            // the ScreenHand protocol rename. A node can therefore be upgraded
            // independently without freezing the last accepted camera frame.
            "X-Phonebase-Frame-Width": String(FRAME_WIDTH),
            "X-Phonebase-Frame-Height": String(FRAME_HEIGHT),
            "X-Phonebase-Captured-At": String(capturedAt),
            "X-Phonebase-Device-Id": DEVICE_ID,
            "X-Phonebase-Frame-Source": "black-arm-built-in-uvc",
            "X-Phonebase-Frame-Role": "verification",
          },
          body: new Blob([Uint8Array.from(frame)]),
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) throw new Error(`frame HTTP ${response.status}`);
        state.cameraReady = true;
    state.cameraDetail = `${CAMERA_IDENTITY_PREFIX || CAMERA_NAME} · ${FRAME_WIDTH}×${FRAME_HEIGHT}`;
        lastCameraFrameAt = Date.now();
        refreshVideoState();
      } catch (error) {
        state.cameraReady = false;
        state.cameraDetail = error instanceof Error ? error.message : "Frame upload failed";
      }
    }
  } finally {
    frameUploadActive = false;
  }
}

async function uploadDigitalFrames() {
  if (digitalFrameUploadActive) return;
  digitalFrameUploadActive = true;
  try {
    while (pendingDigitalFrame && !stopped) {
      const frame = pendingDigitalFrame;
      pendingDigitalFrame = null;
      try {
        const now = Date.now();
        if (now - lastDigitalSignalCheckAt >= 800) {
          lastDigitalSignalCheckAt = now;
          digitalSignalActive = !looksLikeCaptureCardStandby(frame);
        }
        const response = await fetch(`${CONTROL_PLANE_URL}/api/frame/jpeg`, {
          method: "POST",
          headers: {
            "Content-Type": "image/jpeg",
            "X-ScreenHand-Frame-Width": String(DIGITAL_FRAME_WIDTH),
            "X-ScreenHand-Frame-Height": String(DIGITAL_FRAME_HEIGHT),
            "X-ScreenHand-Captured-At": String(Date.now()),
            "X-ScreenHand-Device-Id": DEVICE_ID,
            "X-ScreenHand-Frame-Source": "iphone-wired-usb-video",
            "X-ScreenHand-Frame-Role": "control",
            "X-Phonebase-Frame-Width": String(DIGITAL_FRAME_WIDTH),
            "X-Phonebase-Frame-Height": String(DIGITAL_FRAME_HEIGHT),
            "X-Phonebase-Captured-At": String(now),
            "X-Phonebase-Device-Id": DEVICE_ID,
            "X-Phonebase-Frame-Source": "iphone-wired-usb-video",
            "X-Phonebase-Frame-Role": "control",
          },
          body: new Blob([Uint8Array.from(frame)]),
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) throw new Error(`digital frame HTTP ${response.status}`);
        state.digitalReady = digitalSignalActive;
        state.digitalConnected = true;
        state.digitalDetail = digitalSignalActive
          ? `${DIGITAL_CAMERA_NAME} · ${DIGITAL_FRAME_WIDTH}×${DIGITAL_FRAME_HEIGHT}`
          : "Capture card connected · no usable iPhone image (off, protected, or not mirroring)";
        lastDigitalFrameAt = Date.now();
        refreshVideoState();
      } catch (error) {
        state.digitalReady = false;
        state.digitalConnected = false;
        state.digitalDetail = error instanceof Error ? error.message : "Digital frame upload failed";
      }
    }
  } finally {
    digitalFrameUploadActive = false;
  }
}

function acceptCameraBytes(chunk: Buffer) {
  cameraBuffer = Buffer.concat([cameraBuffer, chunk]);
  while (true) {
    const start = cameraBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      if (cameraBuffer.length > 2_000_000) cameraBuffer = Buffer.alloc(0);
      return;
    }
    const end = cameraBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      if (start > 0) cameraBuffer = cameraBuffer.subarray(start);
      return;
    }
    pendingFrame = Buffer.from(cameraBuffer.subarray(start, end + 2));
    cameraBuffer = cameraBuffer.subarray(end + 2);
    void uploadFrames();
  }
}

function acceptDigitalCameraBytes(chunk: Buffer) {
  digitalCameraBuffer = Buffer.concat([digitalCameraBuffer, chunk]);
  while (true) {
    const start = digitalCameraBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      if (digitalCameraBuffer.length > 2_000_000) digitalCameraBuffer = Buffer.alloc(0);
      return;
    }
    const end = digitalCameraBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      if (start > 0) digitalCameraBuffer = digitalCameraBuffer.subarray(start);
      return;
    }
    pendingDigitalFrame = Buffer.from(digitalCameraBuffer.subarray(start, end + 2));
    digitalCameraBuffer = digitalCameraBuffer.subarray(end + 2);
    void uploadDigitalFrames();
  }
}

function startCamera() {
  if (CAMERA_STREAM_PORT) {
    if (cameraStreamServer) return;
    cameraStreamServer = createServer((socket) => {
      cameraStreamSocket?.destroy();
      cameraStreamSocket = socket;
      cameraBuffer = Buffer.alloc(0);
      state.cameraReady = false;
      state.cameraDetail = `Camera broker connected on ${CAMERA_STREAM_PORT}`;
      socket.on("data", acceptCameraBytes);
      socket.on("close", () => {
        if (cameraStreamSocket !== socket) return;
        cameraStreamSocket = null;
        state.cameraReady = false;
        state.cameraDetail = "Camera broker stream disconnected";
        refreshVideoState();
      });
      socket.on("error", () => socket.destroy());
    });
    cameraStreamServer.on("error", (error) => {
      state.cameraReady = false;
      state.cameraDetail = `Camera broker listener failed: ${error.message}`;
      refreshVideoState();
    });
    cameraStreamServer.listen(CAMERA_STREAM_PORT, "127.0.0.1");
    state.cameraDetail = `Waiting for camera broker on ${CAMERA_STREAM_PORT}`;
    return;
  }
  let cameraInput: string;
  try {
    cameraInput = validatedPhysicalCameraInput(CAMERA_NAME);
  } catch (error) {
    state.cameraReady = false;
    state.cameraDetail = error instanceof Error ? error.message : "Physical camera safety check failed";
    refreshVideoState();
    if (!stopped) setTimeout(startCamera, 1_000).unref();
    return;
  }
  const cameraProcess = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "avfoundation",
    "-framerate", String(CAPTURE_FPS),
    // Capture at the camera's native 1080p and supersample down to the
    // calibrated portrait frame so physical-view text remains legible.
    "-video_size", CAPTURE_SIZE,
    "-pixel_format", "nv12",
    "-i", `${cameraInput}:none`,
    "-vf", `transpose=2,scale=720:1280:flags=lanczos,eq=contrast=1.06:brightness=-0.055:saturation=1.16:gamma=1.22:gamma_weight=0.72,unsharp=5:5:0.65:5:5:0.0,fps=${CAPTURE_FPS}`,
    "-q:v", "2",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  camera = cameraProcess;
  cameraProcess.stdout.on("data", acceptCameraBytes);
  cameraProcess.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) process.stderr.write(`[black-camera] ${message}\n`);
  });
  cameraProcess.on("exit", (code) => {
    state.cameraReady = false;
    state.cameraDetail = `Camera stopped (${code ?? "signal"})`;
    refreshVideoState();
    camera = null;
    if (!stopped) setTimeout(startCamera, 1_000).unref();
  });
}

function startDigitalCamera() {
  if (!DIGITAL_CAMERA_NAME) {
    state.digitalReady = false;
    state.digitalConnected = false;
    state.digitalDetail = "Optional wired video is not configured";
    refreshVideoState();
    return;
  }
  const cameraProcess = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "avfoundation",
    "-framerate", "30",
    "-video_size", "1920x1080",
    "-pixel_format", "nv12",
    "-i", `${DIGITAL_CAMERA_NAME}:none`,
    // Keep the authoritative local wired frame at high quality; the remote
    // gateway adapts its own output instead of degrading control geometry.
    "-vf", "crop=496:1072:712:4,scale=720:1560:flags=lanczos,unsharp=5:5:0.9:5:5:0.0,fps=10",
    "-pix_fmt", "yuvj444p",
    "-q:v", "1",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  digitalCamera = cameraProcess;
  cameraProcess.stdout.on("data", acceptDigitalCameraBytes);
  cameraProcess.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) process.stderr.write(`[iphone-video] ${message}\n`);
  });
  cameraProcess.on("exit", (code) => {
    state.digitalReady = false;
    state.digitalDetail = `Wired video stopped (${code ?? "signal"})`;
    refreshVideoState();
    digitalCamera = null;
    if (!stopped) setTimeout(startDigitalCamera, 1_000).unref();
  });
}

const heartbeatTimer = setInterval(async () => {
  refreshVideoState();
  const wasConnected = state.grbl.connected;
  const driverStatus = await refreshStatus();
  if (!driverStatus) {
    if (wasConnected) {
      driverRecoveryAttempted = false;
      state.grbl.startupStatus = "waiting";
      state.grbl.startupError = "";
    }
  } else if (driverStatus.homed) {
    driverRecoveryAttempted = true;
    state.grbl.startupStatus = "ready";
    state.grbl.startupError = "";
  } else {
    void ensureDriverReady(driverStatus);
  }
  sendHeartbeat();
}, 1_000);

function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(heartbeatTimer);
  const cameraProcesses = [camera, digitalCamera].filter(
    (child): child is ChildProcess => child !== null,
  );
  for (const child of cameraProcesses) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of cameraProcesses) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 250).unref();
  cameraStreamSocket?.destroy();
  cameraStreamServer?.close();
  socket?.close(1000, "node shutdown");
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startCamera();
startDigitalCamera();
connectControlPlane();
