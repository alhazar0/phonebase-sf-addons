import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import {
  parseScreenHandCalibrationProfile,
  type ScreenHandCalibrationProfile,
} from "../agent/calibration-profile";
import { registerVisionFrames } from "../agent/vision-register";
import {
  candidatePoints,
  chooseScreenCandidate,
  detectVisionScreen,
} from "../agent/vision-screen";
import { rectifyFrame } from "../agent/rectify-frame";
import {
  detectProjectiveScreenCandidate,
  isSingleEdgeLuminousInset,
  projectiveScreenCandidateScore,
} from "../agent/projective-screen-detector";
import {
  buildAutomaticVisionBaseline,
  buildRegisteredAutoSetup,
  buildVisionBaselineProfile,
  calibrationFingerprint,
  type AutoSetupBaselineConsensus,
  type AutoSetupReference,
  type AutoSetupRegistration,
} from "./core";
import {
  attachOnScreenNavigationEvidence,
  attachPhysicalHomeButtonEvidence,
  buildUnknownPhonePlacementCandidate,
  createStationPlaneArtifact,
  parseStationPlaneArtifact,
  stationPlaneFromProfile,
  type StationPlaneArtifact,
  type UnknownPhonePlacementCandidate,
} from "./station-plane";
import { detectOnScreenNavigation } from "./on-screen-navigation";
import { detectPhysicalHomeButton } from "./physical-home-button";
import { readStoredReference, resolveSetupReference, materializeCompatibleReference, type ReferenceReuseInfo, type StoredReference } from "./reference-store";

const HOST = process.env.SCREENHAND_AUTO_SETUP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SCREENHAND_AUTO_SETUP_PORT ?? 3031);
const CONTROL_PLANE_URL = new URL(
  process.env.SCREENHAND_CONTROL_PLANE_URL ?? "http://127.0.0.1:3013",
);
const STATE_DIRECTORY = resolve(
  process.env.SCREENHAND_AUTO_SETUP_STATE_DIRECTORY ?? ".runtime/auto-setup",
);
const PREVIOUS_REFERENCE_DIRECTORY = process.env.SCREENHAND_AUTO_SETUP_REFERENCE_DIRECTORY?.trim() || undefined;
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const HOME_TIMEOUT_MS = 65_000;
const FRAME_QUALITY_SAMPLE_SIZE = 64;
const MIN_FRAME_LUMA_RANGE = 18;
const MIN_FRAME_LUMA_STANDARD_DEVIATION = 2.5;
const AUTOMATIC_BASELINE_FRAME_COUNT = 3;
const AUTOMATIC_BASELINE_TIMEOUT_MS = 2_500;
const MINIMUM_IDENTITY_OUTLINE_CONFIDENCE = 0.9;
const MINIMUM_IDENTITY_OUTLINE_SCORE = 0.72;
const MINIMUM_IDENTITY_OUTLINE_MARGIN = 0.08;
const MAXIMUM_IDENTITY_MEAN_ERROR_RATIO = 0.015;
const MAXIMUM_IDENTITY_CORNER_ERROR_RATIO = 0.025;
const activeDeviceMutations = new Set<string>();

type DeviceSnapshot = {
  id: string;
  connected: boolean;
  capabilities?: {
    observation?: {
      screenshot?: {
        available?: boolean;
        reason?: string;
      };
    };
  };
  state?: {
    cameraReady?: boolean;
    cameraDetail?: string;
    grbl?: {
      connected?: boolean;
      homed?: boolean;
      state?: string;
      activeOperation?: unknown;
      movementBounds?: {
        minimumX?: number;
        maximumX?: number;
        minimumY?: number;
        maximumY?: number;
      };
      calibrationMovementBounds?: {
        minimumX?: number;
        maximumX?: number;
        minimumY?: number;
        maximumY?: number;
      };
    };
  };
  screen?: {
    width?: number;
    height?: number;
    rawWidth?: number;
    rawHeight?: number;
    sequence?: number;
    source?: string;
  };
};

type CameraFrame = {
  bytes: Buffer;
  width: number;
  height: number;
  sequence: number;
  sha256: string;
};

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
  activeImagePoints: ScreenHandCalibrationProfile["imagePoints"];
  proposedImagePoints: ScreenHandCalibrationProfile["imagePoints"] | null;
  referenceCapturedAt: string | null;
  referenceReuse?: ReferenceReuseInfo;
  registration: Omit<AutoSetupRegistration, "profile"> | null;
  rectangleProposal?: {
    confidence: number;
    score: number;
    points: ScreenHandCalibrationProfile["imagePoints"];
  } | null;
  automaticBaseline?: {
    frameCount: number;
    confidence: number;
    score: number;
    meanDeviationPx: number;
    maximumDeviationPx: number;
    elapsedMs: number;
  } | null;
  unknownPhoneCandidate?: UnknownPhonePlacementCandidate | null;
};

type AutomaticBaselineCandidate = {
  consensus: AutoSetupBaselineConsensus;
  frame: CameraFrame;
};

class AutoSetupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "AUTO_SETUP_ERROR",
  ) {
    super(message);
  }
}

function safeDeviceId(deviceId: string) {
  const safe = deviceId.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe) throw new AutoSetupError("A device ID is required.", 400, "INVALID_DEVICE");
  return safe;
}

