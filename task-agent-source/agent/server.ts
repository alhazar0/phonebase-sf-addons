import "dotenv/config";

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  buildScreenHandCapabilities,
  normalizeScreenHandPoint,
  parseScreenHandActionEnvelope,
  ScreenHandActionValidationError,
  type ScreenHandSemanticAction,
} from "./action-contract";
import {
  calibratedReachableScreenPoint,
  calibratedScreenPoint,
  calibrationReadiness,
  loadScreenHandCalibrationProfile,
  parseScreenHandCalibrationProfile,
  retainedKeyboardCalibration,
  type ScreenHandCalibrationProfile,
} from "./calibration-profile";
import { homographyFromFourPoints, projectPoint } from "./homography";
import {
  phoneNavigationAvailability,
  planKeyboardNext,
  planPhoneNavigation,
  PhoneNavigationUnavailableError,
  type MachineBounds,
  type PhoneNavigationAvailability,
  type SystemEdgeBoundary,
} from "./system-navigation";
import { iosEnglishKeyboardSequence } from "./ios-keyboard";
import {
  iosEnglishKeyboardConfidence,
  iosEnglishKeyboardVisible,
} from "./ios-keyboard-visibility";
import {
  iosKeyboardShiftActive,
  iosKeyboardOcrEvidence,
  keyboardUsesNonLatinInput,
  looksLikeIosKeyboard,
} from "./fast-intent";
import { detectBackControl } from "./back-control-vision";
import { recognizeVisionText } from "./vision-ocr";
import { renderModelScreenFrame } from "./rectify-frame";
import { FileAgentMemory } from "./agent-memory";
import { parseAgentRunRequest } from "./general-agent-contract";
import { ScreenHandGeneralAgentClient } from "./general-agent-client";
import {
  GeneralAgentRunConflictError,
  GeneralAgentRunRegistry,
} from "./general-agent-runs";
import { GeneralMobileAgent } from "./general-mobile-agent";
import { ScreenObserver } from "./screen-observer";
import { OpenAIVisionPlanner } from "./vision-model-planner";
import { SemanticWorldModel } from "./active-world/semantic-world-model";
import {
  compactHoverReceiptOperation,
  commandResultReceiptDecision,
  operationReceiptDecision,
  receiptIdsToPrune,
} from "./receipt-state";
import { comparePhoneFrames } from "./frame-sync";
import { calibrationReadinessIssue } from "../shared/calibration-readiness";

const HOST = process.env.SCREENHAND_CONTROL_PLANE_HOST ?? "127.0.0.1";
const PORT = Number(
  process.env.SCREENHAND_CONTROL_PLANE_PORT ?? 3013,
);
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const FRAME_FRESHNESS_MS = 15_000;
const CONTROL_FRAME_FALLBACK_MS = 2_500;
const FRAME_SYNC_CHECK_INTERVAL_MS = 900;
const FRAME_SYNC_FRESHNESS_MS = 3_000;
// Real camera glare lowers correlation even when the UI is identical. The
// verified mismatch sample scored 0.493; the same dialer with the arm parked
// scores about 0.555, so keep a conservative gap and require two matches.
const FRAME_SYNC_THRESHOLD = 0.54;
// Content correlation is useful telemetry, but the fixed camera can produce
// false mismatches on bright, low-detail screens. The verified calibration,
// fresh physical camera and hardware bounds remain hard gates; correlation is
// advisory unless an installation explicitly opts into strict enforcement.
const FRAME_SYNC_ENFORCED = process.env.SCREENHAND_FRAME_SYNC_ENFORCED === "1";
const TOUCH_CALIBRATION_HEARTBEAT_MS = 2_500;
const MAX_DEVICE_CLOCK_SKEW_MS = 60_000;
const SCREENHAND_PROTOCOL_VERSION = "2026-07-29";
const TOUCH_CALIBRATION_PAGE_URL = new URL(
  "../public/touch-calibration.html",
  import.meta.url,
);
const OPENAPI_URL = new URL("../public/openapi.json", import.meta.url);
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3012",
  "http://127.0.0.1:3012",
  "http://[::1]:3012",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REMOTE_CONTROL_ENABLED = process.env.SCREENHAND_CONTROL_PLANE_ALLOW_REMOTE === "1";
const CONTROL_PLANE_TOKEN = process.env.SCREENHAND_CONTROL_PLANE_TOKEN?.trim() ?? "";
const ACTION_RECEIPTS_PATH = resolve(
  process.env.SCREENHAND_ACTION_RECEIPTS_PATH ?? "build/runtime/action-receipts.json",
);
const AUDIT_LOG_PATH = resolve(
  process.env.SCREENHAND_AUDIT_LOG_PATH ?? "build/runtime/audit.jsonl",
);
const GENERAL_AGENT_MEMORY = new FileAgentMemory();
const GENERAL_AGENT_OBSERVERS = new Map<string, ScreenObserver>();
const GENERAL_AGENT_MODEL_PLANNER = OpenAIVisionPlanner.fromEnvironment();
const GENERAL_AGENT_ARTIFACT_DIRECTORY = resolve("build/runtime/general-agent");
const GENERAL_AGENT_WORLD_MODEL = SemanticWorldModel.fromJournalDirectory(
  GENERAL_AGENT_ARTIFACT_DIRECTORY,
);
const LOCAL_CONTROL_PLANE_URL = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`;
const generalAgentRuns = new GeneralAgentRunRegistry(async (request) => {
  const worldModel = await GENERAL_AGENT_WORLD_MODEL;
  let observer = GENERAL_AGENT_OBSERVERS.get(request.deviceId);
  if (!observer) {
    observer = new ScreenObserver();
    GENERAL_AGENT_OBSERVERS.set(request.deviceId, observer);
  }
  return new GeneralMobileAgent(
    new ScreenHandGeneralAgentClient(request.deviceId, LOCAL_CONTROL_PLANE_URL),
    {
      observer,
      memory: GENERAL_AGENT_MEMORY,
      modelPlanner: GENERAL_AGENT_MODEL_PLANNER ?? undefined,
      activeWorld: { artifactDirectory: GENERAL_AGENT_ARTIFACT_DIRECTORY },
      worldModel,
    },
  ).run(request);
});

if (!LOOPBACK_HOSTS.has(HOST)) {
  if (!REMOTE_CONTROL_ENABLED || CONTROL_PLANE_TOKEN.length < 32) {
    throw new Error(
      "Non-loopback control-plane binding requires SCREENHAND_CONTROL_PLANE_ALLOW_REMOTE=1 and a SCREENHAND_CONTROL_PLANE_TOKEN of at least 32 characters.",
    );
  }
}

let calibrationProfile = loadScreenHandCalibrationProfile();
const calibrationProfiles = new Map<string, NonNullable<typeof calibrationProfile>>();
if (calibrationProfile) {
  calibrationProfiles.set(calibrationProfile.deviceId, calibrationProfile);
}
const CALIBRATION_OUTPUT_PATH = resolve(
  process.env.SCREENHAND_CALIBRATION_OUTPUT_PATH ??
    "build/runtime/black-arm-calibration.json",
);
const CALIBRATION_DIRECTORY = process.env.SCREENHAND_CALIBRATION_DIRECTORY
  ? resolve(process.env.SCREENHAND_CALIBRATION_DIRECTORY)
  : null;

if (CALIBRATION_DIRECTORY) {
  try {
    for (const entry of await readdir(CALIBRATION_DIRECTORY, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const profile = parseScreenHandCalibrationProfile(JSON.parse(
          await readFile(resolve(CALIBRATION_DIRECTORY, entry.name), "utf8"),
        ));
        calibrationProfiles.set(profile.deviceId, profile);
      } catch (error) {
        console.warn(`Ignoring invalid calibration ${entry.name}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function calibrationOutputPath(deviceId: string) {
  if (!CALIBRATION_DIRECTORY) return CALIBRATION_OUTPUT_PATH;
  const safeId = deviceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return resolve(CALIBRATION_DIRECTORY, `${safeId}.json`);
}

type ScreenFrame = {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
  source: string;
  deviceId?: string;
  role?: "control" | "verification";
};

type StoredFrame = {
  frame: ScreenFrame;
  sequence: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
};

type DeviceFrameRuntime = {
  latestFrame: StoredFrame | null;
  latestControlFrame: StoredFrame | null;
  latestVerificationFrame: StoredFrame | null;
  frameSyncCheckRunning: boolean;
  frameSyncLastCheckedAt: number;
  frameSyncMatchStreak: number;
  frameSyncState: {
    status: "checking" | "synchronized" | "mismatch" | "camera_fallback";
    score: number | null;
    checkedAt: number | null;
    detail: string;
  };
};

type NodeCommand = {
  action:
    | "status"
    | "hold"
    | "home"
    | "resume"
    | "jog"
    | "hover_move"
    | "touch_down"
    | "touch_move"
    | "touch_up"
    | "touch_keepalive"
    | "tap"
    | "long_press"
    | "swipe"
    | "system_edge_swipe"
    | "system_edge_tap"
    | "input_text";
  params?: {
    axis?: string;
    distance?: number;
    feed?: number;
    x?: number;
    y?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    durationMs?: number;
    touchZ?: number;
    points?: Array<{ x: number; y: number }>;
    profileId?: string;
    sessionId?: string;
    mode?: "calibration";
    boundary?: SystemEdgeBoundary;
    confirmation?:
      | "CALIBRATED_SYSTEM_EDGE_GESTURE"
      | "CALIBRATED_SYSTEM_EDGE_TAP";
  };
};

type RemoteNode = {
  deviceId: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  state: unknown;
  lastEvent: unknown;
};

type CalibrationDraft = {
  deviceId: string;
  frame: { width: number; height: number; sequence: number };
  screen: { width: number; height: number };
  imagePoints: Array<{ x: number; y: number } | null>;
  machinePoints: Array<{ x: number; y: number } | null>;
  startedAt: string;
};

type TouchCalibrationSample = {
  id: number;
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
  viewportWidth: number;
  viewportHeight: number;
  screenX: number;
  screenY: number;
  screenWidth: number;
  screenHeight: number;
  normalizedScreenX: number;
  normalizedScreenY: number;
  coordinateSpaceVersion: 2;
  pointerType: string;
  capturedAt: number;
};

type ActionReceipt = {
  id: string;
  deviceId: string;
  idempotencyKey: string;
  actionType: ScreenHandSemanticAction["type"];
  status: "accepted" | "executing" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
  result: unknown;
  actor: string;
  requestId: string;
};

type ActionRequestContext = {
  actor: string;
  requestId: string;
};

let latestFrame: StoredFrame | null = null;
let latestVerificationFrame: StoredFrame | null = null;
const deviceFrameRuntimes = new Map<string, DeviceFrameRuntime>();
const recentFrames = new Map<number, StoredFrame>();
const remoteNodes = new Map<string, RemoteNode>();
const liveSubscribers = new Set<{
  socket: WebSocket;
  deviceId: string;
  raw: boolean;
}>();
let frameSequence = 0;
const calibrationDrafts = new Map<string, CalibrationDraft>();
const touchCalibrationSamples: TouchCalibrationSample[] = [];
let touchCalibrationSampleId = 0;
let touchCalibrationHeartbeatAt = 0;
const actionReceipts = new Map<string, ActionReceipt>();
const actionReceiptWaiters = new Map<string, Set<() => void>>();
const actionReceiptIdsByKey = new Map<string, string>();
const MAX_ACTION_RECEIPTS_PER_DEVICE = 512;
const MAX_ACTION_RECEIPTS = 2_048;
let receiptWriteQueue = Promise.resolve();
let auditWriteQueue = Promise.resolve();

function deviceFrameRuntime(deviceId: string): DeviceFrameRuntime {
  const key = deviceId.trim() || "unassigned-camera";
  const existing = deviceFrameRuntimes.get(key);
  if (existing) return existing;
  const created: DeviceFrameRuntime = {
    latestFrame: null,
    latestControlFrame: null,
    latestVerificationFrame: null,
    frameSyncCheckRunning: false,
    frameSyncLastCheckedAt: 0,
    frameSyncMatchStreak: 0,
    frameSyncState: {
      status: "checking",
      score: null,
      checkedAt: null,
      detail: "Waiting to compare the wired screen with the physical phone",
    },
  };
  deviceFrameRuntimes.set(key, created);
  return created;
}

function existingDeviceFrameRuntime(deviceId: string) {
  return deviceFrameRuntimes.get(deviceId.trim() || "unassigned-camera") ?? null;
}

function calibrationProfileFor(deviceId: string) {
  const profile = calibrationProfiles.get(deviceId) ?? null;
  if (!profile) return null;
  const geometryIssue = calibrationReadinessIssue({
    imagePoints: profile.imagePoints,
    machinePoints: profile.controlMachinePoints ?? profile.machinePoints,
  });
  return geometryIssue ? null : profile;
}

class ScreenHandApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function corsOrigin(request: IncomingMessage): string {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return "http://localhost:3012";
}

function setHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  status = 200,
  contentType = "application/json; charset=utf-8",
) {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Access-Control-Allow-Origin", corsOrigin(request));
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Request-Id, X-ScreenHand-Actor",
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "X-Request-Id",
    boundedHeader(request.headers["x-request-id"], randomUUID(), 160),
  );
}

