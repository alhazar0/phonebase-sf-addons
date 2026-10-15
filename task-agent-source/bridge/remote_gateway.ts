import "dotenv/config";

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import sharp from "sharp";
import { WebSocket, WebSocketServer } from "ws";
import {
  calibratedScreenPoint,
  parseScreenHandCalibrationProfile,
  type ScreenHandCalibrationProfile,
} from "../agent/calibration-profile";
import { mapImagePointToMachine } from "../agent/homography";
import {
  adjustedControlMachinePoints,
  calibrationSampleScreenPoint,
  detectCalibrationMarker,
  detectNewTouch,
  fitProjectiveTouchCalibration,
  legacyIphoneHomeButtonScreenPoint,
  precisionCalibrationLowerYRatio,
  projectProjectiveCalibration,
  screenPointToMachine,
  translatedControlMachinePoints,
  validateReferenceGeometry,
  validationPoint,
} from "./visual_reference";

const HOST = process.env.SCREENHAND_REMOTE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SCREENHAND_REMOTE_PORT ?? 3015);
const UPSTREAM = new URL(
  process.env.SCREENHAND_REMOTE_UPSTREAM ?? "http://127.0.0.1:3013",
);
const BLACK_DRIVER_UPSTREAM = new URL(
  process.env.SCREENHAND_REMOTE_BLACK_DRIVER ?? "http://127.0.0.1:3014",
);
const SUPERVISOR_UPSTREAM = new URL(
  process.env.SCREENHAND_SUPERVISOR_UPSTREAM ?? "http://127.0.0.1:3016",
);
const MAINTENANCE_ENABLED = process.env.SCREENHAND_REMOTE_MAINTENANCE === "1";
const MANUAL_REFERENCE_MAX_OFFSET_MM = Number(
  process.env.SCREENHAND_REMOTE_MANUAL_REFERENCE_MAX_OFFSET_MM ?? 15,
);
const BLACK_DEVICE_ID = process.env.SCREENHAND_BLACK_DEVICE_ID ?? "black-arm-01";
const ACCESS_TOKEN = process.env.SCREENHAND_REMOTE_TOKEN ?? "";
const ALLOWED_ORIGINS = new Set(
  String(process.env.SCREENHAND_REMOTE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const MAX_BODY_BYTES = 128 * 1024;
const REMOTE_FRAME_INTERVAL_MS = Number(
  process.env.SCREENHAND_REMOTE_FRAME_INTERVAL_MS ?? 300,
);
const REMOTE_FRAME_WIDTH = Number(
  process.env.SCREENHAND_REMOTE_FRAME_WIDTH ?? 300,
);
const REMOTE_FRAME_QUALITY = Number(
  process.env.SCREENHAND_REMOTE_FRAME_QUALITY ?? 40,
);
const ACTION_WINDOW_MS = 5_000;
const MAX_ACTIONS_PER_WINDOW = 20;
const recentActionTimes: number[] = [];
const VISUAL_REFERENCE_MAX_ERROR_PX = 25;
const CAMERA_PRECISION_MAXIMUM_ERROR_PX = 10;
const CAMERA_PRECISION_RMSE_PX = 6;
let visualRecoveryActive = false;
let visualRecoveryCompleted = false;
let precisionCalibrationActive = false;

if (ACCESS_TOKEN.length < 32) {
  throw new Error("SCREENHAND_REMOTE_TOKEN must contain at least 32 characters");
}
if (ALLOWED_ORIGINS.size === 0 || ALLOWED_ORIGINS.has("*")) {
  throw new Error("SCREENHAND_REMOTE_ALLOWED_ORIGINS must contain exact origins");
}
if (
  !Number.isFinite(MANUAL_REFERENCE_MAX_OFFSET_MM) ||
  MANUAL_REFERENCE_MAX_OFFSET_MM <= 0 || MANUAL_REFERENCE_MAX_OFFSET_MM > 50
) {
  throw new Error(
    "SCREENHAND_REMOTE_MANUAL_REFERENCE_MAX_OFFSET_MM must be within (0, 50]",
  );
}
if (
  UPSTREAM.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(UPSTREAM.hostname)
) {
  throw new Error("The remote gateway upstream must be a loopback HTTP address");
}
if (
  BLACK_DRIVER_UPSTREAM.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(BLACK_DRIVER_UPSTREAM.hostname)
) {
  throw new Error("The black-arm maintenance upstream must be a loopback HTTP address");
}
if (
  SUPERVISOR_UPSTREAM.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(SUPERVISOR_UPSTREAM.hostname)
) {
  throw new Error("The supervisor upstream must be a loopback HTTP address");
}
if (
  !Number.isFinite(REMOTE_FRAME_INTERVAL_MS) || REMOTE_FRAME_INTERVAL_MS < 100 ||
  !Number.isFinite(REMOTE_FRAME_WIDTH) || REMOTE_FRAME_WIDTH < 240 ||
  !Number.isFinite(REMOTE_FRAME_QUALITY) ||
  REMOTE_FRAME_QUALITY < 20 || REMOTE_FRAME_QUALITY > 90
) {
  throw new Error("Remote live-frame settings are invalid");
}

function requestOrigin(request: IncomingMessage) {
  return String(request.headers.origin ?? "");
}

function originAllowed(request: IncomingMessage) {
  return ALLOWED_ORIGINS.has(requestOrigin(request));
}

function suppliedHttpToken(request: IncomingMessage) {
  const authorization = String(request.headers.authorization ?? "");
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function tokenMatches(value: string) {
  const supplied = Buffer.from(value);
  const expected = Buffer.from(ACCESS_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse) {
  const origin = requestOrigin(request);
  if (ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Ngrok-Skip-Browser-Warning",
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: Record<string, unknown>,
) {
  response.statusCode = status;
  setCorsHeaders(request, response);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function routeAllowed(method: string, pathname: string) {
  if (
    MAINTENANCE_ENABLED &&
    (
      (method === "GET" && pathname === "/api/maintenance/black-arm/status") ||
      (method === "GET" && pathname === "/api/maintenance/black-arm/touch-samples") ||
      (method === "POST" && [
        "/api/maintenance/black-arm/recover-home",
        "/api/maintenance/black-arm/visual-reference",
        "/api/maintenance/black-arm/precision-calibration",
        "/api/maintenance/black-arm/configure-iphone-se-home",
        "/api/maintenance/black-arm/correct-drift",
        "/api/maintenance/black-arm/probe-screen",
        "/api/maintenance/black-arm/tap-current",
        "/api/maintenance/black-arm/manual-reference",
      ].includes(pathname))
    )
  ) {
    return true;
  }
  if (
    method === "GET" &&
    ["/", "/health", "/api/status", "/api/v1/devices", "/api/v1/openapi.json"].includes(pathname)
  ) {
    return true;
  }
  if (
    method === "GET" &&
    /^\/api\/v1\/devices\/[^/]+(?:\/screenshot|\/actions(?:\/[^/]+)?)?$/.test(pathname)
  ) {
    return true;
  }
  return method === "POST" && /^\/api\/v1\/devices\/[^/]+\/actions$/.test(pathname);
}

function upstreamRequestUrl(url: URL) {
  if (url.pathname === "/api/maintenance/black-arm/status") {
    return new URL("/api/status", BLACK_DRIVER_UPSTREAM);
  }
  if (url.pathname === "/api/maintenance/black-arm/recover-home") {
    return new URL("/api/home-machine", BLACK_DRIVER_UPSTREAM);
  }
  if (url.pathname === "/api/maintenance/black-arm/tap-current") {
    return new URL("/api/maintenance/tap-current", BLACK_DRIVER_UPSTREAM);
  }
  if (url.pathname === "/api/maintenance/black-arm/probe-screen") {
    return new URL("/api/maintenance/probe-screen", BLACK_DRIVER_UPSTREAM);
  }
  if (url.pathname === "/api/maintenance/black-arm/manual-reference") {
    return new URL("/api/maintenance/manual-reference", BLACK_DRIVER_UPSTREAM);
  }
  return new URL(`${url.pathname}${url.search}`, UPSTREAM);
}

function validateRemoteAction(body: Buffer) {
  const value = JSON.parse(body.toString("utf8")) as {
    action?: { type?: unknown };
  };
  const type = String(value.action?.type ?? "");
  if (
    ![
      "status",
      "hold",
      "tap",
      "long_press",
      "swipe",
      "wait",
    ].includes(type)
  ) {
    throw new Error(`Remote action is unavailable: ${type || "missing"}`);
  }
  const now = Date.now();
  while (recentActionTimes.length && now - recentActionTimes[0] > ACTION_WINDOW_MS) {
    recentActionTimes.shift();
  }
  if (recentActionTimes.length >= MAX_ACTIONS_PER_WINDOW) {
    throw new Error("Remote action rate limit reached");
  }
  recentActionTimes.push(now);
}

async function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const body = request.method === "POST" ? await readBody(request) : null;
  if (body && /^\/api\/v1\/devices\/[^/]+\/actions$/.test(url.pathname)) {
    validateRemoteAction(body);
  }
  if (url.pathname === "/api/maintenance/black-arm/recover-home") {
    if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
    if (body?.length && body.toString("utf8").trim() !== "{}") {
      throw new Error("Black-arm recovery does not accept movement parameters");
    }
  }
  if (url.pathname === "/api/maintenance/black-arm/tap-current") {
    if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
    if (body?.length && body.toString("utf8").trim() !== "{}") {
      throw new Error("The maintenance tap does not accept coordinates");
    }
  }
  if (url.pathname === "/api/maintenance/black-arm/probe-screen") {
    if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
    if (body?.length && body.toString("utf8").trim() !== "{}") {
      throw new Error("The fixed screen probe does not accept coordinates");
    }
  }
  if (url.pathname === "/api/maintenance/black-arm/manual-reference") {
    if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
    const value = JSON.parse(body?.toString("utf8") || "{}") as Record<string, unknown>;
    const allowed = new Set(["logicalX", "logicalY", "confirmed"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new Error("Manual reference contains unsupported fields");
    }
    const logicalX = Number(value.logicalX);
    const logicalY = Number(value.logicalY);
    if (
      value.confirmed !== true ||
      !Number.isFinite(logicalX) || logicalX < 5.8 || logicalX > 78.5 ||
      !Number.isFinite(logicalY) || logicalY < 10.5 || logicalY > 168
    ) {
      throw new Error("Manual reference is outside the verified phone bounds");
    }
  }

  const upstreamUrl = upstreamRequestUrl(url);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: body
      ? { "Content-Type": String(request.headers["content-type"] ?? "application/json") }
      : undefined,
    body: body && body.length ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(95_000),
  });
  const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
  response.statusCode = upstreamResponse.status;
  setCorsHeaders(request, response);
  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  for (const header of [
    "x-screenhand-frame-sequence",
    "x-screenhand-frame-width",
    "x-screenhand-frame-height",
  ]) {
    const value = upstreamResponse.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  response.setHeader("Content-Length", String(bytes.length));
  response.end(bytes);
}

type DriverStatus = {
  ok?: boolean;
  state?: string;
  homed?: boolean;
  limit_pins?: string;
  reference_mode?: string;
  position?: { x?: number; y?: number; z?: number };
  recovery?: { status?: string; error?: string };
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
  coordinateSpaceVersion: number;
  capturedAt: number;
};

async function driverRequest(
  pathname: string,
  body?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<DriverStatus> {
  const response = await fetch(new URL(pathname, BLACK_DRIVER_UPSTREAM), {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json() as {
    ok?: boolean;
    status?: DriverStatus;
    error?: string;
  } & DriverStatus;
  const status = payload.status ?? payload;
  if (!response.ok || payload.ok !== true || !status) {
    throw new Error(payload.error ?? `Black arm driver returned ${response.status}`);
  }
  return status;
}

async function requireTouchCalibrationPage() {
  const response = await fetch(
    new URL(`/api/v1/devices/${encodeURIComponent(BLACK_DEVICE_ID)}`, UPSTREAM),
    { signal: AbortSignal.timeout(5_000) },
  );
  const payload = await response.json() as {
    device?: {
      state?: {
        touchCalibration?: { pageActive?: boolean };
      };
    };
    error?: string;
  };
  if (!response.ok || !payload.device) {
    throw new Error(payload.error ?? "Black arm device state is unavailable");
  }
  if (payload.device.state?.touchCalibration?.pageActive !== true) {
    throw new Error(
      "Open http://<this-Mac-LAN-IP>:3013/touch-calibration on the iPhone first.",
    );
  }
}

async function activateTouchProfile(profile: ScreenHandCalibrationProfile) {
  const response = await fetch(
    new URL("/api/touch-calibration/profile", UPSTREAM),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "TOUCH_PAGE_POINTS_VERIFIED",
        profile,
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  const payload = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error ?? "Could not activate the browser touch-calibration profile.");
  }
}

async function activeTouchProfile(): Promise<ScreenHandCalibrationProfile> {
  const response = await fetch(
    new URL(
      `/api/v1/devices/${encodeURIComponent(BLACK_DEVICE_ID)}/calibration`,
      UPSTREAM,
    ),
    { signal: AbortSignal.timeout(5_000) },
  );
  const payload = await response.json() as {
    calibration?: { active?: unknown };
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? "Could not read the control plane's active touch profile.");
  }
  if (!payload.calibration?.active) {
    throw new Error("The control plane has no active black-arm touch profile.");
  }
  const profile = parseScreenHandCalibrationProfile(
    payload.calibration.active,
  );
  if (profile.deviceId !== BLACK_DEVICE_ID) {
    throw new Error("The active control-plane touch profile does not match the black-arm device.");
  }
  return profile;
}

async function touchCalibrationSamples(): Promise<TouchCalibrationSample[]> {
  const response = await fetch(
    new URL("/api/touch-calibration/samples", UPSTREAM),
    { signal: AbortSignal.timeout(5_000) },
  );
  const payload = await response.json() as {
    ok?: boolean;
    samples?: TouchCalibrationSample[];
    error?: string;
  };
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.samples)) {
    throw new Error(payload.error ?? "Could not read touch points from the ScreenHand calibration page.");
  }
  return payload.samples.filter((sample) => (
    Number.isInteger(sample.id) &&
    Number.isFinite(sample.x) && Number.isFinite(sample.y) &&
    Number.isFinite(sample.normalizedX) && Number.isFinite(sample.normalizedY) &&
    Number.isFinite(sample.viewportWidth) && Number.isFinite(sample.viewportHeight) &&
    Number.isFinite(sample.screenX) && Number.isFinite(sample.screenY) &&
    Number.isFinite(sample.screenWidth) && Number.isFinite(sample.screenHeight) &&
    Number.isFinite(sample.normalizedScreenX) &&
    Number.isFinite(sample.normalizedScreenY) &&
    sample.coordinateSpaceVersion === 2 &&
    Number.isFinite(sample.capturedAt)
  ));
}

async function latestTouchCalibrationSampleId() {
  const samples = await touchCalibrationSamples();
  return samples.reduce((maximum, sample) => Math.max(maximum, sample.id), 0);
}

type VerificationCameraFrame = {
  jpeg: Buffer;
  sequence: number | null;
  capturedAt: number | null;
  fingerprint: string;
};

function optionalFrameHeader(value: string | null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function verificationCameraFrame(): Promise<VerificationCameraFrame> {
  const response = await fetch(new URL(
    `/api/frame?raw=1&deviceId=${encodeURIComponent(BLACK_DEVICE_ID)}`,
    UPSTREAM,
  ), {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Could not read the physical-camera calibration frame: HTTP ${response.status}`);
  }
  const jpeg = Buffer.from(await response.arrayBuffer());
  return {
    jpeg,
    sequence: optionalFrameHeader(
      response.headers.get("x-screenhand-frame-sequence"),
    ),
    capturedAt: optionalFrameHeader(
      response.headers.get("x-screenhand-captured-at"),
    ),
    // Fingerprints preserve compatibility with an older 3013 while it is
    // being upgraded. Camera noise makes each genuinely new JPEG distinct.
    fingerprint: createHash("sha256").update(jpeg).digest("hex"),
  };
}

type CameraMarkerObservation = VerificationCameraFrame & {
  marker: Awaited<ReturnType<typeof detectCalibrationMarker>>;
};

async function currentCameraMarker(
  expected?: { x: number; y: number },
): Promise<CameraMarkerObservation> {
  const frame = await verificationCameraFrame();
  return {
    ...frame,
    marker: await detectCalibrationMarker(frame.jpeg, expected),
  };
}

async function waitForChangedCameraMarker(
  previous: CameraMarkerObservation,
  expected: { x: number; y: number },
) {
  const deadline = Date.now() + 5_000;
  let candidate: CameraMarkerObservation | null = null;
  let confirmationCount = 0;
  let lastProcessedFrame = previous.fingerprint;
  while (Date.now() < deadline) {
    const observation = await currentCameraMarker(expected);
    const isNewFrame = previous.sequence !== null && observation.sequence !== null
      ? observation.sequence > previous.sequence
      : previous.capturedAt !== null && observation.capturedAt !== null
        ? observation.capturedAt > previous.capturedAt
        : observation.fingerprint !== previous.fingerprint;
    if (!isNewFrame || observation.fingerprint === lastProcessedFrame) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    lastProcessedFrame = observation.fingerprint;
    const changedMarker = await detectNewTouch(previous.jpeg, observation.jpeg);
    const detected = observation.marker ?? changedMarker;
    const changed = changedMarker !== null || detected && (
      !previous.marker || Math.hypot(
        detected.point.x - previous.marker.point.x,
        detected.point.y - previous.marker.point.y,
      ) > 6
    );
    if (!changed || !detected) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (
      candidate?.marker &&
      Math.hypot(
        detected.point.x - candidate.marker.point.x,
        detected.point.y - candidate.marker.point.y,
      ) <= 4
    ) {
      confirmationCount += 1;
    } else {
      candidate = { ...observation, marker: detected };
      confirmationCount = 1;
    }
    if (confirmationCount >= 2 && candidate?.marker) {
      return {
        ...candidate.marker,
        frameSequence: observation.sequence,
        capturedAt: observation.capturedAt,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "The physical camera did not confirm the new red calibration marker in two consecutive frames within 5 seconds.",
  );
}

async function waitForTouchCalibrationSample(
  minimumId: number,
): Promise<TouchCalibrationSample | null> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const samples = await touchCalibrationSamples();
    const sample = samples
      .filter((candidate) => candidate.id > minimumId)
      .sort((left, right) => right.id - left.id)[0];
    if (sample) return sample;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

type TouchCluster = {
  point: { x: number; y: number };
  sampleIds: number[];
  sampleCount: number;
  spreadPx: number;
};

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function captureTouchCluster(
  minimumId: number,
  profile: ScreenHandCalibrationProfile,
): Promise<TouchCluster> {
  const deadline = Date.now() + 3_500;
  let lastMaximumId = minimumId;
  let stableSince = Date.now();
  let captured: TouchCalibrationSample[] = [];
  while (Date.now() < deadline) {
    captured = (await touchCalibrationSamples())
      .filter((sample) => sample.id > minimumId)
      .sort((left, right) => left.id - right.id);
    const maximumId = captured.at(-1)?.id ?? minimumId;
    if (maximumId !== lastMaximumId) {
      lastMaximumId = maximumId;
      stableSince = Date.now();
    }
    if (captured.length > 0 && Date.now() - stableSince >= 280) break;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (captured.length === 0) {
    throw new Error("The precision-calibration action did not create a browser touch point.");
  }
  const points = captured.map((sample) => calibrationSampleScreenPoint(
    sample,
    profile.screen.width,
    profile.screen.height,
  ));
  const point = {
    x: Math.round(median(points.map((value) => value.x)) * 1000) / 1000,
    y: Math.round(median(points.map((value) => value.y)) * 1000) / 1000,
  };
  const spreadPx = Math.max(...points.map((value) => Math.hypot(
    value.x - point.x,
    value.y - point.y,
  )));
  if (spreadPx > 14) {
    throw new Error(
      `One physical touch produced ${spreadPx.toFixed(1)} px of coordinate jitter, exceeding 14 px.`,
    );
  }
  return {
    point,
    sampleIds: captured.map((sample) => sample.id),
    sampleCount: captured.length,
    spreadPx: Math.round(spreadPx * 1000) / 1000,
  };
}

function screenPointToCamera(
  profile: ScreenHandCalibrationProfile,
  target: { x: number; y: number },
) {
  return mapImagePointToMachine({
    imagePoints: [
      { x: 0, y: 0 },
      { x: profile.screen.width, y: 0 },
      { x: profile.screen.width, y: profile.screen.height },
      { x: 0, y: profile.screen.height },
    ],
    machinePoints: profile.imagePoints,
  }, target);
}

async function precisionTouchAt(
  profile: ScreenHandCalibrationProfile,
  target: { x: number; y: number },
) {
  const machine = calibratedScreenPoint(profile, target);
  const expectedCameraPoint = screenPointToCamera(profile, target);
  const endX = machine.x + 0.8 <= profile.safeMachineBounds.maximumX
    ? machine.x + 0.8
    : machine.x - 0.8;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const previousCameraMarker = await currentCameraMarker(profile);
    const minimumSampleId = await latestTouchCalibrationSampleId();
    await driverRequest("/api/swipe", {
      startX: machine.x,
      startY: machine.y,
      endX,
      endY: machine.y,
      durationMs: 250,
      touchZ: profile.tap.touchZ,
    });
    try {
      const cluster = await captureTouchCluster(minimumSampleId, profile);
      const cameraMarker = await waitForChangedCameraMarker(
        previousCameraMarker,
        expectedCameraPoint,
      );
      return { target, machine, cluster, cameraMarker, attempt };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 2 || !message.includes("did not create a browser touch point")) throw error;
    }
  }
  throw lastError;
}

async function runPrecisionCalibration() {
  if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
  if (visualRecoveryActive) throw new Error("Visual reference recovery is running");
  if (precisionCalibrationActive) throw new Error("Precision calibration is already running");
  precisionCalibrationActive = true;
  let learnedProfileActive = false;
  let originalProfile: ScreenHandCalibrationProfile | null = null;
  try {
    const profile = await activeTouchProfile();
    originalProfile = profile;
    await requireTouchCalibrationPage();
    const initial = await driverRequest("/api/status");
    if (
      initial.state !== "Idle" || initial.homed !== true ||
      !["manual", "sensor-home"].includes(String(initial.reference_mode ?? ""))
    ) {
      throw new Error("Precision calibration requires a safe arm reference and the Idle state.");
    }

    const existingSamples = await touchCalibrationSamples();
    const latestSample = existingSamples.at(-1);
    const lowerYRatio = precisionCalibrationLowerYRatio(latestSample);

    const trainingRatios = [
      [0.12, 0.15], [0.50, 0.15], [0.88, 0.15],
      [0.12, 0.50],                 [0.88, 0.50],
      [0.12, lowerYRatio], [0.50, lowerYRatio], [0.88, lowerYRatio],
    ];
    const training = [];
    for (const [xRatio, yRatio] of trainingRatios) {
      training.push(await precisionTouchAt(profile, {
        x: profile.screen.width * xRatio,
        y: profile.screen.height * yRatio,
      }));
    }
    // The browser reports only its content viewport. It cannot observe Safari
    // chrome or the Home Indicator, so it is used solely to confirm that a
    // contact occurred. Geometry comes from the camera-visible physical mark.
    const physical = fitProjectiveTouchCalibration(
      training.map((sample) => ({
        screen: sample.cameraMarker.point,
        machine: sample.machine,
      })),
      profile.frame.width,
      profile.frame.height,
    );
    const physicalScreenMachinePoints = profile.imagePoints.map((point) => (
      projectProjectiveCalibration(
        physical,
        point,
        profile.frame.width,
        profile.frame.height,
      )
    )) as ScreenHandCalibrationProfile["machinePoints"];
    const fitted = {
      model: "camera-physical-projective" as const,
      controlMachinePoints: physicalScreenMachinePoints,
      coefficients: physical.coefficients,
      rmseMm: physical.rmse,
      maximumErrorMm: physical.maximumError,
    };
    if (fitted.rmseMm > 0.75 || fitted.maximumErrorMm > 1.25) {
      throw new Error(
        `The multipoint projective fit residual is too large: RMSE=${fitted.rmseMm.toFixed(3)} mm/` +
        `MAX=${fitted.maximumErrorMm.toFixed(3)} mm`,
      );
    }
    const bounds = profile.safeMachineBounds;
    const homeButtonScreenPoint = legacyIphoneHomeButtonScreenPoint(
      latestSample,
      profile.screen.width,
      profile.screen.height,
    );
    const homeButtonMachinePoint = homeButtonScreenPoint
      ? mapImagePointToMachine({
          imagePoints: [
            { x: 0, y: 0 },
            { x: profile.screen.width, y: 0 },
            { x: profile.screen.width, y: profile.screen.height },
            { x: 0, y: profile.screen.height },
          ],
          machinePoints: physicalScreenMachinePoints,
        }, homeButtonScreenPoint)
      : null;
    if (homeButtonMachinePoint && (
      homeButtonMachinePoint.x < bounds.minimumX ||
      homeButtonMachinePoint.x > bounds.maximumX ||
      homeButtonMachinePoint.y < bounds.minimumY ||
      homeButtonMachinePoint.y > bounds.maximumY
    )) {
      throw new Error("The calculated physical iPhone Home button is outside the arm's safe range.");
    }
    const profileWithoutNavigation = { ...profile };
    delete profileWithoutNavigation.navigation;
    const learnedProfile: ScreenHandCalibrationProfile = {
      ...profileWithoutNavigation,
      verifiedAt: new Date().toISOString(),
      machinePoints: physicalScreenMachinePoints,
      controlMachinePoints: physicalScreenMachinePoints,
      ...(homeButtonMachinePoint ? {
        navigation: {
          home: {
            strategy: "physical-button" as const,
            machinePoint: {
              x: Math.round(homeButtonMachinePoint.x * 1000) / 1000,
              y: Math.round(homeButtonMachinePoint.y * 1000) / 1000,
            },
            durationMs: 120,
            source: "legacy-ios-16x9-geometry-v1" as const,
          },
        },
      } : {}),
    };
    await activateTouchProfile(learnedProfile);
    learnedProfileActive = true;

    const validationRatios = [
      [0.32, 0.34],
      [0.50, 0.50],
      [0.68, Math.min(0.66, lowerYRatio - 0.08)],
    ];
    const validation = [];
    for (const [xRatio, yRatio] of validationRatios) {
      const target = {
        x: learnedProfile.screen.width * xRatio,
        y: learnedProfile.screen.height * yRatio,
      };
      const sample = await precisionTouchAt(learnedProfile, target);
      const expectedCameraPoint = screenPointToCamera(learnedProfile, target);
      validation.push({
        ...sample,
        browserDiagnosticErrorPx: Math.round(Math.hypot(
          sample.cluster.point.x - target.x,
          sample.cluster.point.y - target.y,
        ) * 1000) / 1000,
        cameraExpected: expectedCameraPoint,
        cameraErrorPx: Math.round(Math.hypot(
          sample.cameraMarker.point.x - expectedCameraPoint.x,
          sample.cameraMarker.point.y - expectedCameraPoint.y,
        ) * 1000) / 1000,
      });
    }
    const cameraErrors = validation.map((sample) => sample.cameraErrorPx);
    const cameraRmsePx = Math.sqrt(
      cameraErrors.reduce((sum, error) => sum + error * error, 0) /
      cameraErrors.length,
    );
    const cameraMaximumErrorPx = Math.max(...cameraErrors);
    if (
      cameraRmsePx > CAMERA_PRECISION_RMSE_PX ||
      cameraMaximumErrorPx > CAMERA_PRECISION_MAXIMUM_ERROR_PX
    ) {
      throw new Error(
        `Independent physical-camera validation did not meet the precision limit: RMSE=${cameraRmsePx.toFixed(2)} px/` +
        `MAX=${cameraMaximumErrorPx.toFixed(2)} px`,
      );
    }
    const completedAt = new Date().toISOString();
    const verifiedProfile: ScreenHandCalibrationProfile = {
      ...learnedProfile,
      verifiedAt: completedAt,
      placementCalibration: {
        method: "joint-camera-touch-v1",
        verifiedAt: completedAt,
        cameraRmsePx: Math.round(cameraRmsePx * 1000) / 1000,
        cameraMaximumErrorPx: Math.round(cameraMaximumErrorPx * 1000) / 1000,
      },
    };
    await activateTouchProfile(verifiedProfile);
    return {
      ok: true,
      mode: "joint-projective-placement-calibration",
      training,
      fitted,
      validation,
      accuracy: {
        rmsePx: Math.round(cameraRmsePx * 1000) / 1000,
        maximumErrorPx: Math.round(cameraMaximumErrorPx * 1000) / 1000,
        requiredRmsePx: CAMERA_PRECISION_RMSE_PX,
        requiredMaximumErrorPx: CAMERA_PRECISION_MAXIMUM_ERROR_PX,
      },
      navigation: verifiedProfile.navigation ?? {
        home: { strategy: "screen-gesture" },
      },
      browserCalibrationBounds: {
        lowerYRatio,
        viewportHeight: latestSample?.viewportHeight ?? null,
        screenHeight: latestSample?.screenHeight ?? null,
      },
      status: await driverRequest("/api/status"),
    };
  } catch (error) {
    if (learnedProfileActive && originalProfile) {
      try {
        await activateTouchProfile(originalProfile);
      } catch {
        // Preserve the precision error; the prior verified profile stays in memory if possible.
      }
    }
    throw error;
  } finally {
    precisionCalibrationActive = false;
  }
}

async function configureIphoneSeHomeButton() {
  if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
  if (precisionCalibrationActive || visualRecoveryActive) {
    throw new Error("A calibration operation is already running");
  }
  await requireTouchCalibrationPage();
  const profile = await activeTouchProfile();
  const samples = await touchCalibrationSamples();
  const latestSample = samples.at(-1);
  const screenPoint = legacyIphoneHomeButtonScreenPoint(
    latestSample,
    profile.screen.width,
    profile.screen.height,
  );
  if (!screenPoint) {
    throw new Error("The current phone touch dimensions do not match a supported 4.7-inch iPhone SE.");
  }
  const machinePoint = calibratedScreenPoint(profile, screenPoint);
  const bounds = profile.safeMachineBounds;
  if (
    machinePoint.x < bounds.minimumX || machinePoint.x > bounds.maximumX ||
    machinePoint.y < bounds.minimumY || machinePoint.y > bounds.maximumY
  ) {
    throw new Error("The calculated physical iPhone SE Home button is outside the arm's safe range.");
  }
  const updatedProfile: ScreenHandCalibrationProfile = {
    ...profile,
    verifiedAt: new Date().toISOString(),
    navigation: {
      home: {
        strategy: "physical-button",
        machinePoint: {
          x: Math.round(machinePoint.x * 1000) / 1000,
          y: Math.round(machinePoint.y * 1000) / 1000,
        },
        durationMs: 180,
        source: "legacy-ios-16x9-geometry-v1",
      },
    },
  };
  await activateTouchProfile(updatedProfile);
  return {
    ok: true,
    mode: "iphone-se-physical-home",
    screenPoint,
    machinePoint: updatedProfile.navigation.home.machinePoint,
    durationMs: updatedProfile.navigation.home.durationMs,
    status: await driverRequest("/api/status"),
  };
}

async function correctTouchDrift() {
  if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
  if (precisionCalibrationActive || visualRecoveryActive) {
    throw new Error("A calibration operation is already running");
  }
  await requireTouchCalibrationPage();
  const originalProfile = await activeTouchProfile();
  const status = await driverRequest("/api/status");
  if (
    status.state !== "Idle" || status.homed !== true ||
    status.reference_mode !== "manual"
  ) {
    throw new Error("Single-point realignment requires a manual arm reference and the Idle state.");
  }
  const target = {
    x: originalProfile.screen.width * 0.5,
    y: originalProfile.screen.height * 0.4,
  };
  const minimumSampleId = await latestTouchCalibrationSampleId();
  const machine = calibratedScreenPoint(originalProfile, target);
  await driverRequest("/api/tap", {
    x: machine.x,
    y: machine.y,
    durationMs: 80,
    touchZ: originalProfile.tap.touchZ,
  });
  const sample = await waitForTouchCalibrationSample(minimumSampleId);
  if (!sample) throw new Error("Single-point realignment did not detect a browser touch point.");
  const actual = calibrationSampleScreenPoint(
    sample,
    originalProfile.screen.width,
    originalProfile.screen.height,
  );
  const screenDelta = {
    x: target.x - actual.x,
    y: target.y - actual.y,
  };
  if (Math.abs(screenDelta.x) > 80 || Math.abs(screenDelta.y) > 80) {
    throw new Error(
      `The current drift is too large for single-point correction: X=${screenDelta.x.toFixed(1)} px/` +
      `Y=${screenDelta.y.toFixed(1)} px`,
    );
  }
  const controlMachinePoints = translatedControlMachinePoints({
    width: originalProfile.screen.width,
    height: originalProfile.screen.height,
    controlMachinePoints:
      originalProfile.controlMachinePoints ?? originalProfile.machinePoints,
    screenDelta,
  });
  const bounds = originalProfile.safeMachineBounds;
  if (controlMachinePoints.some((point) => (
    point.x < bounds.minimumX || point.x > bounds.maximumX ||
    point.y < bounds.minimumY || point.y > bounds.maximumY
  ))) {
    throw new Error("The screen bounds after single-point correction exceed the arm's safe range.");
  }
  const latestSample = (await touchCalibrationSamples()).at(-1);
  const homeScreenPoint = legacyIphoneHomeButtonScreenPoint(
    latestSample,
    originalProfile.screen.width,
    originalProfile.screen.height,
  );
  const homeMachinePoint = homeScreenPoint
    ? screenPointToMachine({
        width: originalProfile.screen.width,
        height: originalProfile.screen.height,
        controlMachinePoints,
        point: homeScreenPoint,
      })
    : null;
  const correctedProfile: ScreenHandCalibrationProfile = {
    ...originalProfile,
    verifiedAt: new Date().toISOString(),
    controlMachinePoints,
    ...(homeMachinePoint ? {
      navigation: {
        home: {
          strategy: "physical-button" as const,
          machinePoint: {
            x: Math.round(homeMachinePoint.x * 1000) / 1000,
            y: Math.round(homeMachinePoint.y * 1000) / 1000,
          },
          durationMs: 120,
          source: "legacy-ios-16x9-geometry-v1" as const,
        },
      },
    } : {}),
  };
  await activateTouchProfile(correctedProfile);
  try {
    const validationTarget = {
      x: correctedProfile.screen.width * 0.62,
      y: correctedProfile.screen.height * 0.58,
    };
    const validationMinimumId = await latestTouchCalibrationSampleId();
    const validationMachine = calibratedScreenPoint(
      correctedProfile,
      validationTarget,
    );
    await driverRequest("/api/tap", {
      x: validationMachine.x,
      y: validationMachine.y,
      durationMs: 80,
      touchZ: correctedProfile.tap.touchZ,
    });
    const validationSample = await waitForTouchCalibrationSample(
      validationMinimumId,
    );
    if (!validationSample) throw new Error("Single-point correction did not create an independent validation touch.");
    const validationActual = calibrationSampleScreenPoint(
      validationSample,
      correctedProfile.screen.width,
      correctedProfile.screen.height,
    );
    const errorPx = Math.hypot(
      validationActual.x - validationTarget.x,
      validationActual.y - validationTarget.y,
    );
    if (errorPx > 10) {
      throw new Error(`Single-point correction validation error: ${errorPx.toFixed(2)} px.`);
    }
    return {
      ok: true,
      mode: "single-point-drift-correction",
      target,
      actual,
      screenDelta,
      validation: {
        target: validationTarget,
        actual: validationActual,
        errorPx: Math.round(errorPx * 1000) / 1000,
      },
      navigation: correctedProfile.navigation,
      status: await driverRequest("/api/status"),
    };
  } catch (error) {
    await activateTouchProfile(originalProfile);
    throw error;
  }
}

function isVisualRecoveryStart(status: DriverStatus) {
  const x = Number(status.position?.x);
  const y = Number(status.position?.y);
  const z = Number(status.position?.z);
  const fixedStart = [
    [8, 0],
    [40, 80],
    [25, 40],
    [55, 120],
  ].some(([startX, startY]) => Math.abs(x - startX) <= 0.5 && Math.abs(y - startY) <= 0.5);
  return (
    status.state === "Idle" && status.homed !== true &&
    (status.limit_pins === "X" || status.limit_pins === "XY") &&
    Number.isFinite(x) && Number.isFinite(y) && fixedStart &&
    Number.isFinite(z) && z >= 0.8 && z <= 2.1
  );
}

async function runVisualReferenceRecovery() {
  if (!MAINTENANCE_ENABLED) throw new Error("Remote maintenance is disabled");
  if (visualRecoveryActive) throw new Error("Visual reference recovery is already running");
  if (visualRecoveryCompleted) throw new Error("Visual reference recovery already completed");
  visualRecoveryActive = true;
  let referenceEstablished = false;
  let learnedProfileActive = false;
  let originalProfile: ScreenHandCalibrationProfile | null = null;
  try {
    const profile = await activeTouchProfile();
    originalProfile = profile;
    let initial = await driverRequest("/api/status");
    let preparation: Record<string, unknown> = { attempted: false };
    let alreadyAtVisualRecoveryStart = isVisualRecoveryStart(initial);
    if (!alreadyAtVisualRecoveryStart && initial.homed !== true) {
      try {
        initial = await driverRequest("/api/maintenance/prepare-visual-retry", {});
        preparation = { attempted: true, status: "visual-retry-ready" };
        alreadyAtVisualRecoveryStart = isVisualRecoveryStart(initial);
      } catch (error) {
        preparation = {
          attempted: true,
          status: "visual-retry-unavailable",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (!alreadyAtVisualRecoveryStart && initial.homed !== true) {
      preparation = { attempted: true };
      try {
        initial = await driverRequest("/api/home-machine", {}, 55_000);
        preparation.status = "sensor-home-complete";
      } catch (error) {
        preparation.status = "sensor-home-failed";
        preparation.error = error instanceof Error ? error.message : String(error);
        initial = await driverRequest("/api/status");
      }
    }
    if (initial.homed === true && initial.state === "Idle") {
      visualRecoveryCompleted = true;
      return {
        ok: true,
        mode: "sensor-home",
        preparation,
        status: initial,
      };
    }
    if (!isVisualRecoveryStart(initial)) {
      throw new Error(
        "The arm did not reach a verified fixed visual-recovery point after automatic safe release" +
        (preparation.error ? `: ${preparation.error}` : "."),
      );
    }
    await requireTouchCalibrationPage();

    const attempts: Array<Record<string, unknown>> = [];
    let anchorScreen: { x: number; y: number } | null = null;
    let anchorSample: TouchCalibrationSample | null = null;
    let anchorController: { x: number; y: number } | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const moved = await driverRequest("/api/maintenance/probe-screen", {});
      const minimumSampleId = await latestTouchCalibrationSampleId();
      await driverRequest("/api/maintenance/tap-current", {});
      const sample = await waitForTouchCalibrationSample(minimumSampleId);
      const screen = sample
        ? calibrationSampleScreenPoint(sample, profile.screen.width, profile.screen.height)
        : null;
      attempts.push({
        attempt,
        controllerPosition: moved.position,
        screen,
        sample,
      });
      if (screen && sample) {
        anchorScreen = screen;
        anchorSample = sample;
        anchorController = {
          x: Number(moved.position?.x),
          y: Number(moved.position?.y),
        };
        break;
      }
    }
    if (
      !anchorScreen || !anchorSample || !anchorController ||
      !Number.isFinite(anchorController.x) || !Number.isFinite(anchorController.y)
    ) {
      throw new Error("No touch was detected on the ScreenHand calibration page at any of the three fixed safe positions.");
    }

    const anchorMachine = calibratedScreenPoint(profile, anchorScreen);
    const expectedValidation = validationPoint(
      anchorScreen,
      profile.screen.width,
      profile.screen.height,
    );
    const validationMachine = calibratedScreenPoint(profile, expectedValidation);
    const {
      coordinateOffset,
      validationController,
    } = validateReferenceGeometry({
      anchorMachine,
      validationMachine,
      anchorController,
      faultPins: initial.limit_pins as "X" | "XY",
      maximumControllerX: profile.safeMachineBounds.maximumX,
      maximumControllerY: profile.safeMachineBounds.maximumY,
      maximumOffsetMm: MANUAL_REFERENCE_MAX_OFFSET_MM,
      controlMachinePoints: profile.controlMachinePoints ?? profile.machinePoints,
    });

    const referenced = await driverRequest("/api/maintenance/manual-reference", {
      logicalX: anchorMachine.x,
      logicalY: anchorMachine.y,
      confirmed: true,
    });
    referenceEstablished = true;

    const validationMinimumSampleId = await latestTouchCalibrationSampleId();
    await driverRequest("/api/swipe", {
      startX: validationMachine.x,
      startY: validationMachine.y,
      endX: validationMachine.x + 1,
      endY: validationMachine.y,
      durationMs: 250,
      touchZ: profile.tap.touchZ,
    });
    const validationSample = await waitForTouchCalibrationSample(
      validationMinimumSampleId,
    );
    if (!validationSample) {
      throw new Error("The second visual-reference validation touch was not detected.");
    }
    const validationTouch = calibrationSampleScreenPoint(
      validationSample,
      profile.screen.width,
      profile.screen.height,
    );
    const initialValidationErrorPx = Math.hypot(
      validationTouch.x - expectedValidation.x,
      validationTouch.y - expectedValidation.y,
    );
    let activeProfile = profile;
    let adjustment: ReturnType<typeof adjustedControlMachinePoints> | null = null;
    let finalExpected = expectedValidation;
    let finalActual = validationTouch;
    let finalSample = validationSample;
    let finalMachine = validationMachine;
    let finalErrorPx = initialValidationErrorPx;

    if (initialValidationErrorPx > VISUAL_REFERENCE_MAX_ERROR_PX) {
      adjustment = adjustedControlMachinePoints({
        width: profile.screen.width,
        height: profile.screen.height,
        controlMachinePoints: profile.controlMachinePoints ?? profile.machinePoints,
        anchor: anchorScreen,
        expected: expectedValidation,
        actual: validationTouch,
      });
      const bounds = profile.safeMachineBounds;
      if (adjustment.controlMachinePoints.some((point) => (
        point.x < bounds.minimumX || point.x > bounds.maximumX ||
        point.y < bounds.minimumY || point.y > bounds.maximumY
      ))) {
        throw new Error("The screen bounds learned from the browser exceed the arm's safe range.");
      }
      activeProfile = {
        ...profile,
        verifiedAt: new Date().toISOString(),
        controlMachinePoints: adjustment.controlMachinePoints,
      };
      await activateTouchProfile(activeProfile);
      learnedProfileActive = true;

      finalExpected = validationPoint(
        validationTouch,
        activeProfile.screen.width,
        activeProfile.screen.height,
      );
      finalMachine = calibratedScreenPoint(activeProfile, finalExpected);
      const learnedValidationMinimumSampleId =
        await latestTouchCalibrationSampleId();
      await driverRequest("/api/swipe", {
        startX: finalMachine.x,
        startY: finalMachine.y,
        endX: finalMachine.x + 1,
        endY: finalMachine.y,
        durationMs: 250,
        touchZ: activeProfile.tap.touchZ,
      });
      const learnedValidationSample = await waitForTouchCalibrationSample(
        learnedValidationMinimumSampleId,
      );
      if (!learnedValidationSample) {
        throw new Error("The third adaptive-profile validation touch was not detected.");
      }
      finalSample = learnedValidationSample;
      finalActual = calibrationSampleScreenPoint(
        learnedValidationSample,
        activeProfile.screen.width,
        activeProfile.screen.height,
      );
      finalErrorPx = Math.hypot(
        finalActual.x - finalExpected.x,
        finalActual.y - finalExpected.y,
      );
    }
    if (finalErrorPx > VISUAL_REFERENCE_MAX_ERROR_PX) {
      throw new Error(
        `The final browser-touch validation error of ${finalErrorPx.toFixed(1)} px exceeds ` +
        `${VISUAL_REFERENCE_MAX_ERROR_PX} px`,
      );
    }

    const finalStatus = await driverRequest("/api/status");
    visualRecoveryCompleted = true;
    return {
      ok: true,
      mode: "automatic-visual-reference",
      preparation,
      attempts,
      anchor: {
        screen: anchorScreen,
        browserSample: anchorSample,
        machine: anchorMachine,
        controller: anchorController,
        coordinateOffset,
      },
      validation: {
        expected: finalExpected,
        actual: finalActual,
        browserSample: finalSample,
        machine: finalMachine,
        controller: validationController,
        initialErrorPx: Math.round(initialValidationErrorPx * 1000) / 1000,
        errorPx: Math.round(finalErrorPx * 1000) / 1000,
        maximumErrorPx: VISUAL_REFERENCE_MAX_ERROR_PX,
      },
      touchScaleAdjustment: adjustment,
      referenced,
      status: finalStatus,
    };
  } catch (error) {
    if (learnedProfileActive && originalProfile) {
      try {
        await activateTouchProfile(originalProfile);
      } catch {
        // Preserve the original recovery failure; touch remains locked below.
      }
    }
    if (referenceEstablished) {
      try {
        await driverRequest("/api/maintenance/revoke-reference", {});
      } catch {
        // The original validation error is more useful to the operator.
      }
    }
    throw error;
  } finally {
    visualRecoveryActive = false;
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    if (!originAllowed(request)) {
      sendJson(request, response, 403, { ok: false, error: "Origin is not allowed" });
      return;
    }
    response.statusCode = 204;
    setCorsHeaders(request, response);
    response.end();
    return;
  }

  if (!originAllowed(request)) {
    sendJson(request, response, 403, { ok: false, error: "Origin is not allowed" });
    return;
  }
  if (!tokenMatches(suppliedHttpToken(request))) {
    sendJson(request, response, 401, { ok: false, error: "Remote access token is invalid" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (!routeAllowed(String(request.method), url.pathname)) {
    sendJson(request, response, 404, { ok: false, error: "Remote route is unavailable" });
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/station/status") {
      const supervisorResponse = await fetch(
        new URL("/status", SUPERVISOR_UPSTREAM),
        { signal: AbortSignal.timeout(2_500) },
      );
      const payload = await supervisorResponse.json() as Record<string, unknown>;
      sendJson(request, response, supervisorResponse.ok ? 200 : 503, payload);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/maintenance/black-arm/touch-samples"
    ) {
      sendJson(request, response, 200, {
        ok: true,
        samples: await touchCalibrationSamples(),
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/maintenance/black-arm/correct-drift"
    ) {
      const body = await readBody(request);
      if (body.length && body.toString("utf8").trim() !== "{}") {
        throw new Error("Drift correction does not accept parameters");
      }
      const result = await correctTouchDrift();
      sendJson(request, response, 200, result);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/maintenance/black-arm/precision-calibration"
    ) {
      const body = await readBody(request);
      if (body.length && body.toString("utf8").trim() !== "{}") {
        throw new Error("Precision calibration does not accept parameters");
      }
      const result = await runPrecisionCalibration();
      sendJson(request, response, 200, result);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/maintenance/black-arm/configure-iphone-se-home"
    ) {
      const body = await readBody(request);
      if (body.length && body.toString("utf8").trim() !== "{}") {
        throw new Error("iPhone SE Home configuration does not accept parameters");
      }
      const result = await configureIphoneSeHomeButton();
      sendJson(request, response, 200, result);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/maintenance/black-arm/visual-reference"
    ) {
      const body = await readBody(request);
      if (body.length && body.toString("utf8").trim() !== "{}") {
        throw new Error("Automatic visual reference does not accept parameters");
      }
      const result = await runVisualReferenceRecovery();
      sendJson(request, response, 200, result);
      return;
    }
    await proxyHttp(request, response, url);
  } catch (error) {
    // A rejected maintenance operation is a device-state conflict, not a
    // broken tunnel.  Returning 502 here made Cloudflare replace our useful
    // JSON error with its generic "Bad gateway" HTML page, which in turn made
    // a healthy remote connection look offline.  Preserve 502 only for the
    // normal upstream proxy; maintenance callers now receive the real reason.
    const status = url.pathname.startsWith("/api/maintenance/") ? 409 : 502;
    sendJson(request, response, status, {
      ok: false,
      error: error instanceof Error ? error.message : "Remote gateway failed",
    });
  }
});

const liveSocketServer = new WebSocketServer({ noServer: true });

type RemoteFrameMetadata = {
  type?: string;
  role?: string;
  mimeType?: string;
  byteLength?: number;
};

async function compactRemoteJpeg(bytes: Buffer, metadata: RemoteFrameMetadata) {
  if (
    metadata.role === "verification" ||
    metadata.mimeType !== "image/jpeg"
  ) {
    return bytes;
  }
  return sharp(bytes, { failOn: "none", limitInputPixels: 4_000_000 })
    .resize({
      width: Math.round(REMOTE_FRAME_WIDTH),
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .jpeg({ quality: Math.round(REMOTE_FRAME_QUALITY) })
    .toBuffer();
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

liveSocketServer.on("connection", (client, request) => {
  const requested = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  requested.searchParams.delete("access_token");
  const upstreamUrl = new URL(`${requested.pathname}${requested.search}`, UPSTREAM);
  upstreamUrl.protocol = "ws:";
  const upstream = new WebSocket(upstreamUrl);
  let pendingFrameMetadata: RemoteFrameMetadata | null = null;
  let lastFrameSentAt = 0;
  let frameTransformActive = false;

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN && upstream.bufferedAmount < 2_000_000) {
      upstream.send(data, { binary: isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (!isBinary) {
      const text = data.toString();
      try {
        const metadata = JSON.parse(text) as RemoteFrameMetadata;
        if (metadata.type === "frame") {
          pendingFrameMetadata = metadata;
          return;
        }
      } catch {
        // Forward non-frame text unchanged.
      }
      client.send(data, { binary: false });
      return;
    }

    const metadata = pendingFrameMetadata;
    pendingFrameMetadata = null;
    if (!metadata) return;
    const now = Date.now();
    if (
      now - lastFrameSentAt < REMOTE_FRAME_INTERVAL_MS ||
      client.bufferedAmount > 512_000 ||
      frameTransformActive
    ) {
      return;
    }
    lastFrameSentAt = now;
    frameTransformActive = true;
    void (async () => {
      let bytes: Buffer<ArrayBufferLike> = Buffer.from(data as Buffer);
      try {
        bytes = await compactRemoteJpeg(bytes, metadata);
      } catch {
        // A malformed or unsupported frame remains usable in its original form.
      }
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 512_000) return;
      client.send(JSON.stringify({ ...metadata, byteLength: bytes.length }), {
        binary: false,
      });
      client.send(bytes, { binary: true });
    })().finally(() => {
      frameTransformActive = false;
    });
  });
  const closeBoth = () => {
    if (client.readyState === WebSocket.OPEN) client.close(1012, "remote link closed");
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "remote link closed");
  };
  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", closeBoth);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname !== "/api/live/socket") {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }
  if (!originAllowed(request)) {
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }
  if (!tokenMatches(url.searchParams.get("access_token") ?? "")) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }
  liveSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    liveSocketServer.emit("connection", webSocket, request);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ScreenHand remote gateway listening on http://${HOST}:${PORT}`);
  console.log(`Allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
  console.log(`Black-arm maintenance: ${MAINTENANCE_ENABLED ? "enabled" : "disabled"}`);
});

function shutdown() {
  for (const client of liveSocketServer.clients) client.close(1012, "gateway shutdown");
  liveSocketServer.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