function referencePaths(deviceId: string) {
  const safe = safeDeviceId(deviceId);
  return {
    metadata: resolve(STATE_DIRECTORY, `${safe}.json`),
    image: resolve(STATE_DIRECTORY, `${safe}.jpg`),
  };
}

function stationPlanePath(deviceId: string) {
  return resolve(STATE_DIRECTORY, `${safeDeviceId(deviceId)}.station-plane.json`);
}

async function withDeviceMutationLock<T>(
  deviceId: string,
  operation: () => Promise<T>,
) {
  if (activeDeviceMutations.has(deviceId)) {
    throw new AutoSetupError(
      "Another automatic setup operation is already running for this device.",
      409,
      "AUTO_SETUP_BUSY",
    );
  }
  activeDeviceMutations.add(deviceId);
  try {
    return await operation();
  } finally {
    activeDeviceMutations.delete(deviceId);
  }
}

function sendJson(
  response: ServerResponse,
  payload: unknown,
  status = 200,
) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:3011");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new AutoSetupError("Request body is too large.", 413, "BODY_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  if (!size) return {} as Record<string, unknown>;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function controlPlaneFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, CONTROL_PLANE_URL), {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  return response;
}

async function controlPlaneJson<T>(path: string, init: RequestInit = {}) {
  const response = await controlPlaneFetch(path, init);
  const payload = await response.json() as T & { error?: string; code?: string };
  if (!response.ok) {
    throw new AutoSetupError(
      payload.error ?? `Control plane returned HTTP ${response.status}.`,
      response.status,
      payload.code ?? "CONTROL_PLANE_ERROR",
    );
  }
  return payload;
}

async function fetchDevice(deviceId: string) {
  const payload = await controlPlaneJson<{ ok: boolean; device: DeviceSnapshot }>(
    `/api/v1/devices/${encodeURIComponent(deviceId)}`,
  );
  const device = payload.device;
  if (!device?.connected) {
    throw new AutoSetupError(
      "The physical ScreenHand device is offline.",
      409,
      "DEVICE_NOT_READY",
    );
  }
  const freshRelayedFrame =
    device.capabilities?.observation?.screenshot?.available === true;
  if (device.state?.cameraReady !== true && !freshRelayedFrame) {
    throw new AutoSetupError(
      device.capabilities?.observation?.screenshot?.reason ||
        device.state?.cameraDetail ||
        "A fresh physical camera frame is required.",
      409,
      "CAMERA_NOT_READY",
    );
  }
  if (device.state.grbl?.connected !== true) {
    throw new AutoSetupError(
      "The GRBL controller is offline.",
      409,
      "CONTROLLER_OFFLINE",
    );
  }
  return device;
}

async function fetchCalibration(deviceId: string) {
  const payload = await controlPlaneJson<{
    ok: boolean;
    calibration: { active?: unknown };
  }>(`/api/v1/devices/${encodeURIComponent(deviceId)}/calibration`);
  if (!payload.calibration?.active) {
    throw new AutoSetupError(
      "This station needs one verified four-corner calibration before visual recovery can be enabled.",
      409,
      "CALIBRATION_REQUIRED",
    );
  }
  return parseScreenHandCalibrationProfile(payload.calibration.active);
}