function requestIsAuthorized(request: IncomingMessage) {
  if (LOOPBACK_HOSTS.has(HOST)) return true;
  return request.headers.authorization === `Bearer ${CONTROL_PLANE_TOKEN}`;
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  payload: unknown,
  status = 200,
) {
  setHeaders(request, response, status);
  response.end(JSON.stringify(payload));
}

async function readBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Frame data exceeds 14 MB. Reduce the camera resolution.");
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const bytes = await readBytes(request);
  if (!bytes.length) return {} as T;
  return JSON.parse(bytes.toString("utf8")) as T;
}

function validateFrame(frame: Partial<ScreenFrame>): ScreenFrame {
  if (
    typeof frame.dataUrl !== "string" ||
    !/^data:image\/(jpeg|png|webp);base64,/.test(frame.dataUrl)
  ) {
    throw new Error("Only JPEG, PNG, or WebP camera frames are accepted.");
  }
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    Number(frame.width) < 64 ||
    Number(frame.height) < 64 ||
    Number(frame.width) > 4096 ||
    Number(frame.height) > 4096
  ) {
    throw new Error("The frame dimensions are invalid.");
  }

  const receivedAt = Date.now();
  const deviceCapturedAt = Number(frame.capturedAt);
  const capturedAt =
    Number.isFinite(deviceCapturedAt) &&
    Math.abs(receivedAt - deviceCapturedAt) <= MAX_DEVICE_CLOCK_SKEW_MS
      ? deviceCapturedAt
      : receivedAt;

  return {
    dataUrl: frame.dataUrl,
    width: Math.round(Number(frame.width)),
    height: Math.round(Number(frame.height)),
    capturedAt,
    source:
      typeof frame.source === "string" && frame.source.trim()
        ? frame.source.trim().slice(0, 80)
        : "browser-camera",
    deviceId:
      typeof frame.deviceId === "string" && frame.deviceId.trim()
        ? frame.deviceId.trim().slice(0, 120)
        : undefined,
    role: frame.role === "verification" ? "verification" : "control",
  };
}

function frameGeometry(stored: StoredFrame | null) {
  if (!stored) return null;
  const profile = stored.frame.deviceId
    ? calibrationProfileFor(stored.frame.deviceId)
    : null;
  const profileMatches = Boolean(
    profile &&
      profile.frame.width === stored.frame.width &&
      profile.frame.height === stored.frame.height,
  );
  if (!profileMatches || !profile) {
    return {
      width: stored.frame.width,
      height: stored.frame.height,
      rawWidth: stored.frame.width,
      rawHeight: stored.frame.height,
      rectified: false,
      imagePoints: null,
      calibrationId: null,
    };
  }
  return {
    width: profile.screen.width,
    height: profile.screen.height,
    rawWidth: stored.frame.width,
    rawHeight: stored.frame.height,
    rectified: true,
    imagePoints: profile.imagePoints,
    calibrationId: profile.id,
  };
}

function publicFrame(stored: StoredFrame | null) {
  if (!stored) return null;
  const geometry = frameGeometry(stored);
  return {
    ...geometry,
    capturedAt: stored.frame.capturedAt,
    source: stored.frame.source,
    role: stored.frame.role ?? "control",
    sequence: stored.sequence,
    deviceId: stored.frame.deviceId,
  };
}

function liveFrameMetadata(stored: StoredFrame, raw = false) {
  const publicValue = raw
    ? {
        width: stored.frame.width,
        height: stored.frame.height,
        rawWidth: stored.frame.width,
        rawHeight: stored.frame.height,
        rectified: false,
        imagePoints: null,
        calibrationId: null,
        capturedAt: stored.frame.capturedAt,
        source: stored.frame.source,
        role: stored.frame.role ?? "control",
        sequence: stored.sequence,
        deviceId: stored.frame.deviceId,
      }
    : publicFrame(stored);
  return {
    type: "frame",
    ...publicValue,
    mimeType: stored.mimeType,
    byteLength: stored.bytes.length,
  };
}

function sendLiveFrame(socket: WebSocket, stored: StoredFrame, raw = false) {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 2_000_000) {
    return;
  }
  // Setup and calibration must see the physical verification frame exactly as
  // the camera captured it. The normal device wall keeps the rectified screen.
  socket.send(JSON.stringify(liveFrameMetadata(stored, raw)));
  socket.send(stored.bytes);
}

function broadcastLiveFrame(
  stored: StoredFrame,
  audience: "control" | "verification",
) {
  for (const subscriber of liveSubscribers) {
    if (
      subscriber.deviceId &&
      subscriber.deviceId !== stored.frame.deviceId
    ) {
      continue;
    }
    if ((audience === "verification") !== subscriber.raw) continue;
    sendLiveFrame(subscriber.socket, stored, subscriber.raw);
  }
}

function storeFrame(
  frame: ScreenFrame,
  mimeType: StoredFrame["mimeType"],
  bytes: Buffer,
) {
  frameSequence += 1;
  const stored: StoredFrame = {
    frame,
    sequence: frameSequence,
    mimeType,
    bytes,
  };
  const runtime = deviceFrameRuntime(frame.deviceId ?? "");
  if (frame.role === "verification") {
    runtime.latestVerificationFrame = stored;
    latestVerificationFrame = stored;
    broadcastLiveFrame(stored, "verification");
    if (!frameIsFresh(runtime.latestControlFrame, CONTROL_FRAME_FALLBACK_MS)) {
      runtime.latestFrame = stored;
      latestFrame = stored;
      broadcastLiveFrame(stored, "control");
    }
  } else {
    runtime.latestControlFrame = stored;
    runtime.latestFrame = stored;
    latestFrame = stored;
    broadcastLiveFrame(stored, "control");
  }
  recentFrames.set(frameSequence, stored);
  // Keep enough recent frames for a user to see a rendered frame and click it
  // even while the digital and verification streams continue advancing.
  while (recentFrames.size > 384) {
    const oldest = recentFrames.keys().next().value;
    if (typeof oldest === "number") recentFrames.delete(oldest);
  }
  scheduleFrameSyncCheck(frame.deviceId ?? "");
  return stored;
}

function scheduleFrameSyncCheck(deviceId: string) {
  const runtime = deviceFrameRuntime(deviceId);
  const profile = calibrationProfileFor(deviceId);
  if (runtime.frameSyncCheckRunning || !profile) return;
  const now = Date.now();
  if (now - runtime.frameSyncLastCheckedAt < FRAME_SYNC_CHECK_INTERVAL_MS) return;
  const digital = runtime.latestControlFrame;
  const physical = runtime.latestVerificationFrame;
  if (
    !digital ||
    !physical ||
    digital.frame.source !== "iphone-wired-usb-video" ||
    digital.frame.deviceId !== physical.frame.deviceId
  ) {
    if (runtime.latestFrame?.frame.role === "verification") {
      runtime.frameSyncState = {
        status: "camera_fallback",
        score: null,
        checkedAt: now,
        detail: "Using the physical camera as the authoritative control view",
      };
    }
    return;
  }
  runtime.frameSyncCheckRunning = true;
  runtime.frameSyncLastCheckedAt = now;
  setImmediate(() => {
    try {
      const result = comparePhoneFrames({
        digitalJpeg: digital.bytes,
        physicalJpeg: physical.bytes,
        physicalScreenPoints: profile.imagePoints,
      });
      const matched = result.score >= FRAME_SYNC_THRESHOLD;
      runtime.frameSyncMatchStreak = matched ? runtime.frameSyncMatchStreak + 1 : 0;
      const synchronized = matched && runtime.frameSyncMatchStreak >= 2;
      runtime.frameSyncState = {
        status: synchronized
          ? "synchronized"
          : matched
            ? "checking"
            : "mismatch",
        score: result.score,
        checkedAt: Date.now(),
        detail: synchronized
          ? "Wired screen and physical phone are synchronized"
          : matched
            ? "Confirming screen synchronization"
            : FRAME_SYNC_ENFORCED
              ? "Wired screen does not match the physical phone; touch is locked"
              : "Physical-camera correlation is low; wired control remains available",
      };
    } catch (error) {
      runtime.frameSyncMatchStreak = 0;
      runtime.frameSyncState = {
        status: "mismatch",
        score: null,
        checkedAt: Date.now(),
        detail: error instanceof Error
          ? `Unable to verify screen synchronization: ${error.message}`
          : "Unable to verify screen synchronization",
      };
    } finally {
      runtime.frameSyncCheckRunning = false;
    }
  });
}

function frameAgeMs(stored: StoredFrame | null) {
  if (!stored) return null;
  return Math.max(0, Date.now() - stored.frame.capturedAt);
}

function frameIsFresh(
  stored: StoredFrame | null,
  maxAgeMs = FRAME_FRESHNESS_MS,
) {
  const age = frameAgeMs(stored);
  return age !== null && age <= maxAgeMs;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestIsLoopback(request: IncomingMessage) {
  const address = String(request.socket.remoteAddress ?? "");
  return address === "127.0.0.1" || address === "::1" ||
    address === "::ffff:127.0.0.1";
}

function frameSyncEnforcedForDevice(deviceId: string) {
  const profile = calibrationProfileFor(deviceId);
  return FRAME_SYNC_ENFORCED || Boolean(
    profile?.placementCalibration?.method === "joint-camera-touch-v1",
  );
}

function tapReadiness(deviceId: string) {
  const runtime = existingDeviceFrameRuntime(deviceId);
  const profile = calibrationProfileFor(deviceId);
  const verificationCandidate = runtime?.latestVerificationFrame ?? null;
  const deviceFrame = frameIsFresh(verificationCandidate)
    ? verificationCandidate
    : runtime?.latestFrame ?? null;
  const frameReady = frameIsFresh(deviceFrame);
  if (!frameReady) {
    return {
      ready: false,
      reason: "A fresh camera frame is required.",
    };
  }
  const mainDeviceFrame = runtime?.latestFrame ?? null;
  if (mainDeviceFrame?.frame.source === "iphone-wired-usb-video") {
    const touchCalibrationPageActive =
      Date.now() - touchCalibrationHeartbeatAt <= TOUCH_CALIBRATION_HEARTBEAT_MS;
    const syncState = runtime?.frameSyncState;
    const syncAge = !syncState || syncState.checkedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - syncState.checkedAt;
    if (
      frameSyncEnforcedForDevice(deviceId) &&
      !touchCalibrationPageActive && (
        syncState?.status !== "synchronized" ||
        syncAge > FRAME_SYNC_FRESHNESS_MS
      )
    ) {
      return {
        ready: false,
        reason: syncState?.status === "mismatch"
          ? "The wired screen does not match the physical phone. Touch is locked to prevent a wrong tap."
          : "Verifying that the wired screen matches the physical phone before enabling touch.",
      };
    }
  }
  const profileReadiness = calibrationReadiness(profile, {
    deviceId,
    frame: deviceFrame
      ? {
          width: deviceFrame.frame.width,
          height: deviceFrame.frame.height,
        }
      : null,
  });
  if (!profileReadiness.ready) {
    return profileReadiness;
  }

  const node = remoteNodes.get(deviceId);
  if (!node || node.socket.readyState !== WebSocket.OPEN) {
    return {
      ready: false,
      reason: "The ScreenHand hardware node is offline.",
    };
  }
  const nodeState = objectValue(node.state);
  const grbl = objectValue(nodeState.grbl);
  const tapProfile = objectValue(grbl.tapProfile);
  const activeOperation = objectValue(grbl.activeOperation);
  if (
    nodeState.appVersion !== "0.1.15" ||
    tapProfile.id !== profile?.id
  ) {
    return {
      ready: false,
      reason: "A hardware node with the matching verified touch profile is required.",
    };
  }
  if (grbl.connected !== true) {
    return {
      ready: false,
      reason: "The CH340/GRBL hardware link is offline.",
    };
  }
  if (grbl.homed !== true) {
    return {
      ready: false,
      reason: "The arm must complete machine homing after this controller connection.",
    };
  }
  if (Object.keys(activeOperation).length > 0) {
    return {
      ready: false,
      reason: "Wait for the current physical operation to finish before moving the stylus.",
    };
  }
  if (grbl.state !== "Idle") {
    return {
      ready: false,
      reason: `The arm must be idle before touch; current controller state is ${String(grbl.state ?? "unknown")}.`,
    };
  }
  if (grbl.calibrationActive !== true) {
    return {
      ready: false,
      reason: "Enable the local calibration window on the hardware node.",
    };
  }
  if (Math.abs(Number(grbl.z)) > 0.02) {
    return {
      ready: false,
      reason: "The stylus must be at the verified hover height before tap.",
    };
  }
  return { ready: true };
}

function runtimePhoneNavigationAvailability(
  deviceId: string,
  profile: ScreenHandCalibrationProfile,
): PhoneNavigationAvailability {
  const nodeState = objectValue(remoteNodes.get(deviceId)?.state);
  const grbl = objectValue(nodeState.grbl);
  const edgeMachineBounds = machineBounds(grbl.calibrationMovementBounds);
  const availability = phoneNavigationAvailability(profile, { edgeMachineBounds });
  const tapProfile = objectValue(grbl.tapProfile);
  return Object.fromEntries(
    Object.entries(availability).map(([key, entry]) => {
      if (
        entry.available &&
        entry.strategy.endsWith("-gesture") &&
        tapProfile.supportsSwipe !== true
      ) {
        return [key, {
          available: false,
          reason: `${key} requires a verified hardware swipe profile.`,
        }];
      }
      return [key, entry];
    }),
  ) as PhoneNavigationAvailability;
}

function machineBounds(value: unknown): MachineBounds | null {
  const input = objectValue(value);
  const bounds = {
    minimumX: Number(input.minimumX),
    maximumX: Number(input.maximumX),
    minimumY: Number(input.minimumY),
    maximumY: Number(input.maximumY),
  };
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.minimumX >= bounds.maximumX ||
    bounds.minimumY >= bounds.maximumY
  ) return null;
  return bounds;
}

function screenHandCapabilities(deviceId: string) {
  const readiness = tapReadiness(deviceId);
  const profile = calibrationProfileFor(deviceId);
  const navigation = profile
    ? runtimePhoneNavigationAvailability(deviceId, profile)
    : null;
  const runtime = existingDeviceFrameRuntime(deviceId);
  const nodeState = objectValue(remoteNodes.get(deviceId)?.state);
  const grbl = objectValue(nodeState.grbl);
  const tapProfile = objectValue(grbl.tapProfile);
  const navigationReady = navigation !== null &&
    Object.values(navigation).some((entry) => entry.available);
  const liveTouch = objectValue(grbl.liveTouch);
  const liveTouchSupported = grbl.liveTouchSupported === true;
  const activeOperation = objectValue(grbl.activeOperation);
  const homeReady = grbl.connected === true &&
    grbl.homed !== true &&
    Object.keys(activeOperation).length === 0;
  const homeReason = grbl.connected !== true
    ? "The CH340/GRBL hardware link must be online before homing."
    : grbl.homed === true
      ? "Machine homing is already complete for this controller connection."
      : Object.keys(activeOperation).length > 0
        ? "Wait for the current physical operation to finish before homing."
        : "The controller is not ready to home.";
  const controllerState = String(grbl.state ?? "unknown");
  const resumeReady = grbl.connected === true &&
    grbl.homed === true &&
    controllerState.startsWith("Hold") &&
    Object.keys(activeOperation).length === 0;
  const resumeReason = grbl.connected !== true
    ? "The CH340/GRBL hardware link must be online before resuming."
    : grbl.homed !== true
      ? "The arm must be homed before resuming motion."
      : Object.keys(activeOperation).length > 0
        ? "Wait for the current physical operation to finish before resuming."
        : controllerState === "Idle"
          ? "The controller is already idle."
          : `Resume is only available from Hold; current controller state is ${controllerState}.`;
  const capabilities = buildScreenHandCapabilities({
    frameReady: frameIsFresh(
      runtime?.latestFrame ?? null,
    ),
    calibrationReady: readiness.ready,
    homeReady,
    homeReason,
    resumeReady,
    resumeReason,
    longPressReady:
      readiness.ready && tapProfile.supportsLongPress === true,
    swipeReady: readiness.ready && tapProfile.supportsSwipe === true,
    inputTextReady:
      readiness.ready && calibrationProfileFor(deviceId)?.screen.width === 720 &&
      calibrationProfileFor(deviceId)?.screen.height === 1_560 &&
      calibrationProfileFor(deviceId)?.keyboard?.strict === true,
    phoneKeyReady:
      readiness.ready && navigationReady,
  });
  if (!liveTouchSupported && liveTouch.active !== true) {
    const reason = String(
      grbl.liveTouchReason ??
      "The running hardware driver does not support continuous mouse contact.",
    );
    capabilities.actions.touch_down = { available: false, reason };
    capabilities.actions.touch_move = { available: false, reason };
  }
  if (!readiness.ready) {
    capabilities.actions.hover_move = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.touch_down = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.touch_move = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.tap = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.long_press = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.swipe = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.input_text = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.phone_key = {
      available: false,
      reason: readiness.reason,
    };
  } else if (navigation && !navigationReady) {
    const reasons = Object.entries(navigation)
      .filter(([, entry]) => !entry.available)
      .map(([key, entry]) => `${key}: ${"reason" in entry ? entry.reason : "unavailable"}`);
    capabilities.actions.phone_key = {
      available: false,
      reason: reasons.join(" "),
    };
  }
  if (liveTouch.active === true) {
    capabilities.actions.touch_down = {
      available: false,
      reason: "A live mouse contact is already active.",
    };
    capabilities.actions.touch_move = { available: true };
  }
  return capabilities;
}

function publicNodeState(state: unknown) {
  return objectValue(state);
}

function publicNodes() {
  return [...remoteNodes.values()]
    .map((node) => ({
      deviceId: node.deviceId,
      connected: node.socket.readyState === WebSocket.OPEN,
      connectedAt: node.connectedAt,
      lastSeenAt: node.lastSeenAt,
      ageMs: Math.max(0, Date.now() - node.lastSeenAt),
      state: publicNodeState(node.state),
      lastEvent: node.lastEvent,
    }))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}

function publicScreenHandDevice(node: RemoteNode) {
  const runtime = existingDeviceFrameRuntime(node.deviceId);
  const ownedFrame = runtime?.latestFrame ?? null;
  const nodeState = publicNodeState(node.state);
  return {
    id: node.deviceId,
    kind: "physical_robot",
    status: node.socket.readyState === WebSocket.OPEN ? "running" : "offline",
    connected: node.socket.readyState === WebSocket.OPEN,
    connectedAt: node.connectedAt,
    lastSeenAt: node.lastSeenAt,
    state: {
      ...nodeState,
      screenSync: {
        ...(runtime?.frameSyncState ?? {
          status: "checking",
          score: null,
          checkedAt: null,
          detail: "Waiting for device video",
        }),
        enforced: frameSyncEnforcedForDevice(node.deviceId),
      },
      touchMapping: publicTouchMapping(node.deviceId),
      touchCalibration: {
        pageActive:
          Date.now() - touchCalibrationHeartbeatAt <= TOUCH_CALIBRATION_HEARTBEAT_MS,
        sampleCount: touchCalibrationSamples.length,
      },
    },
    screen: publicFrame(ownedFrame),
    capabilities: screenHandCapabilities(node.deviceId),
  };
}

function publicTouchMapping(deviceId: string) {
  const profile = calibrationProfileFor(deviceId);
  if (!profile) return null;
  const screenCorners = [
    { x: 0, y: 0 },
    { x: profile.screen.width, y: 0 },
    { x: profile.screen.width, y: profile.screen.height },
    { x: 0, y: profile.screen.height },
  ] as const;
  const machinePoints = profile.controlMachinePoints ?? profile.machinePoints;
  const machineToScreen = homographyFromFourPoints(
    machinePoints,
    [...screenCorners],
  );
  const screenToMachine = homographyFromFourPoints(
    [...screenCorners],
    machinePoints,
  );
  const bounds = profile.safeMachineBounds;
  const isScreenPointReachable = (screenPoint: { x: number; y: number }) => {
    const point = projectPoint(screenToMachine, screenPoint);
    return point.x >= bounds.minimumX && point.x <= bounds.maximumX &&
      point.y >= bounds.minimumY && point.y <= bounds.maximumY;
  };
  const safeMachinePolygon = [
    { x: bounds.maximumX, y: bounds.maximumY },
    { x: bounds.minimumX, y: bounds.maximumY },
    { x: bounds.minimumX, y: bounds.minimumY },
    { x: bounds.maximumX, y: bounds.minimumY },
  ] as const;
  const reachableScreenPolygon = safeMachinePolygon.map((point) => {
    const mapped = projectPoint(machineToScreen, point);
    return {
      x: Math.round(mapped.x * 1000) / 1000,
      y: Math.round(mapped.y * 1000) / 1000,
    };
  });
  const fullScreenReachable = machinePoints.every((point) =>
    point.x >= bounds.minimumX && point.x <= bounds.maximumX &&
    point.y >= bounds.minimumY && point.y <= bounds.maximumY
  );
  // The first/last ~80 px are iOS system chrome rather than normal app
  // content. Report app coverage separately so a verified app-sized touch
  // surface is not presented as a large, dangerous-looking partial screen.
  const appScreenBounds = {
    left: 12,
    top: 82,
    right: profile.screen.width - 12,
    bottom: profile.screen.height - 92,
  };
  const appScreenCorners = [
    { x: appScreenBounds.left, y: appScreenBounds.top },
    { x: appScreenBounds.right, y: appScreenBounds.top },
    { x: appScreenBounds.right, y: appScreenBounds.bottom },
    { x: appScreenBounds.left, y: appScreenBounds.bottom },
  ] as const;
  const appAreaReachable = appScreenCorners.every((screenPoint) => {
    return isScreenPointReachable(screenPoint);
  });
  const systemChromeTargets = {
    bottomAddressBar: { x: profile.screen.width * 0.5, y: profile.screen.height * 0.865 },
    bottomToolbarLeft: { x: profile.screen.width * 0.18, y: profile.screen.height * 0.92 },
    bottomToolbarCenter: { x: profile.screen.width * 0.5, y: profile.screen.height * 0.92 },
    bottomToolbarRight: { x: profile.screen.width * 0.82, y: profile.screen.height * 0.92 },
    homeGestureStart: { x: profile.screen.width * 0.5, y: profile.screen.height * 0.96 },
  };
  const systemChromeReachability = Object.fromEntries(
    Object.entries(systemChromeTargets).map(([name, point]) => [
      name,
      isScreenPointReachable(point),
    ]),
  );
  const systemNavigation = runtimePhoneNavigationAvailability(deviceId, profile);
  return {
    calibrationId: profile.id,
    screen: profile.screen,
    coordinateSpace: "full_physical_screen",
    includesSystemChrome: true,
    safeMachineBounds: bounds,
    reachableScreenPolygon,
    fullScreenReachable,
    appAreaReachable,
    appScreenBounds,
    systemChromeReachability,
    systemNavigation,
    frameSyncEnforced: frameSyncEnforcedForDevice(deviceId),
  };
}

function publicScreenHandDeviceById(deviceId: string) {
  const node = remoteNodes.get(deviceId);
  if (node) return publicScreenHandDevice(node);
  const ownedFrame = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
  if (!ownedFrame) return null;
  return {
    id: deviceId,
    kind: "physical_android",
    status: "offline",
    connected: false,
    connectedAt: null,
    lastSeenAt: null,
    state: null,
    screen: publicFrame(ownedFrame),
    capabilities: screenHandCapabilities(deviceId),
  };
}

function screenHandDeviceIds(): string[] {
  const ids = new Set(remoteNodes.keys());
  for (const key of deviceFrameRuntimes.keys()) {
    if (key !== "unassigned-camera") ids.add(key);
  }
  return [...ids].sort();
}