async function fetchPhysicalFrame(
  deviceId: string,
  requestedSequence?: number,
): Promise<CameraFrame> {
  const sequenceQuery = requestedSequence === undefined
    ? ""
    : `&sequence=${encodeURIComponent(String(requestedSequence))}`;
  const response = await controlPlaneFetch(
    `/api/frame?raw=1&deviceId=${encodeURIComponent(deviceId)}${sequenceQuery}`,
  );
  if (!response.ok) {
    throw new AutoSetupError(
      `A fresh physical camera frame is unavailable (HTTP ${response.status}).`,
      response.status,
      "FRAME_UNAVAILABLE",
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(bytes).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const sequence = Number(
    response.headers.get("x-screenhand-frame-sequence") ??
      response.headers.get("x-phonebase-frame-sequence"),
  );
  if (!width || !height || !Number.isInteger(sequence) || sequence <= 0) {
    throw new AutoSetupError(
      "The physical camera returned incomplete frame metadata.",
      503,
      "FRAME_INVALID",
    );
  }
  return {
    bytes,
    width,
    height,
    sequence,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function collectFreshFrames(
  deviceId: string,
  firstFrame: CameraFrame,
) {
  const frames = [firstFrame];
  const deadline = Date.now() + AUTOMATIC_BASELINE_TIMEOUT_MS;
  while (frames.length < AUTOMATIC_BASELINE_FRAME_COUNT && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const frame = await fetchPhysicalFrame(deviceId);
    if (frames.some((candidate) => candidate.sequence === frame.sequence)) continue;
    await requireObservableCameraFrame(frame);
    frames.push(frame);
  }
  if (frames.length < AUTOMATIC_BASELINE_FRAME_COUNT) {
    throw new Error(
      `The camera did not deliver ${AUTOMATIC_BASELINE_FRAME_COUNT} fresh frames in time.`,
    );
  }
  return frames;
}

async function collectAutomaticBaseline(input: {
  deviceId: string;
  device: DeviceSnapshot;
  profile: ScreenHandCalibrationProfile;
  firstFrame: CameraFrame;
}): Promise<AutomaticBaselineCandidate> {
  const startedAt = performance.now();
  const frames = await collectFreshFrames(input.deviceId, input.firstFrame);
  const expectedScreenAspectRatio = input.profile.screen.width /
    input.profile.screen.height;
  const detections = await Promise.all(frames.map(async (frame) => {
    const result = await detectVisionScreen(
      frame.bytes,
      undefined,
      expectedScreenAspectRatio,
    );
    const choice = chooseScreenCandidate({
      result,
      expectedPoints: input.profile.imagePoints,
      expectedScreenAspectRatio,
    });
    if (!choice.selected) {
      throw new Error("No unambiguous full-screen outline was found in every fresh frame.");
    }
    return {
      sequence: frame.sequence,
      frame: { width: frame.width, height: frame.height },
      points: choice.selected.points,
      confidence: choice.selected.confidence,
      score: choice.selected.score,
      runnerUpScore: choice.ranked[1]?.score ?? null,
      elapsedMs: result.elapsedMs,
    };
  }));
  const consensus = buildAutomaticVisionBaseline({
    currentProfile: input.profile,
    observations: detections,
    movementBounds: movementBounds(input.device),
    calibrationMovementBounds: movementBounds(
      input.device,
      "calibrationMovementBounds",
    ),
  });
  return {
    consensus: {
      ...consensus,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    },
    frame: frames.at(-1) ?? input.firstFrame,
  };
}

async function loadStationPlane(deviceId: string) {
  try {
    return parseStationPlaneArtifact(JSON.parse(
      await readFile(stationPlanePath(deviceId), "utf8"),
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function stationPlaneForProfile(
  deviceId: string,
  profile: ScreenHandCalibrationProfile,
): Promise<StationPlaneArtifact | null> {
  if (profile.deviceId !== deviceId) {
    throw new Error("The active calibration belongs to another hardware device.");
  }
  const saved = await loadStationPlane(deviceId);
  if (saved) {
    if (saved.calibration.deviceId !== deviceId) {
      throw new Error("The saved station plane belongs to another hardware device.");
    }
    return saved;
  }
  try {
    return createStationPlaneArtifact(stationPlaneFromProfile(profile));
  } catch {
    return null;
  }
}

async function saveStationPlaneIfAvailable(
  deviceId: string,
  profile: ScreenHandCalibrationProfile,
) {
  if (profile.deviceId !== deviceId) {
    throw new Error("The active calibration belongs to another hardware device.");
  }
  const existing = await loadStationPlane(deviceId);
  if (existing) {
    if (existing.calibration.deviceId !== deviceId) {
      throw new Error("The saved station plane belongs to another hardware device.");
    }
    return existing;
  }
  let artifact: StationPlaneArtifact;
  try {
    artifact = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  } catch {
    return null;
  }
  const path = stationPlanePath(deviceId);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return artifact;
}

async function collectUnknownPhoneCandidate(input: {
  deviceId: string;
  device: DeviceSnapshot;
  profile: ScreenHandCalibrationProfile;
  firstFrame: CameraFrame;
}) {
  const station = await stationPlaneForProfile(input.deviceId, input.profile);
  if (!station) {
    throw new Error(
      "This station has no independent joint camera/touch plane for an unknown phone.",
    );
  }
  const frames = await collectFreshFrames(input.deviceId, input.firstFrame);
  const detections = await Promise.all(frames.map(async (frame) => {
    // An unknown phone must not inherit the old phone's display aspect ratio.
    // Disable aspect-derived luminous-edge inference here so it cannot
    // manufacture a familiar 19.5:9 outline from unrelated bright content.
    // The independent projective fallback below must fit all four boundaries
    // without a handset aspect prior.
    const startedAt = performance.now();
    const [result, projective] = await Promise.all([
      detectVisionScreen(frame.bytes, undefined, null),
      detectProjectiveScreenCandidate(frame.bytes),
    ]);
    const choice = chooseScreenCandidate({ result });
    const projectiveScore = projective
      ? projectiveScreenCandidateScore({
          candidate: projective,
          imageWidth: frame.width,
          imageHeight: frame.height,
        })
      : 0;
    if (choice.selected && projective) {
      const projectivePoints = candidatePoints(projective);
      const errors = choice.selected.points.map((point, index) =>
        Math.hypot(
          point.x - projectivePoints[index].x,
          point.y - projectivePoints[index].y,
        )
      );
      const diagonal = Math.hypot(frame.width, frame.height);
      const meanError = errors.reduce((sum, value) => sum + value, 0) /
        errors.length;
      if (
        meanError > diagonal * 0.02 ||
        Math.max(...errors) > diagonal * 0.035
      ) {
        throw new Error("Independent full-screen detectors disagree under occlusion.");
      }
    }
    const selected = choice.selected ?? (projective && projectiveScore >= 0.72
      ? {
          points: candidatePoints(projective),
          confidence: projective.confidence,
          score: projectiveScore,
        }
      : null);
    if (!selected) {
      throw new Error("No stable full-screen outline was found for the unknown phone.");
    }
    const regularRunnerUp = choice.selected
      ? choice.ranked[1]?.score ?? null
      : choice.ranked[0]?.score ?? null;
    return {
      sequence: frame.sequence,
      frame: { width: frame.width, height: frame.height },
      points: selected.points,
      confidence: selected.confidence,
      score: selected.score,
      runnerUpScore: regularRunnerUp,
      elapsedMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    };
  }));
  const candidate = buildUnknownPhonePlacementCandidate({
    station,
    observations: detections,
    movementBounds: movementBounds(input.device),
    calibrationMovementBounds: movementBounds(
      input.device,
      "calibrationMovementBounds",
    ),
  });
  const latestFrame = frames.at(-1);
  if (!latestFrame) return candidate;
  const canonicalWidth = 360;
  const canonicalHeight = Math.round(
    canonicalWidth * candidate.canonicalScreen.height /
      candidate.canonicalScreen.width,
  );
  const [physicalHomeResult, onScreenNavigationResult] = await Promise.allSettled([
    detectPhysicalHomeButton({
      imageBytes: latestFrame.bytes,
      frame: { width: latestFrame.width, height: latestFrame.height },
      screenPoints: candidate.imagePoints,
      screenAspectRatio: candidate.canonicalScreen.aspectRatio,
    }),
    rectifyFrame(latestFrame.bytes, {
      rawWidth: latestFrame.width,
      rawHeight: latestFrame.height,
      screenWidth: canonicalWidth,
      screenHeight: canonicalHeight,
      imagePoints: candidate.imagePoints,
    }).then((imageBytes) => detectOnScreenNavigation({
      imageBytes,
      viewport: {
        width: candidate.canonicalScreen.width,
        height: candidate.canonicalScreen.height,
      },
    })),
  ]);
  let enriched = candidate;
  if (physicalHomeResult.status === "fulfilled") {
    enriched = attachPhysicalHomeButtonEvidence({
      candidate: enriched,
      station,
      observation: physicalHomeResult.value,
      movementBounds: movementBounds(input.device),
    });
  }
  if (onScreenNavigationResult.status === "fulfilled") {
    enriched = attachOnScreenNavigationEvidence({
      candidate: enriched,
      station,
      observation: onScreenNavigationResult.value,
      movementBounds: movementBounds(input.device),
    });
  }
  // Both detectors are optional and fail closed. Unknown-phone XY remains
  // useful in Shadow when the lower bezel is cropped, the display is asleep,
  // or system navigation is visually ambiguous.
  return enriched;
}

function unknownPhonePreview(input: {
  deviceId: string;
  device: DeviceSnapshot;
  profile: ScreenHandCalibrationProfile;
  candidate: UnknownPhonePlacementCandidate;
  referenceCapturedAt: string | null;
  priorFailure: string;
}): AutoSetupPreview {
  const lastSequence = input.candidate.frame.sequences.at(-1);
  if (!lastSequence) {
    throw new Error("The unknown-phone consensus has no camera sequence.");
  }
  return {
    ok: true,
    status: "unknown_phone_detected",
    deviceId: input.deviceId,
    reason:
      `${input.priorFailure} A stable, untrusted phone outline was mapped to ` +
      "station XY in Shadow mode. Touch and Home remain locked until this " +
      "phone's contact depth and navigation strategy are verified.",
    homed: input.device.state?.grbl?.homed === true,
    frame: {
      width: input.candidate.frame.width,
      height: input.candidate.frame.height,
      sequence: lastSequence,
    },
    activeImagePoints: input.profile.imagePoints,
    proposedImagePoints: input.candidate.imagePoints,
    referenceCapturedAt: input.referenceCapturedAt,
    registration: null,
    rectangleProposal: {
      confidence: input.candidate.confidence,
      score: input.candidate.score,
      points: input.candidate.imagePoints,
    },
    automaticBaseline: null,
    unknownPhoneCandidate: input.candidate,
  };
}

async function rejectContradictoryScreenOutline(
  frame: CameraFrame,
  registeredPoints: ScreenHandCalibrationProfile["imagePoints"],
) {
  // Content registration answers "can these pixels be transformed?" It does
  // not prove that the same physical display is present. A strong raw outline
  // is independent counter-evidence: when it disagrees, never inherit the old
  // phone's touch depth. Ambiguous or absent outlines do not veto a trusted
  // reference because dark screens often hide their boundary.
  const [result, projective] = await Promise.all([
    detectVisionScreen(frame.bytes, undefined, null),
    detectProjectiveScreenCandidate(frame.bytes),
  ]);
  const choice = chooseScreenCandidate({ result });
  const outlines: Array<{
    points: ScreenHandCalibrationProfile["imagePoints"];
  }> = [];
  const outline = choice.selected;
  if (
    outline &&
    outline.confidence >= MINIMUM_IDENTITY_OUTLINE_CONFIDENCE &&
    outline.score >= MINIMUM_IDENTITY_OUTLINE_SCORE &&
    (
      choice.ranked[1] === undefined ||
      outline.score - choice.ranked[1].score >= MINIMUM_IDENTITY_OUTLINE_MARGIN
    )
  ) outlines.push({ points: outline.points });
  if (
    projective &&
    projective.confidence >= MINIMUM_IDENTITY_OUTLINE_CONFIDENCE &&
    projectiveScreenCandidateScore({
      candidate: projective,
      imageWidth: frame.width,
      imageHeight: frame.height,
    }) >= MINIMUM_IDENTITY_OUTLINE_SCORE
  ) outlines.push({ points: candidatePoints(projective) });
  const diagonal = Math.hypot(frame.width, frame.height);
  for (const candidate of outlines) {
    const errors = candidate.points.map((point, index) => Math.hypot(
      point.x - registeredPoints[index].x,
      point.y - registeredPoints[index].y,
    ));
    const meanError = errors.reduce((sum, value) => sum + value, 0) /
      errors.length;
    const maximumError = Math.max(...errors);
    if (
      (
        meanError > diagonal * MAXIMUM_IDENTITY_MEAN_ERROR_RATIO ||
        maximumError > diagonal * MAXIMUM_IDENTITY_CORNER_ERROR_RATIO
      ) &&
      !isSingleEdgeLuminousInset(candidate.points, registeredPoints)
    ) {
      throw new Error(
        `The physical screen outline contradicts the saved-phone registration ` +
          `(mean ${meanError.toFixed(1)} px, max ${maximumError.toFixed(1)} px).`,
      );
    }
  }
}

async function requireObservableCameraFrame(frame: CameraFrame) {
  const sample = await sharp(frame.bytes)
    .greyscale()
    .resize(FRAME_QUALITY_SAMPLE_SIZE, FRAME_QUALITY_SAMPLE_SIZE, {
      fit: "fill",
      kernel: "nearest",
    })
    .raw()
    .toBuffer();
  let minimum = 255;
  let maximum = 0;
  let sum = 0;
  let squaredSum = 0;
  for (const luminance of sample) {
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
    sum += luminance;
    squaredSum += luminance * luminance;
  }
  const mean = sum / sample.length;
  const variance = Math.max(0, (squaredSum / sample.length) - (mean * mean));
  const standardDeviation = Math.sqrt(variance);
  if (
    maximum - minimum < MIN_FRAME_LUMA_RANGE ||
    standardDeviation < MIN_FRAME_LUMA_STANDARD_DEVIATION
  ) {
    throw new AutoSetupError(
      "The camera frame is effectively blank. Allow ScreenHand Camera access, " +
        "uncover the lens, and light the phone before visual setup.",
      409,
      "CAMERA_FRAME_UNUSABLE",
    );
  }
}

function movementBounds(
  device: DeviceSnapshot,
  kind: "movementBounds" | "calibrationMovementBounds" = "movementBounds",
) {
  const bounds = device.state?.grbl?.[kind] ?? device.state?.grbl?.movementBounds;
  return {
    minimumX: Number(bounds?.minimumX),
    maximumX: Number(bounds?.maximumX),
    minimumY: Number(bounds?.minimumY),
    maximumY: Number(bounds?.maximumY),
  };
}

async function loadReference(deviceId: string) {
  return readStoredReference(STATE_DIRECTORY, deviceId);
}

async function saveReference(
  deviceId: string,
  calibration: ScreenHandCalibrationProfile,
  frame: CameraFrame,
) {
  const paths = referencePaths(deviceId);
  const reference: AutoSetupReference = {
    version: 2,
    deviceId,
    calibrationId: calibration.id,
    capturedAt: new Date().toISOString(),
    baselineCalibrationSha256: calibrationFingerprint(calibration),
    authorizedCalibrationSha256: calibrationFingerprint(calibration),
    frame: {
      width: frame.width,
      height: frame.height,
      sequence: frame.sequence,
      sha256: frame.sha256,
    },
    calibration,
  };
  await mkdir(dirname(paths.metadata), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`;
  const temporaryImage = `${paths.image}.${suffix}.tmp`;
  await Promise.all([
    writeFile(temporaryMetadata, `${JSON.stringify(reference, null, 2)}\n`, "utf8"),
    writeFile(temporaryImage, frame.bytes),
  ]);
  await rename(temporaryImage, paths.image);
  await rename(temporaryMetadata, paths.metadata);
  return reference;
}

async function authorizeReferenceProfile(
  deviceId: string,
  profile: ScreenHandCalibrationProfile,
) {
  const saved = await loadReference(deviceId);
  if (!saved || saved.reference.calibrationId !== profile.id) {
    throw new AutoSetupError(
      "The trusted camera reference changed before the profile was activated.",
      409,
      "REFERENCE_CHANGED",
    );
  }
  const paths = referencePaths(deviceId);
  const updated: AutoSetupReference = {
    ...saved.reference,
    authorizedCalibrationSha256: calibrationFingerprint(profile),
  };
  const temporaryMetadata = `${paths.metadata}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryMetadata, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await rename(temporaryMetadata, paths.metadata);
}

async function previewAutoSetup(deviceId: string): Promise<{
  preview: AutoSetupPreview;
  registration: AutoSetupRegistration | null;
  automaticBaseline: AutomaticBaselineCandidate | null;
}> {
  const [device, profile, frame] = await Promise.all([
    fetchDevice(deviceId),
    fetchCalibration(deviceId),
    fetchPhysicalFrame(deviceId),
  ]);
  if (frame.width !== profile.frame.width || frame.height !== profile.frame.height) {
    throw new AutoSetupError(
      `Camera resolution ${frame.width}×${frame.height} does not match the saved ` +
        `${profile.frame.width}×${profile.frame.height} profile.`,
      409,
      "CAMERA_RESOLUTION_CHANGED",
    );
  }
  await requireObservableCameraFrame(frame);
  const selection = await resolveSetupReference({localDirectory:STATE_DIRECTORY,previousDirectory:PREVIOUS_REFERENCE_DIRECTORY,deviceId,profile});
  const result = await previewWithReference({deviceId,device,profile,frame,saved:selection.saved});
  result.preview.referenceReuse=selection.reuse;
  return result;
}

async function previewWithReference({deviceId,device,profile,frame,saved}: {
  deviceId:string;device:DeviceSnapshot;profile:ScreenHandCalibrationProfile;frame:CameraFrame;saved:StoredReference|null;
}): Promise<{preview:AutoSetupPreview;registration:AutoSetupRegistration|null;automaticBaseline:AutomaticBaselineCandidate|null}> {
  if (!saved) {
    let automaticFailure = "";
    try {
      const automaticBaseline = await collectAutomaticBaseline({
        deviceId,
        device,
        profile,
        firstFrame: frame,
      });
      const { consensus } = automaticBaseline;
      return {
        registration: null,
        automaticBaseline,
        preview: {
          ok: true,
          status: "automatic_baseline_ready",
          deviceId,
          reason:
            "Three fresh camera frames agree on the phone screen. No corner selection is required; clear the workspace to activate it automatically.",
          homed: device.state?.grbl?.homed === true,
          frame: {
            width: automaticBaseline.frame.width,
            height: automaticBaseline.frame.height,
            sequence: automaticBaseline.frame.sequence,
          },
          activeImagePoints: profile.imagePoints,
          proposedImagePoints: consensus.imagePoints,
          referenceCapturedAt: null,
          registration: null,
          rectangleProposal: {
            confidence: consensus.confidence,
            score: consensus.score,
            points: consensus.imagePoints,
          },
          automaticBaseline: {
            frameCount: consensus.frameSequences.length,
            confidence: consensus.confidence,
            score: consensus.score,
            meanDeviationPx: consensus.meanDeviationPx,
            maximumDeviationPx: consensus.maximumDeviationPx,
            elapsedMs: consensus.elapsedMs,
          },
        },
      };
    } catch (error) {
      automaticFailure = error instanceof Error
        ? error.message
        : "Automatic three-frame screen verification failed.";
    }
    let unknownPhoneFailure = "";
    try {
      const candidate = await collectUnknownPhoneCandidate({
        deviceId,
        device,
        profile,
        firstFrame: frame,
      });
      return {
        registration: null,
        automaticBaseline: null,
        preview: unknownPhonePreview({
          deviceId,
          device,
          profile,
          candidate,
          referenceCapturedAt: null,
          priorFailure: automaticFailure,
        }),
      };
    } catch (error) {
      unknownPhoneFailure = error instanceof Error
        ? error.message
        : "Unknown-phone Shadow mapping failed.";
    }
    const detected = await detectVisionScreen(
      frame.bytes,
      undefined,
      profile.screen.width / profile.screen.height,
    );
    const rectangle = chooseScreenCandidate({
      result: detected,
      expectedPoints: profile.imagePoints,
      expectedScreenAspectRatio: profile.screen.width / profile.screen.height,
    }).selected;
    return {
      registration: null,
      automaticBaseline: null,
      preview: {
        ok: true,
        status: "baseline_required",
        deviceId,
        reason: rectangle
          ? `${automaticFailure} ${unknownPhoneFailure} Verify the overlay once to save the visual reference.`
          : `${automaticFailure} ${unknownPhoneFailure} The screen boundary needs manual review once; future reconnects will register automatically.`,
        homed: device.state?.grbl?.homed === true,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: profile.imagePoints,
        proposedImagePoints: rectangle?.points ?? null,
        referenceCapturedAt: null,
        registration: null,
        rectangleProposal: rectangle
          ? {
              confidence: rectangle.confidence,
              score: rectangle.score,
              points: rectangle.points,
            }
          : null,
        automaticBaseline: null,
      },
    };
  }

  if (
    saved.reference.authorizedCalibrationSha256 !== calibrationFingerprint(profile)
  ) {
    return {
      registration: null,
      automaticBaseline: null,
      preview: {
        ok: true,
        status: "manual_review",
        deviceId,
        reason: "The active calibration changed after this visual reference was approved. Verify and save a new reference once.",
        homed: device.state?.grbl?.homed === true,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: profile.imagePoints,
        proposedImagePoints: null,
        referenceCapturedAt: saved.reference.capturedAt,
        registration: null,
      },
    };
  }

  try {
    const vision = await registerVisionFrames(saved.bytes, frame.bytes);
    const registered = buildRegisteredAutoSetup({
      reference: saved.reference,
      currentProfile: profile,
      registration: vision,
      movementBounds: movementBounds(device),
      calibrationMovementBounds: movementBounds(
        device,
        "calibrationMovementBounds",
      ),
    });
    await rejectContradictoryScreenOutline(frame, registered.imagePoints);
    const publicRegistration: Omit<AutoSetupRegistration, "profile"> = {
      imagePoints: registered.imagePoints,
      machinePoints: registered.machinePoints,
      ...(registered.controlMachinePoints
        ? { controlMachinePoints: registered.controlMachinePoints }
        : {}),
      meanDriftPx: registered.meanDriftPx,
      maximumDriftPx: registered.maximumDriftPx,
      confidence: registered.confidence,
      elapsedMs: registered.elapsedMs,
    };
    return {
      registration: registered,
      automaticBaseline: null,
      preview: {
        ok: true,
        status: "ready",
        deviceId,
        reason: registered.maximumDriftPx < 2
          ? "The camera and phone match the saved visual reference."
          : "The phone shift was recovered from the saved camera reference.",
        homed: device.state?.grbl?.homed === true,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: profile.imagePoints,
        proposedImagePoints: registered.imagePoints,
        referenceCapturedAt: saved.reference.capturedAt,
        registration: publicRegistration,
      },
    };
  } catch (error) {
    const registrationFailure = error instanceof Error
      ? error.message
      : "Visual registration failed.";
    try {
      const candidate = await collectUnknownPhoneCandidate({
        deviceId,
        device,
        profile,
        firstFrame: frame,
      });
      return {
        registration: null,
        automaticBaseline: null,
        preview: unknownPhonePreview({
          deviceId,
          device,
          profile,
          candidate,
          referenceCapturedAt: saved.reference.capturedAt,
          priorFailure: registrationFailure,
        }),
      };
    } catch (unknownPhoneError) {
      const unknownPhoneFailure = unknownPhoneError instanceof Error
        ? unknownPhoneError.message
        : "Unknown-phone Shadow mapping failed.";
      return {
        registration: null,
        automaticBaseline: null,
        preview: {
          ok: true,
          status: "manual_review",
          deviceId,
          reason: `${registrationFailure} ${unknownPhoneFailure}`,
          homed: device.state?.grbl?.homed === true,
          frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
          activeImagePoints: profile.imagePoints,
          proposedImagePoints: null,
          referenceCapturedAt: saved.reference.capturedAt,
          registration: null,
        },
      };
    }
  }
}

async function activateProfile(
  deviceId: string,
  profile: ScreenHandCalibrationProfile,
) {
  try {
    await controlPlaneJson(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/calibration`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "visual_recovery",
          confirmation: "TRUSTED_CAMERA_REFERENCE_MATCHED",
          profile,
        }),
      },
    );
  } catch (error) {
    const legacyControlPlane = error instanceof AutoSetupError &&
      (
        (
          error.status === 400 &&
          error.code === "INVALID_CALIBRATION" &&
          /Unsupported calibration operation: visual_recovery/.test(error.message)
        ) ||
        (
          error.status === 409 &&
          error.code === "CALIBRATION_NOT_STARTED"
        )
      );
    if (!legacyControlPlane) throw error;

    // The stable :3013 service predates the dedicated visual-recovery route.
    // Its loopback-only recovery endpoint applies the same parsed profile and
    // profile-ID checks; keep this exact fallback until the branch is merged.
    await controlPlaneJson("/api/touch-calibration/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await controlPlaneJson("/api/touch-calibration/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "TOUCH_PAGE_POINTS_VERIFIED",
        profile,
      }),
    });
  }
  await authorizeReferenceProfile(deviceId, profile);
}

async function waitForHome(deviceId: string, receiptId: string) {
  const deadline = Date.now() + HOME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await controlPlaneJson<{
      receipt: { status: string; error?: string | null };
    }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receiptId)}`,
    );
    if (payload.receipt.status === "completed") return;
    if (payload.receipt.status === "failed") {
      throw new AutoSetupError(
        payload.receipt.error ?? "Machine homing failed.",
        409,
        "HOME_FAILED",
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  throw new AutoSetupError("Machine homing timed out.", 504, "HOME_TIMEOUT");
}

async function homeIfRequired(deviceId: string) {
  const device = await fetchDevice(deviceId);
  if (device.state?.grbl?.homed === true) return { performed: false };
  const idempotencyKey = `auto-setup-home-${randomUUID()}`;
  const payload = await controlPlaneJson<{
    result: { receipt?: { id?: string } };
  }>(`/api/v1/devices/${encodeURIComponent(deviceId)}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey,
      action: {
        type: "home",
        confirmation: "CLEAR_WORKSPACE_AND_HOME",
      },
    }),
  });
  const receiptId = payload.result.receipt?.id;
  if (!receiptId) {
    throw new AutoSetupError("The control plane did not return a Home receipt.", 502);
  }
  await waitForHome(deviceId, receiptId);
  return { performed: true, receiptId };
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, {}, 204);
    return;
  }
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (request.method === "GET" && ["/", "/health"].includes(url.pathname)) {
      sendJson(response, {
        ok: true,
        service: "ScreenHand vision auto-setup",
        controlPlane: CONTROL_PLANE_URL.origin,
      });
      return;
    }

    const match = url.pathname.match(
      /^\/v1\/devices\/([^/]+)\/(preview|reference|run)$/,
    );
    if (!match || request.method !== "POST") {
      throw new AutoSetupError("Not found.", 404, "NOT_FOUND");
    }
    const deviceId = decodeURIComponent(match[1]);
    const operation = match[2];
    const input = await readJson(request);

    if (operation === "preview") {
      const { preview } = await previewAutoSetup(deviceId);
      sendJson(response, preview);
      return;
    }

    if (operation === "reference") {
      const reference = await withDeviceMutationLock(deviceId, async () => {
        const adoptVisionProposal = input.adoptVisionProposal === true;
        const expectedConfirmation = adoptVisionProposal
          ? "VISION_PROPOSAL_MATCHES_PHYSICAL_SCREEN"
          : "CURRENT_PLACEMENT_MATCHES_ACTIVE_CALIBRATION";
        if (input.confirmation !== expectedConfirmation) {
          throw new AutoSetupError(
            "Confirm that the displayed corners match the physical screen before saving the visual reference.",
            409,
            "REFERENCE_CONFIRMATION_REQUIRED",
          );
        }
        const requestedSequence = Number(input.frameSequence);
        if (!Number.isInteger(requestedSequence) || requestedSequence <= 0) {
          throw new AutoSetupError(
            "Save reference requires the exact reviewed frame sequence.",
            400,
            "FRAME_SEQUENCE_REQUIRED",
          );
        }
        const [device, profile, frame] = await Promise.all([
          fetchDevice(deviceId),
          fetchCalibration(deviceId),
          fetchPhysicalFrame(deviceId, requestedSequence),
        ]);
        if (requestedSequence !== frame.sequence) {
          throw new AutoSetupError(
            "The camera advanced after the reviewed frame. Preview again before saving.",
            409,
            "STALE_FRAME",
          );
        }
        await requireObservableCameraFrame(frame);
        let referenceProfile = profile;
        if (adoptVisionProposal) {
          const detected = await detectVisionScreen(
            frame.bytes,
            undefined,
            profile.screen.width / profile.screen.height,
          );
          const proposal = chooseScreenCandidate({
            result: detected,
            expectedPoints: profile.imagePoints,
            expectedScreenAspectRatio: profile.screen.width / profile.screen.height,
          }).selected;
          if (!proposal) {
            throw new AutoSetupError(
              "The reviewed vision proposal is no longer available for this frame.",
              409,
              "VISION_PROPOSAL_UNAVAILABLE",
            );
          }
          referenceProfile = buildVisionBaselineProfile({
            currentProfile: profile,
            imagePoints: proposal.points,
            frame: { width: frame.width, height: frame.height },
            movementBounds: movementBounds(device),
            calibrationMovementBounds: movementBounds(
              device,
              "calibrationMovementBounds",
            ),
          });
        }
        // Preserve the phone-independent camera-to-machine XY proof before a
        // visual-only profile refresh intentionally drops its joint-placement
        // evidence. This write is inside the explicit mutation lock and never
        // occurs during preview or Dry Run.
        await saveStationPlaneIfAvailable(deviceId, profile);
        const saved = await saveReference(deviceId, referenceProfile, frame);
        if (calibrationFingerprint(referenceProfile) !== calibrationFingerprint(profile)) {
          await activateProfile(deviceId, referenceProfile);
        }
        return saved;
      });
      sendJson(response, { ok: true, reference }, 201);
      return;
    }

    const dryRun = input.dryRun === true;
    if (!dryRun && input.confirmation !== "CLEAR_WORKSPACE_AND_AUTO_SETUP") {
      throw new AutoSetupError(
        "A clear-workspace confirmation is required before Home.",
        409,
        "WORKSPACE_CONFIRMATION_REQUIRED",
      );
    }
    const executeRun = async () => {
      const initial = await previewAutoSetup(deviceId);
      const visualPreflightReady =
        (initial.preview.status === "ready" && initial.registration !== null) ||
        (
          initial.preview.status === "automatic_baseline_ready" &&
          initial.automaticBaseline !== null
        );
      if (!visualPreflightReady) {
        throw new AutoSetupError(initial.preview.reason, 409, "VISUAL_PREFLIGHT_FAILED");
      }
      if (dryRun) {
        return {
          ok: true,
          status: "previewed",
          moved: false,
          profileUpdated: false,
          preview: initial.preview,
        };
      }
      // Copy only after explicit restore confirmation and the live vision gate.
      if (initial.preview.referenceReuse?.status === "compatible") {
        await materializeCompatibleReference({localDirectory:STATE_DIRECTORY,previousDirectory:PREVIOUS_REFERENCE_DIRECTORY,deviceId,profile:await fetchCalibration(deviceId)});
      }
      await saveStationPlaneIfAvailable(
        deviceId,
        await fetchCalibration(deviceId),
      );
      const home = await homeIfRequired(deviceId);
      if (initial.preview.status === "automatic_baseline_ready") {
        // Re-observe after the potentially moving Home cycle. Only the fresh
        // post-Home consensus is persisted, so a bumped phone cannot inherit
        // the preflight geometry.
        const postHome = await previewAutoSetup(deviceId);
        if (
          postHome.preview.status !== "automatic_baseline_ready" ||
          !postHome.automaticBaseline
        ) {
          throw new AutoSetupError(
            `Post-Home automatic baseline failed: ${postHome.preview.reason}`,
            409,
            "POST_HOME_BASELINE_FAILED",
          );
        }
        await saveReference(
          deviceId,
          postHome.automaticBaseline.consensus.profile,
          postHome.automaticBaseline.frame,
        );
        await activateProfile(
          deviceId,
          postHome.automaticBaseline.consensus.profile,
        );
      }
      const settled = await previewAutoSetup(deviceId);
      if (settled.preview.status !== "ready" || !settled.registration) {
        throw new AutoSetupError(
          `Post-Home visual verification failed: ${settled.preview.reason}`,
          409,
          "POST_HOME_VERIFICATION_FAILED",
        );
      }
      await activateProfile(deviceId, settled.registration.profile);
      return {
        ok: true,
        status: "completed",
        moved: home.performed,
        profileUpdated: true,
        referenceCreated: initial.preview.status === "automatic_baseline_ready",
        home,
        preview: settled.preview,
      };
    };
    const result = dryRun
      ? await executeRun()
      : await withDeviceMutationLock(deviceId, executeRun);
    sendJson(response, result);
  } catch (error) {
    const apiError = error instanceof AutoSetupError
      ? error
      : new AutoSetupError(
          error instanceof Error ? error.message : "Unknown auto-setup error.",
          error instanceof SyntaxError ? 400 : 500,
          error instanceof SyntaxError ? "INVALID_JSON" : "AUTO_SETUP_ERROR",
        );
    sendJson(response, {
      ok: false,
      error: apiError.message,
      code: apiError.code,
    }, apiError.status);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ScreenHand vision auto-setup listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