function validateNodeCommand(value: Partial<NodeCommand>): NodeCommand {
  if (![
    "status",
    "hold",
    "home",
    "resume",
    "jog",
    "hover_move",
    "touch_down",
    "touch_move",
    "touch_up",
    "touch_keepalive",
    "tap",
    "long_press",
    "swipe",
    "system_edge_swipe",
    "system_edge_tap",
  ].includes(String(value.action))) {
    throw new Error(
      "The device node only accepts status, hold, home, resume, bounded jog, hover, and bounded touch actions.",
    );
  }

  const action = value.action as NodeCommand["action"];
  if (action === "touch_up" || action === "touch_keepalive") {
    const sessionId = String(value.params?.sessionId ?? "").trim();
    if (!sessionId || sessionId.length > 160) {
      throw new Error(`${action} sessionId is invalid.`);
    }
    return { action, params: { sessionId } };
  }
  if (action === "hover_move" || action === "touch_down" || action === "touch_move") {
    const x = Number(value.params?.x);
    const y = Number(value.params?.y);
    const profileId = String(value.params?.profileId ?? "").trim();
    if (!Number.isFinite(x) || x < -300 || x > 300) {
      throw new Error(`${action} x is outside the hardware safety range.`);
    }
    if (!Number.isFinite(y) || y < -300 || y > 300) {
      throw new Error(`${action} y is outside the hardware safety range.`);
    }
    if (!profileId || profileId.length > 160) {
      throw new Error(`${action} profileId is invalid.`);
    }
    if (action === "hover_move") return { action, params: { x, y, profileId } };
    const sessionId = String(value.params?.sessionId ?? "").trim();
    if (!sessionId || sessionId.length > 160) {
      throw new Error(`${action} sessionId is invalid.`);
    }
    const touchZ = value.params?.touchZ === undefined
      ? undefined
      : Number(value.params.touchZ);
    if (touchZ !== undefined && (!Number.isFinite(touchZ) || touchZ < -20 || touchZ > 20)) {
      throw new Error(`${action} touchZ is outside the hardware safety range.`);
    }
    return {
      action,
      params: {
        x,
        y,
        profileId,
        sessionId,
        ...(touchZ === undefined ? {} : { touchZ }),
      },
    };
  }
  if (action === "system_edge_tap") {
    const x = Number(value.params?.x);
    const y = Number(value.params?.y);
    const durationMs = Number(value.params?.durationMs ?? 90);
    const profileId = String(value.params?.profileId ?? "").trim();
    const boundary = String(value.params?.boundary ?? "") as SystemEdgeBoundary;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("system_edge_tap coordinates are invalid.");
    }
    if (!Number.isInteger(durationMs) || durationMs < 30 || durationMs > 250) {
      throw new Error("system_edge_tap durationMs must be between 30 and 250 ms.");
    }
    if (!profileId || profileId.length > 160) {
      throw new Error("system_edge_tap profileId is invalid.");
    }
    if (!new Set(["minimumX", "maximumX", "minimumY", "maximumY"]).has(boundary)) {
      throw new Error("system_edge_tap boundary is invalid.");
    }
    if (value.params?.confirmation !== "CALIBRATED_SYSTEM_EDGE_TAP") {
      throw new Error("system_edge_tap confirmation is required.");
    }
    return {
      action,
      params: {
        x,
        y,
        durationMs,
        profileId,
        boundary,
        confirmation: "CALIBRATED_SYSTEM_EDGE_TAP",
      },
    };
  }
  if (action === "tap" || action === "long_press") {
    const x = Number(value.params?.x);
    const y = Number(value.params?.y);
    const durationMs = Number(
      value.params?.durationMs ?? (action === "tap" ? 40 : 800),
    );
    const profileId = String(value.params?.profileId ?? "").trim();
    if (!Number.isFinite(x) || x < -20 || x > 38) {
      throw new Error("tap x must be between -20 and 38 mm.");
    }
    if (!Number.isFinite(y) || y < -90 || y > 30) {
      throw new Error("tap y must be between -90 and 30 mm.");
    }
    if (!profileId || profileId.length > 160) {
      throw new Error(`${action} profileId is invalid.`);
    }
    if (
      !Number.isInteger(durationMs) ||
      durationMs < (action === "tap" ? 30 : 500) ||
      durationMs > (action === "tap" ? 250 : 5_000)
    ) {
      throw new Error(`${action} durationMs is outside the hardware range.`);
    }
    return { action, params: { x, y, profileId, durationMs } };
  }
  if (action === "swipe" || action === "system_edge_swipe") {
    const startX = Number(value.params?.startX);
    const startY = Number(value.params?.startY);
    const endX = Number(value.params?.endX);
    const endY = Number(value.params?.endY);
    const durationMs = Number(value.params?.durationMs ?? 500);
    const profileId = String(value.params?.profileId ?? "").trim();
    for (const [label, coordinate, minimum, maximum] of [
      ["startX", startX, -20, 38],
      ["endX", endX, -20, 38],
      ["startY", startY, -90, 30],
      ["endY", endY, -90, 30],
    ] as const) {
      if (
        !Number.isFinite(coordinate) ||
        coordinate < minimum ||
        coordinate > maximum
      ) {
        throw new Error(`swipe ${label} is outside the hardware safety range.`);
      }
    }
    if (!profileId || profileId.length > 160) {
      throw new Error(`${action} profileId is invalid.`);
    }
    if (!Number.isInteger(durationMs) || durationMs < 250 || durationMs > 3_000) {
      throw new Error(`${action} durationMs must be between 250 and 3000 ms.`);
    }
    if (action === "system_edge_swipe") {
      const boundary = String(value.params?.boundary ?? "") as SystemEdgeBoundary;
      if (!new Set(["minimumX", "maximumX", "minimumY", "maximumY"]).has(boundary)) {
        throw new Error("system_edge_swipe boundary is invalid.");
      }
      if (value.params?.confirmation !== "CALIBRATED_SYSTEM_EDGE_GESTURE") {
        throw new Error("system_edge_swipe confirmation is required.");
      }
      return {
        action,
        params: {
          startX,
          startY,
          endX,
          endY,
          durationMs,
          profileId,
          boundary,
          confirmation: "CALIBRATED_SYSTEM_EDGE_GESTURE",
        },
      };
    }
    return {
      action,
      params: { startX, startY, endX, endY, durationMs, profileId },
    };
  }
  if (action !== "jog") return { action };

  const axis = String(value.params?.axis ?? "").toUpperCase();
  const distance = Number(value.params?.distance);
  const feed = Number(value.params?.feed ?? 60);
  if (!["X", "Y", "Z"].includes(axis)) {
    throw new Error("jog axis must be X, Y, or Z.");
  }
  if (!Number.isFinite(distance) || distance === 0) {
    throw new Error("jog distance must be a non-zero number.");
  }
  if (!Number.isFinite(feed) || feed < 30 || feed > 600) {
    throw new Error("jog feed must be between 30 and 600 mm/min.");
  }

  return { action, params: { axis, distance, feed } };
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "The request body is not valid JSON.";
  if (error instanceof Error) return error.message;
  return "Unknown error.";
}

function publicActionReceipt(receipt: ActionReceipt) {
  return {
    ...receipt,
    elapsedMs: Math.max(
      0,
      (receipt.completedAt ?? receipt.updatedAt) - receipt.createdAt,
    ),
  };
}

function boundedHeader(value: string | string[] | undefined, fallback: string, max: number) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return String(candidate ?? "").trim().slice(0, max) || fallback;
}

function actionRequestContext(request: IncomingMessage): ActionRequestContext {
  return {
    actor: boundedHeader(request.headers["x-screenhand-actor"], "local-api", 120),
    requestId: boundedHeader(request.headers["x-request-id"], randomUUID(), 160),
  };
}

function semanticCommandId() {
  return `action-${randomUUID()}`;
}

function auditReceipt(event: "created" | "updated" | "recovered", receipt: ActionReceipt) {
  const entry = `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    receiptId: receipt.id,
    deviceId: receipt.deviceId,
    idempotencyKey: receipt.idempotencyKey,
    actionType: receipt.actionType,
    status: receipt.status,
    actor: receipt.actor,
    requestId: receipt.requestId,
    error: receipt.error,
  })}\n`;
  auditWriteQueue = auditWriteQueue
    .then(async () => {
      await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
      await appendFile(AUDIT_LOG_PATH, entry, "utf8");
    })
    .catch((error) => console.error(`Unable to append ScreenHand audit log: ${errorMessage(error)}`));
}

function persistActionReceipts() {
  const snapshot = `${JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    receipts: [...actionReceipts.values()],
  }, null, 2)}\n`;
  receiptWriteQueue = receiptWriteQueue
    .then(async () => {
      await mkdir(dirname(ACTION_RECEIPTS_PATH), { recursive: true });
      const temporaryPath = `${ACTION_RECEIPTS_PATH}.${process.pid}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, ACTION_RECEIPTS_PATH);
    })
    .catch((error) => console.error(`Unable to persist ScreenHand receipts: ${errorMessage(error)}`));
}

async function restoreActionReceipts() {
  try {
    const snapshot = JSON.parse(await readFile(ACTION_RECEIPTS_PATH, "utf8")) as {
      receipts?: ActionReceipt[];
    };
    for (const stored of snapshot.receipts ?? []) {
      if (!stored?.id || !stored.deviceId || !stored.idempotencyKey) continue;
      const receipt: ActionReceipt = {
        ...stored,
        actor: stored.actor || "unknown",
        requestId: stored.requestId || "unknown",
      };
      if (receipt.status === "accepted" || receipt.status === "executing") {
        receipt.status = "failed";
        receipt.updatedAt = Date.now();
        receipt.completedAt = receipt.updatedAt;
        receipt.error = "The control plane restarted before final hardware confirmation; verify the device before retrying.";
        auditReceipt("recovered", receipt);
      }
      actionReceipts.set(receipt.id, receipt);
      actionReceiptIdsByKey.set(
        actionReceiptKey(receipt.deviceId, receipt.idempotencyKey),
        receipt.id,
      );
    }
    pruneActionReceipts();
    persistActionReceipts();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Unable to restore ScreenHand receipts: ${errorMessage(error)}`);
    }
  }
}

function actionReceiptKey(deviceId: string, idempotencyKey: string) {
  return `${deviceId}\u0000${idempotencyKey}`;
}

function existingActionReceipt(deviceId: string, idempotencyKey: string) {
  const id = actionReceiptIdsByKey.get(
    actionReceiptKey(deviceId, idempotencyKey),
  );
  return id ? actionReceipts.get(id) ?? null : null;
}

function deleteActionReceipt(receipt: ActionReceipt) {
  actionReceipts.delete(receipt.id);
  actionReceiptIdsByKey.delete(
    actionReceiptKey(receipt.deviceId, receipt.idempotencyKey),
  );
}

function pruneActionReceipts() {
  const ids = receiptIdsToPrune(
    [...actionReceipts.values()],
    MAX_ACTION_RECEIPTS_PER_DEVICE,
    MAX_ACTION_RECEIPTS,
  );
  for (const id of ids) {
    const receipt = actionReceipts.get(id);
    if (receipt) deleteActionReceipt(receipt);
  }
}

function createActionReceipt(input: {
  id: string;
  deviceId: string;
  idempotencyKey: string;
  actionType: ScreenHandSemanticAction["type"];
  result?: unknown;
  actor: string;
  requestId: string;
}) {
  const existing = existingActionReceipt(input.deviceId, input.idempotencyKey);
  if (existing) return existing;
  const now = Date.now();
  const receipt: ActionReceipt = {
    id: input.id,
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey,
    actionType: input.actionType,
    status: "accepted",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    result: input.result ?? null,
    actor: input.actor,
    requestId: input.requestId,
  };
  actionReceipts.set(receipt.id, receipt);
  actionReceiptIdsByKey.set(
    actionReceiptKey(receipt.deviceId, receipt.idempotencyKey),
    receipt.id,
  );
  pruneActionReceipts();
  persistActionReceipts();
  auditReceipt("created", receipt);
  return receipt;
}

function updateActionReceipt(
  id: string,
  status: ActionReceipt["status"],
  input: { error?: string | null; result?: unknown } = {},
) {
  const receipt = actionReceipts.get(id);
  if (!receipt) return null;
  if (receipt.status === "completed" || receipt.status === "failed") {
    return receipt;
  }
  const now = Date.now();
  receipt.status = status;
  receipt.updatedAt = now;
  receipt.completedAt = status === "completed" || status === "failed"
    ? now
    : null;
  if ("error" in input) receipt.error = input.error ?? null;
  if ("result" in input) {
    const planned = objectValue(receipt.result);
    const operation = [
      "hover_move",
      "touch_down",
      "touch_move",
      "touch_up",
      "touch_keepalive",
    ].includes(receipt.actionType)
      ? compactHoverReceiptOperation(input.result)
      : input.result;
    receipt.result = Object.keys(planned).length > 0 && "calibrationId" in planned
      ? { ...planned, operation }
      : operation;
  }
  persistActionReceipts();
  auditReceipt("updated", receipt);
  if (receipt.status === "completed" || receipt.status === "failed") {
    const waiters = actionReceiptWaiters.get(receipt.id);
    actionReceiptWaiters.delete(receipt.id);
    for (const finish of waiters ?? []) finish();
  }
  return receipt;
}

function waitForFinalActionReceipt(
  receipt: ActionReceipt,
  waitMs: number,
  request: IncomingMessage,
) {
  if (
    waitMs <= 0 || receipt.status === "completed" || receipt.status === "failed"
  ) return Promise.resolve();
  return new Promise<void>((resolveWait) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.removeListener("aborted", finish);
      const waiters = actionReceiptWaiters.get(receipt.id);
      waiters?.delete(finish);
      if (waiters?.size === 0) actionReceiptWaiters.delete(receipt.id);
      resolveWait();
    };
    const timer = setTimeout(finish, waitMs);
    request.once("aborted", finish);
    const waiters = actionReceiptWaiters.get(receipt.id) ?? new Set<() => void>();
    waiters.add(finish);
    actionReceiptWaiters.set(receipt.id, waiters);
  });
}

await restoreActionReceipts();

function grblStateFrom(value: unknown) {
  const state = objectValue(value);
  const nested = objectValue(state.grbl);
  return Object.keys(nested).length > 0 ? nested : state;
}

function reconcileOperationState(deviceId: string, stateValue: unknown) {
  const grbl = grblStateFrom(stateValue);
  const active = objectValue(grbl.activeOperation);
  const last = objectValue(grbl.lastOperation);
  const activeDecision = operationReceiptDecision(active);
  const lastDecision = operationReceiptDecision(last);
  if (activeDecision) {
    const receipt = actionReceipts.get(activeDecision.id);
    if (receipt?.deviceId === deviceId) {
      updateActionReceipt(activeDecision.id, activeDecision.status, {
        error: activeDecision.error,
        result: activeDecision.result,
      });
    }
  }
  if (lastDecision) {
    const receipt = actionReceipts.get(lastDecision.id);
    if (receipt?.deviceId !== deviceId) return;
    updateActionReceipt(lastDecision.id, lastDecision.status, {
      error: lastDecision.error,
      result: lastDecision.result,
    });
  }
}

function reconcileCommandResult(deviceId: string, payloadValue: unknown) {
  const payload = objectValue(payloadValue);
  const decision = commandResultReceiptDecision(payload);
  if (!decision) return;
  const receipt = actionReceipts.get(decision.id);
  if (!receipt || receipt.deviceId !== deviceId) return;
  reconcileOperationState(deviceId, payload.state);
  updateActionReceipt(decision.id, decision.status, {
    error: decision.error,
    result: decision.result,
  });
}

function failOpenReceipts(deviceId: string, reason: string) {
  for (const receipt of actionReceipts.values()) {
    if (
      receipt.deviceId === deviceId &&
      (receipt.status === "accepted" || receipt.status === "executing")
    ) {
      updateActionReceipt(receipt.id, "failed", { error: reason });
    }
  }
}

function sendNodeEnvelope(node: RemoteNode, input: {
  id: string;
  action: NodeCommand["action"];
  params?: NodeCommand["params"];
}) {
  const envelope = {
    type: "command",
    id: input.id.slice(0, 160),
    deviceId: node.deviceId,
    expiresAt: Date.now() + 5_000,
    ttlMs: 5_000,
    action: input.action,
    ...(input.params ? { params: input.params } : {}),
  };
  node.socket.send(JSON.stringify(envelope));
  return envelope;
}

function requireOnlineNode(deviceId: string): RemoteNode {
  const node = remoteNodes.get(deviceId);
  if (!node || node.socket.readyState !== WebSocket.OPEN) {
    throw new ScreenHandApiError(
      `ScreenHand node is offline: ${deviceId}`,
      503,
      "DEVICE_OFFLINE",
    );
  }
  if (Date.now() - node.lastSeenAt > 6_000) {
    throw new ScreenHandApiError(
      `ScreenHand node heartbeat is stale: ${deviceId}`,
      503,
      "DEVICE_HEARTBEAT_STALE",
    );
  }
  return node;
}

function unavailableAction(
  deviceId: string,
  action: ScreenHandSemanticAction,
): never {
  const availability = screenHandCapabilities(deviceId).actions[action.type];
  throw new ScreenHandApiError(
    availability.reason ?? `Action ${action.type} is not available.`,
    409,
    action.type === "hover_move" || action.type === "touch_down" || action.type === "touch_move" || action.type === "tap" || action.type === "long_press" || action.type === "swipe" || action.type === "input_text" || action.type === "phone_key"
      ? "CALIBRATION_REQUIRED"
      : "ACTION_UNAVAILABLE",
  );
}

async function executeSemanticAction(
  deviceId: string,
  input: ReturnType<typeof parseScreenHandActionEnvelope>,
  context: ActionRequestContext,
) {
  const { action, idempotencyKey } = input;
  const profile = calibrationProfileFor(deviceId);

  const priorReceipt = existingActionReceipt(deviceId, idempotencyKey);
  if (priorReceipt) {
    return {
      status: priorReceipt.status,
      action,
      commandId: priorReceipt.id,
      receipt: publicActionReceipt(priorReceipt),
      replayed: true,
    };
  }

  const node = requireOnlineNode(deviceId);

  if (action.type === "status") {
    return {
      status: "completed",
      action,
      device: publicScreenHandDevice(node),
    };
  }
  if (action.type === "wait") {
    await new Promise((resolve) => setTimeout(resolve, action.durationMs));
    return {
      status: "completed",
      action,
      waitedMs: action.durationMs,
    };
  }
  if (action.type === "hold") {
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "hold",
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
    });
    return {
      status: "accepted",
      action,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (action.type === "resume") {
    const availability = screenHandCapabilities(deviceId).actions.resume;
    if (!availability.available) unavailableAction(deviceId, action);
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "resume",
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
    });
    return {
      status: "accepted",
      action,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (action.type === "home") {
    const availability = screenHandCapabilities(deviceId).actions.home;
    if (!availability.available) unavailableAction(deviceId, action);
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "home",
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
    });
    return {
      status: "accepted",
      action,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (action.type === "touch_up" || action.type === "touch_keepalive") {
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: action.type,
      params: { sessionId: action.sessionId },
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
    });
    return {
      status: "accepted",
      action,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  const availability = screenHandCapabilities(deviceId).actions[action.type];
  if (!availability.available) unavailableAction(deviceId, action);

  if (action.type === "input_text" && profile) {
    const stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
    if (!stored || !frameIsFresh(stored)) {
      throw new ScreenHandApiError(
        "A fresh phone frame is required before physical text entry.",
        409,
        "FRAME_UNAVAILABLE",
      );
    }
    const geometry = frameGeometry(stored);
    if (!geometry || geometry.width !== 720 || geometry.height !== 1_560) {
      throw new ScreenHandApiError(
        "The installed keyboard map requires a calibrated 720×1560 iPhone screen.",
        409,
        "KEYBOARD_PROFILE_MISMATCH",
      );
    }
    const canonical = await renderModelScreenFrame(stored.bytes, geometry, 2_048);
    const pixelConfidence = iosEnglishKeyboardConfidence(canonical.bytes);
    const keyboardVisibleFromPixels = iosEnglishKeyboardVisible(canonical.bytes);
    const keyboardOcr = await recognizeVisionText(
      `data:image/jpeg;base64,${canonical.bytes.toString("base64")}`,
    );
    if (keyboardUsesNonLatinInput(keyboardOcr)) {
      throw new ScreenHandApiError(
        "The visible keyboard is not in Latin input mode; switch keyboard language before typing.",
        409,
        "KEYBOARD_LANGUAGE_MISMATCH",
      );
    }
    const keyboardVisibleFromOcr = looksLikeIosKeyboard(keyboardOcr);
    if (!keyboardVisibleFromPixels && !keyboardVisibleFromOcr) {
      const ocrEvidence = iosKeyboardOcrEvidence(keyboardOcr);
      process.stderr.write(
        `[keyboard-gate] rejected frame=${stored.sequence} ` +
          `pixelConfidence=${pixelConfidence.toFixed(3)} ` +
          `ocrItems=${keyboardOcr?.items.length ?? 0} ` +
          `evidence=${JSON.stringify(ocrEvidence)}\n`,
      );
      throw new ScreenHandApiError(
        "The calibrated iOS English keyboard is not visibly focused; no key was pressed.",
        409,
        "KEYBOARD_NOT_VISIBLE",
      );
    }
    const keyboardPoints = iosEnglishKeyboardSequence(
      action.text,
      profile.keyboard
        ? { points: profile.keyboard.points, strict: profile.keyboard.strict }
        : undefined,
      { shiftActive: iosKeyboardShiftActive(keyboardOcr) },
    );
    const machinePoints = keyboardPoints.map((point) =>
      calibratedScreenPoint(profile, point)
    );
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "input_text",
      params: {
        points: machinePoints,
        durationMs: 55,
        ...(action.touchZ === undefined ? {} : { touchZ: action.touchZ }),
        profileId: profile.id,
      },
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
      result: {
        characterCount: action.text.length,
        physicalTapCount: machinePoints.length,
        calibrationId: profile.id,
      },
    });
    return {
      status: "accepted",
      action,
      characterCount: action.text.length,
      physicalTapCount: machinePoints.length,
      calibrationId: profile.id,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (action.type === "phone_key" && profile) {
    let backControl = null;
    const nodeState = objectValue(node.state);
    const grbl = objectValue(nodeState.grbl);
    const tapProfile = objectValue(grbl.tapProfile);
    if (action.key === "keyboard_next") {
      let keyboardPlan;
      try {
        keyboardPlan = planKeyboardNext(
          profile,
          machineBounds(grbl.calibrationMovementBounds),
        );
      } catch (error) {
        if (error instanceof PhoneNavigationUnavailableError) {
          throw new ScreenHandApiError(error.message, 409, error.code);
        }
        throw error;
      }
      const command = sendNodeEnvelope(node, {
        id: semanticCommandId(),
        action: "system_edge_tap",
        params: {
          x: keyboardPlan.target.machinePoint.x,
          y: keyboardPlan.target.machinePoint.y,
          durationMs: keyboardPlan.durationMs,
          touchZ: Number.isFinite(Number(tapProfile.minimumTouchZ))
            ? Number(tapProfile.minimumTouchZ)
            : profile.tap.touchZ,
          profileId: profile.id,
          boundary: keyboardPlan.boundary,
          confirmation: "CALIBRATED_SYSTEM_EDGE_TAP",
        },
      });
      const receipt = createActionReceipt({
        id: command.id,
        deviceId,
        idempotencyKey,
        actionType: action.type,
        ...context,
        result: {
          key: action.key,
          physicalGesture: keyboardPlan.action,
          strategy: keyboardPlan.strategy,
          screenPoint: keyboardPlan.target.screenPoint,
          machinePoint: keyboardPlan.target.machinePoint,
          calibrationId: profile.id,
        },
      });
      return {
        status: "accepted",
        action,
        physicalGesture: keyboardPlan.action,
        strategy: keyboardPlan.strategy,
        screenPoint: keyboardPlan.target.screenPoint,
        machinePoint: keyboardPlan.target.machinePoint,
        calibrationId: profile.id,
        commandId: command.id,
        receipt: publicActionReceipt(receipt),
      };
    }
    if (action.key === "back") {
      const stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
      const geometry = stored ? frameGeometry(stored) : null;
      if (
        stored && geometry &&
        geometry.width === profile.screen.width &&
        geometry.height === profile.screen.height
      ) {
        try {
          const canonical = await renderModelScreenFrame(
            stored.bytes,
            geometry,
            4_096,
          );
          backControl = await detectBackControl(canonical.bytes, profile.screen);
        } catch {
          // Image decoding failure leaves the calibrated edge gesture fallback.
        }
      }
    }
    let navigationPlan;
    try {
      navigationPlan = planPhoneNavigation(profile, action.key, {
        backControl,
        edgeMachineBounds: machineBounds(grbl.calibrationMovementBounds),
      });
    } catch (error) {
      if (error instanceof PhoneNavigationUnavailableError) {
        throw new ScreenHandApiError(
          error.message,
          409,
          error.code,
        );
      }
      throw error;
    }
    if (
      navigationPlan.action === "swipe" ||
      navigationPlan.action === "system_edge_swipe"
    ) {
      if (tapProfile.supportsSwipe !== true) {
        throw new ScreenHandApiError(
          `The ${action.key} navigation plan requires a verified hardware swipe profile.`,
          409,
          "PHONE_NAVIGATION_UNAVAILABLE",
        );
      }
    }
    const params = navigationPlan.action === "tap"
      ? {
          ...navigationPlan.machinePoint,
          durationMs: navigationPlan.durationMs,
          touchZ: profile.tap.touchZ,
          profileId: profile.id,
        }
      : {
          startX: navigationPlan.start.machinePoint.x,
          startY: navigationPlan.start.machinePoint.y,
          endX: navigationPlan.end.machinePoint.x,
          endY: navigationPlan.end.machinePoint.y,
          durationMs: navigationPlan.durationMs,
          touchZ: navigationPlan.action === "system_edge_swipe" &&
              Number.isFinite(Number(tapProfile.minimumTouchZ))
            ? Number(tapProfile.minimumTouchZ)
            : profile.tap.touchZ,
          profileId: profile.id,
          ...(navigationPlan.action === "system_edge_swipe"
            ? {
              boundary: navigationPlan.boundary,
              confirmation: "CALIBRATED_SYSTEM_EDGE_GESTURE" as const,
            }
            : {}),
        };
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: navigationPlan.action,
      params,
    });
    const navigationResult = navigationPlan.action === "tap"
      ? {
          machinePoint: navigationPlan.machinePoint,
          ...(navigationPlan.screenPoint
            ? { screenPoint: navigationPlan.screenPoint }
            : {}),
        }
      : {
          screenStart: navigationPlan.start.screenPoint,
          screenEnd: navigationPlan.end.screenPoint,
          machineStart: navigationPlan.start.machinePoint,
          machineEnd: navigationPlan.end.machinePoint,
        };
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
      result: {
        key: action.key,
        physicalGesture: navigationPlan.action,
        strategy: navigationPlan.strategy,
        ...navigationResult,
        calibrationId: profile.id,
      },
    });
    return {
      status: "accepted",
      action,
      physicalGesture: navigationPlan.action,
      strategy: navigationPlan.strategy,
      ...navigationResult,
      calibrationId: profile.id,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (
    action.type === "hover_move" ||
    action.type === "touch_down" ||
    action.type === "touch_move" ||
    action.type === "tap" ||
    action.type === "long_press" ||
    action.type === "swipe"
  ) {
    const plannedStoredFrame = recentFrames.get(action.frameSequence);
    const plannedFrame = plannedStoredFrame?.frame;
    const plannedFrameAgeMs = plannedFrame
      ? Math.max(0, Date.now() - plannedFrame.capturedAt)
      : Number.POSITIVE_INFINITY;
    if (
      !plannedFrame ||
      plannedFrame.deviceId !== deviceId ||
      plannedFrameAgeMs > 5_000
    ) {
      throw new ScreenHandApiError(
        "The requested touch action was planned from a stale camera frame.",
        409,
        "STALE_FRAME",
      );
    }
    if (
      !plannedStoredFrame ||
      action.viewport.width !== frameGeometry(plannedStoredFrame)?.width ||
      action.viewport.height !== frameGeometry(plannedStoredFrame)?.height
    ) {
      throw new ScreenHandApiError(
        "The touch viewport does not match the referenced camera frame.",
        409,
        "FRAME_VIEWPORT_MISMATCH",
      );
    }
    const normalized = action.type === "swipe"
      ? {
          start: normalizeScreenHandPoint(action.start, action.viewport),
          end: normalizeScreenHandPoint(action.end, action.viewport),
        }
      : {
          point: normalizeScreenHandPoint(action.point, action.viewport),
        };
    if (
      (
        action.type === "hover_move" ||
        action.type === "touch_down" ||
        action.type === "touch_move" ||
        action.type === "tap" ||
        action.type === "long_press"
      ) &&
      profile
    ) {
      const mappedPoint = calibratedReachableScreenPoint(profile, action.point);
      const machinePoint = mappedPoint.machinePoint;
      const command = sendNodeEnvelope(node, {
        id: semanticCommandId(),
        action: action.type,
        params: {
          x: machinePoint.x,
          y: machinePoint.y,
          ...(action.type === "tap" || action.type === "long_press"
            ? { durationMs: action.durationMs }
            : {}),
          ...("sessionId" in action ? { sessionId: action.sessionId } : {}),
          ...("touchZ" in action && action.touchZ !== undefined
            ? { touchZ: action.touchZ }
            : {}),
          profileId: profile.id,
        },
      });
      const receipt = createActionReceipt({
        id: command.id,
        deviceId,
        idempotencyKey,
        actionType: action.type,
        ...context,
        result: {
          machinePoint,
          requestedScreenPoint: mappedPoint.requestedScreenPoint,
          effectiveScreenPoint: mappedPoint.screenPoint,
          edgeSnapped: mappedPoint.snapped,
          snapDistancePx: mappedPoint.snapDistancePx,
          calibrationId: profile.id,
          ...("touchZ" in action && action.touchZ !== undefined
            ? { touchZ: action.touchZ }
            : {}),
        },
      });
      return {
        status: "accepted",
        action,
        normalized,
        machinePoint,
        requestedScreenPoint: mappedPoint.requestedScreenPoint,
        effectiveScreenPoint: mappedPoint.screenPoint,
        edgeSnapped: mappedPoint.snapped,
        snapDistancePx: mappedPoint.snapDistancePx,
        calibrationId: profile.id,
        commandId: command.id,
        receipt: publicActionReceipt(receipt),
      };
    }
    if (action.type === "swipe" && profile) {
      const mappedStart = calibratedReachableScreenPoint(profile, action.start);
      const mappedEnd = calibratedReachableScreenPoint(profile, action.end);
      const machineStart = mappedStart.machinePoint;
      const machineEnd = mappedEnd.machinePoint;
      const command = sendNodeEnvelope(node, {
        id: semanticCommandId(),
        action: "swipe",
        params: {
          startX: machineStart.x,
          startY: machineStart.y,
          endX: machineEnd.x,
          endY: machineEnd.y,
          durationMs: action.durationMs,
          ...(action.touchZ === undefined ? {} : { touchZ: action.touchZ }),
          profileId: profile.id,
        },
      });
      const receipt = createActionReceipt({
        id: command.id,
        deviceId,
        idempotencyKey,
        actionType: action.type,
        ...context,
        result: {
          machineStart,
          machineEnd,
          requestedScreenStart: mappedStart.requestedScreenPoint,
          requestedScreenEnd: mappedEnd.requestedScreenPoint,
          effectiveScreenStart: mappedStart.screenPoint,
          effectiveScreenEnd: mappedEnd.screenPoint,
          edgeSnapped: mappedStart.snapped || mappedEnd.snapped,
          startSnapDistancePx: mappedStart.snapDistancePx,
          endSnapDistancePx: mappedEnd.snapDistancePx,
          calibrationId: profile.id,
          ...(action.touchZ === undefined ? {} : { touchZ: action.touchZ }),
        },
      });
      return {
        status: "accepted",
        action,
        normalized,
        machineStart,
        machineEnd,
        requestedScreenStart: mappedStart.requestedScreenPoint,
        requestedScreenEnd: mappedEnd.requestedScreenPoint,
        effectiveScreenStart: mappedStart.screenPoint,
        effectiveScreenEnd: mappedEnd.screenPoint,
        edgeSnapped: mappedStart.snapped || mappedEnd.snapped,
        startSnapDistancePx: mappedStart.snapDistancePx,
        endSnapDistancePx: mappedEnd.snapDistancePx,
        calibrationId: profile.id,
        commandId: command.id,
        receipt: publicActionReceipt(receipt),
      };
    }
    return {
      status: "accepted",
      action,
      normalized,
    };
  }

  return unavailableAction(deviceId, action);
}

function finiteCalibrationNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ScreenHandApiError(`${label} must be a finite number.`, 400, "INVALID_CALIBRATION");
  }
  return number;
}

function calibrationState(deviceId: string) {
  const draft = calibrationDrafts.get(deviceId) ?? null;
  return {
    active: calibrationProfileFor(deviceId),
    draft,
    outputPath: calibrationOutputPath(deviceId),
    cornerOrder: ["top_left", "top_right", "bottom_right", "bottom_left"],
  };
}

function requireCalibrationNode(deviceId: string) {
  const node = requireOnlineNode(deviceId);
  const state = objectValue(node.state);
  const grbl = objectValue(state.grbl);
  if (grbl.connected !== true) {
    throw new ScreenHandApiError(
      "The CH340/GRBL hardware link must be online.",
      409,
      "HARDWARE_OFFLINE",
    );
  }
  if (grbl.calibrationActive !== true) {
    throw new ScreenHandApiError(
      "Enable the local calibration window on the hardware node first.",
      409,
      "LOCAL_UNLOCK_REQUIRED",
    );
  }
  if (Math.abs(Number(grbl.z)) > 0.02) {
    throw new ScreenHandApiError(
      "The stylus must be at hover Z=0 while recording calibration points.",
      409,
      "HOVER_REQUIRED",
    );
  }
  return { node, grbl };
}

async function updateCalibration(
  deviceId: string,
  inputValue: unknown,
) {
  const input = objectValue(inputValue);
  const operation = String(input.operation ?? "").trim();
  const runtime = existingDeviceFrameRuntime(deviceId);
  const deviceFrame = runtime?.latestVerificationFrame ?? runtime?.latestFrame ?? null;

  if (operation === "begin") {
    if (!deviceFrame || !frameIsFresh(deviceFrame)) {
      throw new ScreenHandApiError(
        "A fresh camera frame is required to begin calibration.",
        409,
        "FRAME_UNAVAILABLE",
      );
    }
    const requestedWidth = Math.round(Number(input.screenWidth ?? 720));
    const requestedHeight = Math.round(Number(
      input.screenHeight ?? Math.max(480, Math.round(requestedWidth * 16 / 9)),
    ));
    if (
      requestedWidth < 320 || requestedWidth > 2160 ||
      requestedHeight < 480 || requestedHeight > 4096
    ) {
      throw new ScreenHandApiError(
        "The rectified screen size is invalid.",
        400,
        "INVALID_CALIBRATION",
      );
    }
    const draft: CalibrationDraft = {
      deviceId,
      frame: {
        width: deviceFrame.frame.width,
        height: deviceFrame.frame.height,
        sequence: deviceFrame.sequence,
      },
      screen: { width: requestedWidth, height: requestedHeight },
      imagePoints: [null, null, null, null],
      machinePoints: [null, null, null, null],
      startedAt: new Date().toISOString(),
    };
    calibrationDrafts.set(deviceId, draft);
    return calibrationState(deviceId);
  }

  if (operation === "jog") {
    const { node, grbl } = requireCalibrationNode(deviceId);
    const axis = String(input.axis ?? "").trim().toUpperCase();
    const distance = finiteCalibrationNumber(input.distance, "distance");
    if (!(["X", "Y"] as string[]).includes(axis) || distance === 0 || Math.abs(distance) > 10) {
      throw new ScreenHandApiError(
        "Calibration jogs must move X or Y by no more than 10 mm.",
        400,
        "INVALID_CALIBRATION_JOG",
      );
    }
    const currentX = finiteCalibrationNumber(grbl.x, "grbl.x");
    const currentY = finiteCalibrationNumber(grbl.y, "grbl.y");
    const x = axis === "X" ? currentX + distance : currentX;
    const y = axis === "Y" ? currentY + distance : currentY;
    const bounds = objectValue(grbl.calibrationMovementBounds);
    const minimumX = finiteCalibrationNumber(bounds.minimumX ?? 1, "calibrationMovementBounds.minimumX");
    const maximumX = finiteCalibrationNumber(bounds.maximumX ?? 82, "calibrationMovementBounds.maximumX");
    const minimumY = finiteCalibrationNumber(bounds.minimumY ?? 1, "calibrationMovementBounds.minimumY");
    const maximumY = finiteCalibrationNumber(bounds.maximumY ?? 170, "calibrationMovementBounds.maximumY");
    if (x < minimumX || x > maximumX || y < minimumY || y > maximumY) {
      throw new ScreenHandApiError(
        "The requested calibration jog is outside this device's safety envelope.",
        409,
        "CALIBRATION_JOG_OUT_OF_RANGE",
      );
    }
    sendNodeEnvelope(node, {
      id: `calibration-jog-${deviceId}-${Date.now()}`,
      action: "jog",
      params: { x, y, mode: "calibration" },
    });
    return calibrationState(deviceId);
  }

  if (operation === "visual_recovery") {
    if (input.confirmation !== "TRUSTED_CAMERA_REFERENCE_MATCHED") {
      throw new ScreenHandApiError(
        "Trusted camera-reference confirmation is required.",
        409,
        "VERIFICATION_REQUIRED",
      );
    }
    const node = requireOnlineNode(deviceId);
    const state = objectValue(node.state);
    const grbl = objectValue(state.grbl);
    if (grbl.connected !== true) {
      throw new ScreenHandApiError(
        "The CH340/GRBL hardware link must be online.",
        409,
        "HARDWARE_OFFLINE",
      );
    }
    if (
      grbl.homed !== true ||
      grbl.state !== "Idle" ||
      grbl.activeOperation != null
    ) {
      throw new ScreenHandApiError(
        "Visual calibration recovery requires an idle, homed controller.",
        409,
        "HOME_REQUIRED",
      );
    }
    if (!deviceFrame || !frameIsFresh(deviceFrame)) {
      throw new ScreenHandApiError(
        "A fresh physical camera frame is required for visual recovery.",
        409,
        "FRAME_UNAVAILABLE",
      );
    }

    let profile: ScreenHandCalibrationProfile;
    try {
      profile = parseScreenHandCalibrationProfile(input.profile);
    } catch (error) {
      throw new ScreenHandApiError(
        error instanceof Error ? error.message : "The recovered profile is invalid.",
        400,
        "INVALID_CALIBRATION",
      );
    }
    const activeProfile = calibrationProfileFor(deviceId);
    if (
      !activeProfile ||
      profile.deviceId !== deviceId ||
      profile.id !== activeProfile.id
    ) {
      throw new ScreenHandApiError(
        "The recovered profile must match the active physical device profile.",
        409,
        "PROFILE_MISMATCH",
      );
    }
    if (
      profile.frame.width !== deviceFrame.frame.width ||
      profile.frame.height !== deviceFrame.frame.height
    ) {
      throw new ScreenHandApiError(
        "The recovered profile does not match the current camera resolution.",
        409,
        "FRAME_SIZE_MISMATCH",
      );
    }
    const geometryIssue = calibrationReadinessIssue({
      imagePoints: profile.imagePoints,
      machinePoints: profile.controlMachinePoints ?? profile.machinePoints,
    });
    if (geometryIssue) {
      throw new ScreenHandApiError(
        geometryIssue,
        409,
        "INVALID_CALIBRATION_GEOMETRY",
      );
    }

    const bounds = objectValue(grbl.movementBounds);
    const minimumX = finiteCalibrationNumber(bounds.minimumX, "movementBounds.minimumX");
    const maximumX = finiteCalibrationNumber(bounds.maximumX, "movementBounds.maximumX");
    const minimumY = finiteCalibrationNumber(bounds.minimumY, "movementBounds.minimumY");
    const maximumY = finiteCalibrationNumber(bounds.maximumY, "movementBounds.maximumY");
    const calibrationBounds = objectValue(
      grbl.calibrationMovementBounds ?? grbl.movementBounds,
    );
    const calibrationMinimumX = finiteCalibrationNumber(
      calibrationBounds.minimumX,
      "calibrationMovementBounds.minimumX",
    );
    const calibrationMaximumX = finiteCalibrationNumber(
      calibrationBounds.maximumX,
      "calibrationMovementBounds.maximumX",
    );
    const calibrationMinimumY = finiteCalibrationNumber(
      calibrationBounds.minimumY,
      "calibrationMovementBounds.minimumY",
    );
    const calibrationMaximumY = finiteCalibrationNumber(
      calibrationBounds.maximumY,
      "calibrationMovementBounds.maximumY",
    );
    const recoveredPoints = profile.controlMachinePoints ?? profile.machinePoints;
    if (recoveredPoints.some((point) =>
      point.x < calibrationMinimumX || point.x > calibrationMaximumX ||
      point.y < calibrationMinimumY || point.y > calibrationMaximumY
    )) {
      throw new ScreenHandApiError(
        "The recovered phone corners are outside the hardware calibration movement envelope.",
        409,
        "CALIBRATION_OUT_OF_RANGE",
      );
    }
    if (
      profile.safeMachineBounds.minimumX < minimumX ||
      profile.safeMachineBounds.maximumX > maximumX ||
      profile.safeMachineBounds.minimumY < minimumY ||
      profile.safeMachineBounds.maximumY > maximumY
    ) {
      throw new ScreenHandApiError(
        "The recovered safe touch area is outside the hardware movement envelope.",
        409,
        "CALIBRATION_OUT_OF_RANGE",
      );
    }

    const outputPath = calibrationOutputPath(deviceId);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    calibrationProfile = profile;
    calibrationProfiles.set(deviceId, profile);
    runtime!.frameSyncMatchStreak = 0;
    runtime!.frameSyncLastCheckedAt = 0;
    scheduleFrameSyncCheck(deviceId);
    return calibrationState(deviceId);
  }

  const draft = calibrationDrafts.get(deviceId);
  if (!draft) {
    throw new ScreenHandApiError(
      "Begin a calibration session first.",
      409,
      "CALIBRATION_NOT_STARTED",
    );
  }
  const index = Number(input.index);
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    throw new ScreenHandApiError(
      "Calibration point index must be 0–3.",
      400,
      "INVALID_CALIBRATION",
    );
  }

  if (operation === "capture_image_point") {
    const x = finiteCalibrationNumber(input.x, "x");
    const y = finiteCalibrationNumber(input.y, "y");
    if (x < 0 || x > draft.frame.width || y < 0 || y > draft.frame.height) {
      throw new ScreenHandApiError(
        "The camera point is outside the raw frame.",
        400,
        "INVALID_CALIBRATION",
      );
    }
    draft.imagePoints[index] = { x, y };
    return calibrationState(deviceId);
  }

  if (operation === "capture_machine_point") {
    const { grbl } = requireCalibrationNode(deviceId);
    const x = finiteCalibrationNumber(grbl.x, "grbl.x");
    const y = finiteCalibrationNumber(grbl.y, "grbl.y");
    draft.machinePoints[index] = { x, y };
    return calibrationState(deviceId);
  }

  if (operation === "activate") {
    const { grbl } = requireCalibrationNode(deviceId);
    if (!draft.imagePoints.every(Boolean) || !draft.machinePoints.every(Boolean)) {
      throw new ScreenHandApiError(
        "All four camera points and machine points are required.",
        409,
        "CALIBRATION_INCOMPLETE",
      );
    }
    if (input.confirmation !== "PHONE_FIXED_AND_POINTS_VERIFIED") {
      throw new ScreenHandApiError(
        "Physical fixture verification confirmation is required.",
        409,
        "VERIFICATION_REQUIRED",
      );
    }
    const machinePoints = draft.machinePoints as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    const geometryIssue = calibrationReadinessIssue({
      imagePoints: draft.imagePoints,
      machinePoints: draft.machinePoints,
    });
    if (geometryIssue) {
      throw new ScreenHandApiError(
        geometryIssue,
        409,
        "INVALID_CALIBRATION_GEOMETRY",
      );
    }
    const xs = machinePoints.map((point) => point.x);
    const ys = machinePoints.map((point) => point.y);
    const tapProfile = objectValue(grbl.tapProfile);
    const touchBounds = objectValue(grbl.movementBounds);
    const minimumTouchX = finiteCalibrationNumber(
      touchBounds.minimumX,
      "movementBounds.minimumX",
    );
    const maximumTouchX = finiteCalibrationNumber(
      touchBounds.maximumX,
      "movementBounds.maximumX",
    );
    const minimumTouchY = finiteCalibrationNumber(
      touchBounds.minimumY,
      "movementBounds.minimumY",
    );
    const maximumTouchY = finiteCalibrationNumber(
      touchBounds.maximumY,
      "movementBounds.maximumY",
    );
    const reportedProfileId = String(tapProfile.id ?? "").trim();
    const profileId = reportedProfileId &&
        !/^(?:unconfigured|placeholder|default)$/i.test(reportedProfileId)
      ? reportedProfileId
      : `screenhand-${deviceId.replace(/[^a-zA-Z0-9._-]/g, "_")}-physical-v1`;
    const previousProfile = calibrationProfileFor(deviceId);
    const retainedKeyboard = retainedKeyboardCalibration(previousProfile, {
      deviceId,
      profileId,
      screen: draft.screen,
    });
    const profileInput = {
      id: profileId,
      deviceId,
      verified: true,
      verifiedAt: new Date().toISOString(),
      frame: { width: draft.frame.width, height: draft.frame.height },
      screen: draft.screen,
      imagePoints: draft.imagePoints,
      machinePoints,
      safeMachineBounds: {
        minimumX: Math.max(Math.min(...xs) + 0.5, minimumTouchX),
        maximumX: Math.min(Math.max(...xs) - 0.5, maximumTouchX),
        minimumY: Math.max(Math.min(...ys) + 0.5, minimumTouchY),
        maximumY: Math.min(Math.max(...ys) - 0.5, maximumTouchY),
      },
      tap: {
        hoverZ: finiteCalibrationNumber(tapProfile.hoverZ ?? 0, "tapProfile.hoverZ"),
        touchZ: finiteCalibrationNumber(tapProfile.touchZ ?? 4, "tapProfile.touchZ"),
        zStep: 0.5,
        feed: 3000,
        dwellMs: 40,
      },
      // Four-corner recalibration changes camera/XY geometry, not the logical
      // keyboard layout. Retain only a strict map already verified for the
      // same physical profile and identical rectified screen dimensions.
      ...(retainedKeyboard ? { keyboard: retainedKeyboard } : {}),
    };
    const profile = parseScreenHandCalibrationProfile(profileInput);
    const outputPath = calibrationOutputPath(deviceId);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(profile, null, 2)}\n`,
      "utf8",
    );
    calibrationProfile = profile;
    calibrationProfiles.set(deviceId, profile);
    calibrationDrafts.delete(deviceId);
    return calibrationState(deviceId);
  }

  throw new ScreenHandApiError(
    `Unsupported calibration operation: ${operation}`,
    400,
    "INVALID_CALIBRATION",
  );
}

const server = createServer(async (request, response) => {
  request.headers["x-request-id"] = boundedHeader(
    request.headers["x-request-id"],
    randomUUID(),
    160,
  );
  if (request.method === "OPTIONS") {
    setHeaders(request, response, 204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  try {
    if (!requestIsAuthorized(request)) {
      throw new ScreenHandApiError("A valid local control-plane bearer token is required.", 401, "UNAUTHORIZED");
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      ["/touch-calibration", "/touch-calibration.html"].includes(url.pathname)
    ) {
      const html = await readFile(TOUCH_CALIBRATION_PAGE_URL, "utf8");
      setHeaders(request, response, 200, "text/html; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }

    if (url.pathname === "/api/touch-calibration/samples") {
      if (request.method === "GET") {
        sendJson(request, response, {
          ok: true,
          samples: touchCalibrationSamples,
        });
        return;
      }
      if (request.method === "DELETE") {
        touchCalibrationSamples.length = 0;
        sendJson(request, response, { ok: true, samples: [] });
        return;
      }
      if (request.method === "POST") {
        touchCalibrationHeartbeatAt = Date.now();
        const input = objectValue(await readJson<unknown>(request));
        const x = finiteCalibrationNumber(input.x, "x");
        const y = finiteCalibrationNumber(input.y, "y");
        const viewportWidth = finiteCalibrationNumber(
          input.viewportWidth,
          "viewportWidth",
        );
        const viewportHeight = finiteCalibrationNumber(
          input.viewportHeight,
          "viewportHeight",
        );
        const screenX = finiteCalibrationNumber(input.screenX, "screenX");
        const screenY = finiteCalibrationNumber(input.screenY, "screenY");
        const screenWidth = finiteCalibrationNumber(input.screenWidth, "screenWidth");
        const screenHeight = finiteCalibrationNumber(input.screenHeight, "screenHeight");
        if (
          input.coordinateSpaceVersion !== 2 ||
          viewportWidth < 100 || viewportWidth > 4096 ||
          viewportHeight < 100 || viewportHeight > 4096 ||
          screenWidth < 100 || screenWidth > 4096 ||
          screenHeight < 100 || screenHeight > 4096 ||
          x < 0 || x > viewportWidth || y < 0 || y > viewportHeight ||
          screenX < 0 || screenX > screenWidth ||
          screenY < 0 || screenY > screenHeight
        ) {
          throw new ScreenHandApiError(
            "Touch sample is outside the reported viewport.",
            400,
            "INVALID_TOUCH_SAMPLE",
          );
        }
        const sample: TouchCalibrationSample = {
          id: ++touchCalibrationSampleId,
          x,
          y,
          normalizedX: x / viewportWidth,
          normalizedY: y / viewportHeight,
          viewportWidth,
          viewportHeight,
          screenX,
          screenY,
          screenWidth,
          screenHeight,
          normalizedScreenX: screenX / screenWidth,
          normalizedScreenY: screenY / screenHeight,
          coordinateSpaceVersion: 2,
          pointerType: String(input.pointerType ?? "touch").slice(0, 24),
          capturedAt: Date.now(),
        };
        touchCalibrationSamples.push(sample);
        while (touchCalibrationSamples.length > 512) {
          touchCalibrationSamples.shift();
        }
        sendJson(request, response, { ok: true, sample }, 201);
        return;
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/touch-calibration/profile"
    ) {
      if (!requestIsLoopback(request)) {
        throw new ScreenHandApiError(
          "Touch profile activation is restricted to the local recovery gateway.",
          403,
          "LOCAL_ONLY",
        );
      }
      if (Date.now() - touchCalibrationHeartbeatAt > TOUCH_CALIBRATION_HEARTBEAT_MS) {
        throw new ScreenHandApiError(
          "The dedicated touch-calibration page must remain active.",
          409,
          "TOUCH_PAGE_INACTIVE",
        );
      }
      const input = objectValue(await readJson<unknown>(request));
      if (input.confirmation !== "TOUCH_PAGE_POINTS_VERIFIED") {
        throw new ScreenHandApiError(
          "Verified touch-point confirmation is required.",
          409,
          "VERIFICATION_REQUIRED",
        );
      }
      const profile = parseScreenHandCalibrationProfile(input.profile);
      const activeProfile = calibrationProfileFor(profile.deviceId);
      if (
        !activeProfile ||
        profile.id !== activeProfile.id
      ) {
        throw new ScreenHandApiError(
          "The learned touch profile must match the active hardware profile.",
          409,
          "PROFILE_MISMATCH",
        );
      }
      const outputPath = calibrationOutputPath(profile.deviceId);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        `${JSON.stringify(profile, null, 2)}\n`,
        "utf8",
      );
      calibrationProfile = profile;
      calibrationProfiles.set(profile.deviceId, profile);
      const runtime = deviceFrameRuntime(profile.deviceId);
      runtime.frameSyncMatchStreak = 0;
      runtime.frameSyncLastCheckedAt = 0;
      scheduleFrameSyncCheck(profile.deviceId);
      sendJson(request, response, {
        ok: true,
        calibration: calibrationState(profile.deviceId),
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/touch-calibration/heartbeat"
    ) {
      touchCalibrationHeartbeatAt = Date.now();
      sendJson(request, response, {
        ok: true,
        activeUntil: touchCalibrationHeartbeatAt + TOUCH_CALIBRATION_HEARTBEAT_MS,
      });
      return;
    }

    if (request.method === "GET" && ["/", "/health", "/api/status"].includes(url.pathname)) {
      const currentFrameAgeMs = frameAgeMs(latestFrame);
      const currentFrameFresh = frameIsFresh(latestFrame);
      const physicalTapReady = screenHandDeviceIds().some(
        (deviceId) => tapReadiness(deviceId).ready,
      );
      sendJson(request, response, {
        ok: true,
        service: "ScreenHand physical-device control plane",
        ready: true,
        frame: publicFrame(latestFrame),
        frameFresh: currentFrameFresh,
        frameAgeMs: currentFrameAgeMs,
        actionGate: {
          observation: currentFrameFresh,
          physicalTap: physicalTapReady,
          ...(!currentFrameFresh
            ? { reason: "Waiting for a fresh camera frame." }
            : !physicalTapReady
              ? { reason: "Waiting for a matching four-point map, touch profile, and local hardware unlock." }
              : {}),
        },
        nodes: publicNodes(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/nodes") {
      sendJson(request, response, {
        ok: true,
        nodes: publicNodes(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/openapi.json") {
      const specification = JSON.parse(await readFile(OPENAPI_URL, "utf8")) as Record<string, unknown>;
      sendJson(request, response, specification);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/devices") {
      sendJson(request, response, {
        ok: true,
        protocolVersion: SCREENHAND_PROTOCOL_VERSION,
        devices: screenHandDeviceIds()
          .map(publicScreenHandDeviceById)
          .filter(Boolean),
      });
      return;
    }

    const agentRunMatch = url.pathname.match(
      /^\/api\/v1\/devices\/([^/]+)\/agent\/runs\/([^/]+)$/,
    );
    if (request.method === "GET" && agentRunMatch) {
      const deviceId = decodeURIComponent(agentRunMatch[1]);
      const runId = decodeURIComponent(agentRunMatch[2]);
      const run = generalAgentRuns.get(runId, deviceId);
      if (!run) {
        throw new ScreenHandApiError(
          `General agent run is unknown: ${runId}`,
          404,
          "AGENT_RUN_NOT_FOUND",
        );
      }
      sendJson(request, response, {
        ok: true,
        protocolVersion: SCREENHAND_PROTOCOL_VERSION,
        run,
      });
      return;
    }

    const agentRunsMatch = url.pathname.match(
      /^\/api\/v1\/devices\/([^/]+)\/agent\/runs$/,
    );
    if (agentRunsMatch) {
      const deviceId = decodeURIComponent(agentRunsMatch[1]);
      if (request.method === "GET") {
        sendJson(request, response, {
          ok: true,
          protocolVersion: SCREENHAND_PROTOCOL_VERSION,
          runs: generalAgentRuns.list(deviceId),
        });
        return;
      }
      if (request.method === "POST") {
        const input = objectValue(await readJson<unknown>(request));
        if (
          typeof input.deviceId === "string" &&
          input.deviceId.trim() !== deviceId
        ) {
          throw new ScreenHandApiError(
            "The request deviceId must match the URL device.",
            400,
            "INVALID_AGENT_REQUEST",
          );
        }
        const agentRequest = parseAgentRunRequest({ ...input, deviceId });
        try {
          const run = generalAgentRuns.submit(agentRequest);
          sendJson(request, response, {
            ok: true,
            protocolVersion: SCREENHAND_PROTOCOL_VERSION,
            run,
          }, 202);
        } catch (error) {
          if (error instanceof GeneralAgentRunConflictError) {
            throw new ScreenHandApiError(error.message, 409, error.code);
          }
          throw error;
        }
        return;
      }
    }

    const actionReceiptMatch = url.pathname.match(
      /^\/api\/v1\/devices\/([^/]+)\/actions\/([^/]+)$/,
    );
    if (request.method === "GET" && actionReceiptMatch) {
      const deviceId = decodeURIComponent(actionReceiptMatch[1]);
      const receiptId = decodeURIComponent(actionReceiptMatch[2]);
      const receipt = actionReceipts.get(receiptId);
      if (!receipt || receipt.deviceId !== deviceId) {
        throw new ScreenHandApiError(
          `Action receipt is unknown: ${receiptId}`,
          404,
          "ACTION_NOT_FOUND",
        );
      }
      const requestedWaitMs = Number(url.searchParams.get("waitMs") ?? 0);
      const waitMs = Number.isInteger(requestedWaitMs)
        ? Math.max(0, Math.min(2_000, requestedWaitMs))
        : 0;
      await waitForFinalActionReceipt(receipt, waitMs, request);
      const currentReceipt = actionReceipts.get(receiptId) ?? receipt;
      sendJson(request, response, {
        ok: true,
        protocolVersion: SCREENHAND_PROTOCOL_VERSION,
        receipt: publicActionReceipt(currentReceipt),
      });
      return;
    }

    const semanticDeviceMatch = url.pathname.match(
      /^\/api\/v1\/devices\/([^/]+)(?:\/(screenshot|actions|calibration))?$/,
    );
    if (semanticDeviceMatch) {
      const deviceId = decodeURIComponent(semanticDeviceMatch[1]);
      const resource = semanticDeviceMatch[2] ?? "device";

      if (request.method === "GET" && resource === "device") {
        const device = publicScreenHandDeviceById(deviceId);
        if (!device) {
          throw new ScreenHandApiError(
            `ScreenHand device is unknown: ${deviceId}`,
            404,
            "DEVICE_NOT_FOUND",
          );
        }
        sendJson(request, response, {
          ok: true,
          protocolVersion: SCREENHAND_PROTOCOL_VERSION,
          device,
        });
        return;
      }

      if (request.method === "GET" && resource === "screenshot") {
        const deviceRuntime = existingDeviceFrameRuntime(deviceId);
        const requestedSequenceValue = url.searchParams.get("sequence");
        const requestedSequence = requestedSequenceValue === null
          ? null
          : Number(requestedSequenceValue);
        const hasRequestedSequence = requestedSequence !== null &&
          Number.isInteger(requestedSequence);
        const selectedStoredFrame = hasRequestedSequence
          ? recentFrames.get(requestedSequence)
          : deviceRuntime?.latestFrame ?? undefined;
        const selectedFrame = selectedStoredFrame?.frame;
        const selectedSequence = hasRequestedSequence
          ? requestedSequence
          : deviceRuntime?.latestFrame?.sequence;
        if (
          !selectedFrame ||
          selectedFrame.deviceId !== deviceId ||
          !selectedSequence ||
          Math.max(0, Date.now() - selectedFrame.capturedAt) > FRAME_FRESHNESS_MS
        ) {
          throw new ScreenHandApiError(
            "A fresh camera frame is not available.",
            503,
            "FRAME_UNAVAILABLE",
          );
        }
        if (!selectedStoredFrame) throw new Error("The stored frame format is invalid.");
        setHeaders(request, response, 200, selectedStoredFrame.mimeType);
        response.setHeader("Content-Length", String(selectedStoredFrame.bytes.length));
        response.setHeader("X-ScreenHand-Frame-Sequence", String(selectedSequence));
        response.setHeader("X-ScreenHand-Frame-Width", String(selectedFrame.width));
        response.setHeader("X-ScreenHand-Frame-Height", String(selectedFrame.height));
        response.setHeader("X-ScreenHand-Captured-At", String(selectedFrame.capturedAt));
        response.end(selectedStoredFrame.bytes);
        return;
      }

      if (request.method === "POST" && resource === "actions") {
        const action = parseScreenHandActionEnvelope(await readJson<unknown>(request));
        const result = await executeSemanticAction(
          deviceId,
          action,
          actionRequestContext(request),
        );
        sendJson(request, response, {
          ok: true,
          protocolVersion: SCREENHAND_PROTOCOL_VERSION,
          idempotencyKey: action.idempotencyKey,
          result,
        }, result.status === "accepted" ? 202 : 200);
        return;
      }

      if (request.method === "GET" && resource === "actions") {
        const receipts = [...actionReceipts.values()]
          .filter((receipt) => receipt.deviceId === deviceId)
          .sort((left, right) => right.createdAt - left.createdAt)
          .map(publicActionReceipt);
        sendJson(request, response, {
          ok: true,
          protocolVersion: SCREENHAND_PROTOCOL_VERSION,
          receipts,
        });
        return;
      }

      if (request.method === "GET" && resource === "calibration") {
        sendJson(request, response, {
          ok: true,
          calibration: calibrationState(deviceId),
        });
        return;
      }

      if (request.method === "POST" && resource === "calibration") {
        const calibration = await updateCalibration(
          deviceId,
          await readJson<unknown>(request),
        );
        sendJson(request, response, { ok: true, calibration });
        return;
      }
    }

    if (request.method === "GET" && url.pathname === "/api/frame") {
      const raw = url.searchParams.get("raw") === "1";
      const requestedDeviceId = url.searchParams.get("deviceId") ?? "";
      const requestedRuntime = requestedDeviceId
        ? existingDeviceFrameRuntime(requestedDeviceId)
        : null;
      const requestedSequenceValue = url.searchParams.get("sequence");
      const requestedSequence = requestedSequenceValue === null
        ? null
        : Number(requestedSequenceValue);
      const hasRequestedSequence = requestedSequence !== null &&
        Number.isInteger(requestedSequence);
      const selectedStoredFrame = hasRequestedSequence
        ? recentFrames.get(requestedSequence)
        : raw
          ? requestedRuntime?.latestVerificationFrame ?? latestVerificationFrame ?? undefined
          : requestedRuntime?.latestFrame ?? latestFrame ?? undefined;
      if (!selectedStoredFrame) {
        sendJson(request, response, { ok: false, error: "No frame is available yet." }, 404);
        return;
      }
      setHeaders(request, response, 200, selectedStoredFrame.mimeType);
      response.setHeader("Content-Length", String(selectedStoredFrame.bytes.length));
      response.setHeader(
        "X-ScreenHand-Frame-Sequence",
        String(selectedStoredFrame.sequence),
      );
      response.setHeader(
        "X-ScreenHand-Captured-At",
        String(selectedStoredFrame.frame.capturedAt),
      );
      response.end(selectedStoredFrame.bytes);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/frame") {
      const frame = validateFrame(await readJson<Partial<ScreenFrame>>(request));
      const match = frame.dataUrl.match(
        /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/,
      );
      if (!match) throw new Error("The stored frame format is invalid.");
      const stored = storeFrame(
        frame,
        match[1] as StoredFrame["mimeType"],
        Buffer.from(match[2], "base64"),
      );
      sendJson(request, response, {
        ok: true,
        frame: publicFrame(stored),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/frame/jpeg") {
      const bytes = await readBytes(request);
      if (!bytes.length) throw new Error("The JPEG frame cannot be empty.");
      const width = Number(request.headers["x-screenhand-frame-width"]);
      const height = Number(request.headers["x-screenhand-frame-height"]);
      const capturedAt = Number(request.headers["x-screenhand-captured-at"]);
      const deviceId = String(
        request.headers["x-screenhand-device-id"] ?? "",
      );
      const source = String(
        request.headers["x-screenhand-frame-source"] ?? "hardware-camera-node",
      );
      const role = String(
        request.headers["x-screenhand-frame-role"] ?? "control",
      ) === "verification" ? "verification" : "control";
      const frame = validateFrame({
        dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        width,
        height,
        capturedAt,
        source,
        deviceId,
        role,
      });
      const stored = storeFrame(frame, "image/jpeg", bytes);
      sendJson(request, response, {
        ok: true,
        frame: publicFrame(stored),
      });
      return;
    }

    const nodeCommandMatch = url.pathname.match(
      /^\/api\/nodes\/([^/]+)\/commands$/,
    );
    if (request.method === "POST" && nodeCommandMatch) {
      const deviceId = decodeURIComponent(nodeCommandMatch[1]);
      const node = requireOnlineNode(deviceId);
      const command = validateNodeCommand(
        await readJson<Partial<NodeCommand>>(request),
      );
      const envelope = sendNodeEnvelope(node, {
        id: `node-${Date.now().toString(36)}`,
        ...command,
      });
      sendJson(request, response, { ok: true, command: envelope }, 202);
      return;
    }

    sendJson(request, response, { ok: false, error: "Not found" }, 404);
  } catch (error) {
    const message = errorMessage(error);
    const status = error instanceof ScreenHandApiError
      ? error.status
      : /previous command/i.test(message)
        ? 409
        : 400;
    const code = error instanceof ScreenHandApiError
      ? error.code
      : error instanceof ScreenHandActionValidationError
        ? error.code
        : "BAD_REQUEST";
    sendJson(request, response, { ok: false, error: message, code }, status);
  }
});

const nodeSocketServer = new WebSocketServer({ noServer: true });
const liveSocketServer = new WebSocketServer({ noServer: true });

liveSocketServer.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const deviceId = String(url.searchParams.get("deviceId") ?? "")
    .trim()
    .slice(0, 120);
  const raw = url.searchParams.get("raw") === "1";
  const subscriber = { socket, deviceId, raw };
  liveSubscribers.add(subscriber);
  const runtime = deviceId ? existingDeviceFrameRuntime(deviceId) : null;
  const initialFrame = raw
    ? runtime?.latestVerificationFrame ?? latestVerificationFrame
    : runtime?.latestFrame ?? latestFrame;
  if (
    initialFrame &&
    (!deviceId || initialFrame.frame.deviceId === deviceId)
  ) {
    sendLiveFrame(socket, initialFrame, raw);
  }
  socket.on("close", () => liveSubscribers.delete(subscriber));
  socket.on("error", () => liveSubscribers.delete(subscriber));
});

nodeSocketServer.on("connection", (socket) => {
  let boundDeviceId = "";

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        deviceId?: string;
        name?: string;
        state?: unknown;
        payload?: unknown;
      };
      const deviceId = String(message.deviceId ?? "").trim().slice(0, 120);
      if (!deviceId) {
        socket.close(1008, "deviceId required");
        return;
      }

      boundDeviceId = deviceId;
      const existing = remoteNodes.get(deviceId);
      const now = Date.now();
      const node: RemoteNode = {
        deviceId,
        socket,
        connectedAt:
          existing?.socket === socket ? existing.connectedAt : now,
        lastSeenAt: now,
        state: message.state ?? existing?.state ?? null,
        lastEvent:
          message.type === "event"
            ? message.payload ?? null
            : existing?.lastEvent ?? null,
      };
      remoteNodes.set(deviceId, node);
      if (message.state !== undefined) {
        reconcileOperationState(deviceId, message.state);
      }
      if (message.type === "event" && message.name === "command-result") {
        reconcileCommandResult(deviceId, message.payload);
      }
      if (message.type === "heartbeat" && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "heartbeat_ack",
          deviceId,
          at: now,
        }));
      }
    } catch {
      socket.close(1007, "invalid JSON");
    }
  });

  socket.on("close", () => {
    if (!boundDeviceId) return;
    const current = remoteNodes.get(boundDeviceId);
    if (current?.socket === socket) {
      remoteNodes.delete(boundDeviceId);
      failOpenReceipts(
        boundDeviceId,
        "The ScreenHand node disconnected before final confirmation; its local safety gate has been locked.",
      );
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  if (!requestIsAuthorized(request)) {
    socket.destroy();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/node/socket") {
    nodeSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      nodeSocketServer.emit("connection", webSocket, request);
    });
    return;
  }
  if (url.pathname === "/api/live/socket") {
    liveSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      liveSocketServer.emit("connection", webSocket, request);
    });
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`ScreenHand control plane listening on http://${HOST}:${PORT}`);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;

  console.log(`Received ${signal}; closing ScreenHand node connections`);
  for (const client of nodeSocketServer.clients) {
    try {
      client.close(1012, "service restart");
    } catch {
      client.terminate();
    }
  }
  for (const client of liveSocketServer.clients) {
    try {
      client.close(1012, "service restart");
    } catch {
      client.terminate();
    }
  }

  nodeSocketServer.close();
  liveSocketServer.close();
  server.close(() => {
    Promise.allSettled([receiptWriteQueue, auditWriteQueue])
      .finally(() => process.exit(0));
  });

  const forceExitTimer = setTimeout(() => {
    for (const client of nodeSocketServer.clients) {
      client.terminate();
    }
    for (const client of liveSocketServer.clients) {
      client.terminate();
    }
    process.exit(0);
  }, 1_500);
  forceExitTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}
