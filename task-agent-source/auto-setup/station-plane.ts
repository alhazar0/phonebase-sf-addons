import { createHash } from "node:crypto";

import type { ScreenHandCalibrationProfile } from "../agent/calibration-profile";
import { mapImagePointToMachine, type Point } from "../agent/homography";
import { calibrationReadinessIssue } from "../shared/calibration-readiness";
import type {
  AutoSetupMovementBounds,
  AutoSetupScreenObservation,
} from "./core";
import type { OnScreenNavigationEvidence } from "./on-screen-navigation";
import type { PhysicalHomeButtonEvidence } from "./physical-home-button";

export type StationPlaneCalibration = {
  version: 1;
  deviceId: string;
  verifiedAt: string;
  frame: { width: number; height: number };
  imagePoints: [Point, Point, Point, Point];
  machinePoints: [Point, Point, Point, Point];
  evidence: {
    method: "joint-camera-touch-v1";
    sourceProfileId: string;
    cameraRmsePx: number;
    cameraMaximumErrorPx: number;
  };
};

export type StationPlaneArtifact = {
  calibration: StationPlaneCalibration;
  sha256: string;
};

export type UnknownPhonePlacementCandidate = {
  version: 1;
  id: string;
  deviceId: string;
  observedAt: string;
  sourceStationSha256: string;
  frame: { width: number; height: number; sequences: number[] };
  imagePoints: [Point, Point, Point, Point];
  machinePoints: [Point, Point, Point, Point];
  safeMachineBounds: AutoSetupMovementBounds;
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
    observation: PhysicalHomeButtonEvidence;
    machinePoint: Point | null;
    withinMovementBounds: boolean;
    mappingExtrapolated: true;
  };
  onScreenNavigationEvidence?: {
    observation: OnScreenNavigationEvidence;
    machinePoint: Point | null;
    withinMovementBounds: boolean | null;
    mappingExtrapolated: false;
  };
  xyReady: true;
  touchDepthReady: false;
  actionReady: false;
  blockers: string[];
};

const MAXIMUM_STATION_CAMERA_RMSE_PX = 4;
const MAXIMUM_STATION_CAMERA_ERROR_PX = 6;
const MINIMUM_UNKNOWN_PHONE_FRAMES = 3;
const MINIMUM_UNKNOWN_PHONE_CONFIDENCE = 0.9;
const MINIMUM_UNKNOWN_PHONE_SCORE = 0.72;
const MINIMUM_UNKNOWN_PHONE_SCORE_MARGIN = 0.08;
const MAXIMUM_UNKNOWN_PHONE_MEAN_DEVIATION_PX = 3;
const MAXIMUM_UNKNOWN_PHONE_CORNER_DEVIATION_PX = 5;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite.`);
  return parsed;
}

function positiveInteger(value: unknown, label: string) {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function point(value: unknown, label: string): Point {
  const input = record(value, label);
  return {
    x: finiteNumber(input.x, `${label}.x`),
    y: finiteNumber(input.y, `${label}.y`),
  };
}

function fourPoints(value: unknown, label: string): [Point, Point, Point, Point] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} must contain four points.`);
  }
  return value.map((entry, index) =>
    point(entry, `${label}[${index}]`)
  ) as [Point, Point, Point, Point];
}

function nonemptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function finiteBounds(bounds: AutoSetupMovementBounds) {
  const parsed = {
    minimumX: finiteNumber(bounds.minimumX, "minimumX"),
    maximumX: finiteNumber(bounds.maximumX, "maximumX"),
    minimumY: finiteNumber(bounds.minimumY, "minimumY"),
    maximumY: finiteNumber(bounds.maximumY, "maximumY"),
  };
  if (
    parsed.minimumX >= parsed.maximumX ||
    parsed.minimumY >= parsed.maximumY
  ) {
    throw new Error("Station movement bounds are invalid.");
  }
  return parsed;
}

function boundsContain(bounds: AutoSetupMovementBounds, value: Point) {
  return value.x >= bounds.minimumX && value.x <= bounds.maximumX &&
    value.y >= bounds.minimumY && value.y <= bounds.maximumY;
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function roundedPoint(value: Point): Point {
  return {
    x: Math.round(value.x * 1_000) / 1_000,
    y: Math.round(value.y * 1_000) / 1_000,
  };
}

function roundedPoints(values: [Point, Point, Point, Point]) {
  return values.map(roundedPoint) as [Point, Point, Point, Point];
}

export function stationPlaneFingerprint(calibration: StationPlaneCalibration) {
  return createHash("sha256").update(JSON.stringify(calibration)).digest("hex");
}

export function stationPlaneFromProfile(
  profile: ScreenHandCalibrationProfile,
): StationPlaneCalibration {
  const placement = profile.placementCalibration;
  if (!placement || placement.method !== "joint-camera-touch-v1") {
    throw new Error(
      "A joint camera/touch calibration is required before extracting a station plane.",
    );
  }
  if (
    placement.cameraRmsePx > MAXIMUM_STATION_CAMERA_RMSE_PX ||
    placement.cameraMaximumErrorPx > MAXIMUM_STATION_CAMERA_ERROR_PX
  ) {
    throw new Error(
      "The camera/touch calibration error is too high for unknown-phone XY projection.",
    );
  }
  const geometryIssue = calibrationReadinessIssue({
    imagePoints: profile.imagePoints,
    machinePoints: profile.machinePoints,
  });
  if (geometryIssue) throw new Error(geometryIssue);
  return {
    version: 1,
    deviceId: profile.deviceId,
    verifiedAt: placement.verifiedAt,
    frame: { ...profile.frame },
    imagePoints: roundedPoints(profile.imagePoints),
    machinePoints: roundedPoints(profile.machinePoints),
    evidence: {
      method: "joint-camera-touch-v1",
      sourceProfileId: profile.id,
      cameraRmsePx: placement.cameraRmsePx,
      cameraMaximumErrorPx: placement.cameraMaximumErrorPx,
    },
  };
}

export function createStationPlaneArtifact(
  calibration: StationPlaneCalibration,
): StationPlaneArtifact {
  return { calibration, sha256: stationPlaneFingerprint(calibration) };
}

export function parseStationPlaneArtifact(value: unknown): StationPlaneArtifact {
  const input = record(value, "station plane artifact");
  const raw = record(input.calibration, "calibration");
  const frame = record(raw.frame, "calibration.frame");
  const evidence = record(raw.evidence, "calibration.evidence");
  const calibration: StationPlaneCalibration = {
    version: finiteNumber(raw.version, "calibration.version") as 1,
    deviceId: nonemptyString(raw.deviceId, "calibration.deviceId"),
    verifiedAt: nonemptyString(raw.verifiedAt, "calibration.verifiedAt"),
    frame: {
      width: positiveInteger(frame.width, "calibration.frame.width"),
      height: positiveInteger(frame.height, "calibration.frame.height"),
    },
    imagePoints: fourPoints(raw.imagePoints, "calibration.imagePoints"),
    machinePoints: fourPoints(raw.machinePoints, "calibration.machinePoints"),
    evidence: {
      method: nonemptyString(
        evidence.method,
        "calibration.evidence.method",
      ) as "joint-camera-touch-v1",
      sourceProfileId: nonemptyString(
        evidence.sourceProfileId,
        "calibration.evidence.sourceProfileId",
      ),
      cameraRmsePx: finiteNumber(
        evidence.cameraRmsePx,
        "calibration.evidence.cameraRmsePx",
      ),
      cameraMaximumErrorPx: finiteNumber(
        evidence.cameraMaximumErrorPx,
        "calibration.evidence.cameraMaximumErrorPx",
      ),
    },
  };
  if (calibration.version !== 1) throw new Error("Unsupported station plane version.");
  if (calibration.evidence.method !== "joint-camera-touch-v1") {
    throw new Error("Unsupported station plane evidence method.");
  }
  if (
    calibration.evidence.cameraRmsePx < 0 ||
    calibration.evidence.cameraRmsePx > MAXIMUM_STATION_CAMERA_RMSE_PX ||
    calibration.evidence.cameraMaximumErrorPx < 0 ||
    calibration.evidence.cameraMaximumErrorPx > MAXIMUM_STATION_CAMERA_ERROR_PX
  ) {
    throw new Error("Station plane accuracy is outside the unknown-phone limit.");
  }
  const geometryIssue = calibrationReadinessIssue({
    imagePoints: calibration.imagePoints,
    machinePoints: calibration.machinePoints,
  });
  if (geometryIssue) throw new Error(geometryIssue);
  const sha256 = nonemptyString(input.sha256, "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256) ||
      sha256 !== stationPlaneFingerprint(calibration)) {
    throw new Error("Station plane artifact hash does not match its calibration.");
  }
  return { calibration, sha256 };
}

function navigationAssessment(aspectRatio: number) {
  if (aspectRatio <= 0.52) return "edge_gesture_candidate" as const;
  if (aspectRatio >= 0.535 && aspectRatio <= 0.595) {
    return "physical_home_button_candidate" as const;
  }
  return "unknown" as const;
}

const NAVIGATION_BLOCKERS = new Set([
  "platform_navigation_unverified",
  "physical_home_button_evidence_required",
  "physical_home_button_contact_unverified",
  "physical_home_button_out_of_range",
  "gesture_navigation_contact_unverified",
  "on_screen_home_button_contact_unverified",
  "on_screen_home_button_out_of_range",
  "navigation_evidence_conflict",
]);

function replaceNavigationBlockers(
  blockers: string[],
  replacement: string,
) {
  return [...new Set([
    ...blockers.filter((blocker) => !NAVIGATION_BLOCKERS.has(blocker)),
    replacement,
  ])];
}

export function buildUnknownPhonePlacementCandidate(input: {
  station: StationPlaneArtifact;
  observations: AutoSetupScreenObservation[];
  movementBounds: AutoSetupMovementBounds;
  calibrationMovementBounds?: AutoSetupMovementBounds;
  now?: Date;
}): UnknownPhonePlacementCandidate {
  const station = parseStationPlaneArtifact(input.station);
  const observations = input.observations;
  if (observations.length < MINIMUM_UNKNOWN_PHONE_FRAMES) {
    throw new Error(
      `Unknown-phone placement requires ${MINIMUM_UNKNOWN_PHONE_FRAMES} fresh frames.`,
    );
  }
  const sequences = observations.map((observation) => observation.sequence);
  if (sequences.some((sequence, index) =>
    !Number.isInteger(sequence) || sequence <= 0 ||
    (index > 0 && sequence <= sequences[index - 1])
  )) {
    throw new Error("Unknown-phone placement requires ordered fresh frames.");
  }
  if (new Set(sequences).size !== sequences.length) {
    throw new Error("Unknown-phone placement cannot reuse a camera frame.");
  }
  const frame = observations[0].frame;
  if (
    frame.width !== station.calibration.frame.width ||
    frame.height !== station.calibration.frame.height ||
    observations.some((observation) =>
      observation.frame.width !== frame.width ||
      observation.frame.height !== frame.height
    )
  ) {
    throw new Error("Unknown-phone frames do not match the station camera resolution.");
  }
  for (const observation of observations) {
    if (
      observation.confidence < MINIMUM_UNKNOWN_PHONE_CONFIDENCE ||
      observation.score < MINIMUM_UNKNOWN_PHONE_SCORE
    ) {
      throw new Error("Unknown-phone screen evidence is below the Shadow threshold.");
    }
    if (
      observation.runnerUpScore !== null &&
      observation.score - observation.runnerUpScore <
        MINIMUM_UNKNOWN_PHONE_SCORE_MARGIN
    ) {
      throw new Error("Unknown-phone screen candidates are ambiguous.");
    }
  }
  const imagePoints = [0, 1, 2, 3].map((index) => ({
    x: median(observations.map((observation) => observation.points[index].x)),
    y: median(observations.map((observation) => observation.points[index].y)),
  })) as [Point, Point, Point, Point];
  if (imagePoints.some((value) =>
    value.x < 0 || value.x > frame.width ||
    value.y < 0 || value.y > frame.height
  )) {
    throw new Error("Unknown-phone screen corners leave the station camera frame.");
  }
  const deviations = observations.flatMap((observation) =>
    observation.points.map((value, index) => distance(value, imagePoints[index]))
  );
  const meanDeviationPx = deviations.reduce((sum, value) => sum + value, 0) /
    deviations.length;
  const maximumDeviationPx = Math.max(...deviations);
  if (
    meanDeviationPx > MAXIMUM_UNKNOWN_PHONE_MEAN_DEVIATION_PX ||
    maximumDeviationPx > MAXIMUM_UNKNOWN_PHONE_CORNER_DEVIATION_PX
  ) {
    throw new Error("The unknown phone moved during the camera consensus.");
  }
  const machinePoints = roundedPoints(imagePoints.map((value) =>
    mapImagePointToMachine({
      imagePoints: station.calibration.imagePoints,
      machinePoints: station.calibration.machinePoints,
    }, value)
  ) as [Point, Point, Point, Point]);
  const calibrationBounds = finiteBounds(
    input.calibrationMovementBounds ?? input.movementBounds,
  );
  if (machinePoints.some((value) => !boundsContain(calibrationBounds, value))) {
    throw new Error("The unknown phone leaves the station calibration envelope.");
  }
  const horizontalMm = (
    distance(machinePoints[0], machinePoints[1]) +
    distance(machinePoints[3], machinePoints[2])
  ) / 2;
  const verticalMm = (
    distance(machinePoints[0], machinePoints[3]) +
    distance(machinePoints[1], machinePoints[2])
  ) / 2;
  const aspectRatio = horizontalMm / verticalMm;
  if (!Number.isFinite(aspectRatio) || aspectRatio < 0.32 || aspectRatio > 0.78) {
    throw new Error("The unknown-phone display aspect ratio is unsupported.");
  }
  const movementBounds = finiteBounds(input.movementBounds);
  const xs = machinePoints.map((value) => value.x);
  const ys = machinePoints.map((value) => value.y);
  const safeMachineBounds = {
    minimumX: Math.max(Math.min(...xs) + 0.75, movementBounds.minimumX),
    maximumX: Math.min(Math.max(...xs) - 0.75, movementBounds.maximumX),
    minimumY: Math.max(Math.min(...ys) + 0.75, movementBounds.minimumY),
    maximumY: Math.min(Math.max(...ys) - 0.75, movementBounds.maximumY),
  };
  finiteBounds(safeMachineBounds);
  const canonicalWidth = 720;
  const canonicalHeight = Math.round(canonicalWidth / aspectRatio);
  const assessment = navigationAssessment(aspectRatio);
  const blockers = [
    "phone_identity_unverified",
    "touch_depth_unverified",
    "camera_z_observation_required",
    assessment === "physical_home_button_candidate"
      ? "physical_home_button_evidence_required"
      : "platform_navigation_unverified",
  ];
  const identity = {
    deviceId: station.calibration.deviceId,
    station: station.sha256,
    sequences,
    imagePoints: roundedPoints(imagePoints),
  };
  return {
    version: 1,
    id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    deviceId: station.calibration.deviceId,
    observedAt: (input.now ?? new Date()).toISOString(),
    sourceStationSha256: station.sha256,
    frame: { width: frame.width, height: frame.height, sequences },
    imagePoints: roundedPoints(imagePoints),
    machinePoints,
    safeMachineBounds,
    canonicalScreen: {
      width: canonicalWidth,
      height: canonicalHeight,
      aspectRatio: Math.round(aspectRatio * 100_000) / 100_000,
    },
    physicalScreen: {
      widthMm: Math.round(horizontalMm * 1_000) / 1_000,
      heightMm: Math.round(verticalMm * 1_000) / 1_000,
    },
    confidence: Math.min(...observations.map((observation) => observation.confidence)),
    score: Math.min(...observations.map((observation) => observation.score)),
    elapsedMs: Math.max(...observations.map((observation) => observation.elapsedMs)),
    meanDeviationPx: Math.round(meanDeviationPx * 1_000) / 1_000,
    maximumDeviationPx: Math.round(maximumDeviationPx * 1_000) / 1_000,
    navigationAssessment: assessment,
    contactDepthAssessment: {
      mode: "shadow",
      strategy: "camera-surface-intersection-v1",
      status: "observation_required",
      requiresZObservableCamera: true,
      requiresCompliantContactProof: true,
      actionReady: false,
    },
    xyReady: true,
    touchDepthReady: false,
    actionReady: false,
    blockers,
  };
}

export function attachPhysicalHomeButtonEvidence(input: {
  candidate: UnknownPhonePlacementCandidate;
  station: StationPlaneArtifact;
  observation: PhysicalHomeButtonEvidence;
  movementBounds: AutoSetupMovementBounds;
}): UnknownPhonePlacementCandidate {
  const station = parseStationPlaneArtifact(input.station);
  if (
    input.candidate.deviceId !== station.calibration.deviceId ||
    input.candidate.sourceStationSha256 !== station.sha256
  ) throw new Error("Physical Home evidence does not match the unknown-phone station.");
  if (input.observation.status !== "detected" || !input.observation.point) {
    return {
      ...input.candidate,
      physicalHomeButtonEvidence: {
        observation: input.observation,
        machinePoint: null,
        withinMovementBounds: false,
        mappingExtrapolated: true,
      },
    };
  }
  const machinePoint = roundedPoint(mapImagePointToMachine({
    imagePoints: station.calibration.imagePoints,
    machinePoints: station.calibration.machinePoints,
  }, input.observation.point));
  const bounds = finiteBounds(input.movementBounds);
  const withinMovementBounds = boundsContain(bounds, machinePoint);
  const evidence = {
    observation: input.observation,
    machinePoint,
    withinMovementBounds,
    mappingExtrapolated: true as const,
  };
  if (input.candidate.onScreenNavigationEvidence?.observation.status === "detected") {
    return {
      ...input.candidate,
      navigationAssessment: "unknown",
      blockers: replaceNavigationBlockers(
        input.candidate.blockers,
        "navigation_evidence_conflict",
      ),
      physicalHomeButtonEvidence: evidence,
    };
  }
  return {
    ...input.candidate,
    navigationAssessment: "physical_home_button_candidate",
    blockers: replaceNavigationBlockers(
      input.candidate.blockers,
      withinMovementBounds
        ? "physical_home_button_contact_unverified"
        : "physical_home_button_out_of_range",
    ),
    physicalHomeButtonEvidence: evidence,
  };
}

export function attachOnScreenNavigationEvidence(input: {
  candidate: UnknownPhonePlacementCandidate;
  station: StationPlaneArtifact;
  observation: OnScreenNavigationEvidence;
  movementBounds: AutoSetupMovementBounds;
}): UnknownPhonePlacementCandidate {
  const station = parseStationPlaneArtifact(input.station);
  if (
    input.candidate.deviceId !== station.calibration.deviceId ||
    input.candidate.sourceStationSha256 !== station.sha256
  ) throw new Error("On-screen navigation evidence does not match the unknown-phone station.");
  const emptyEvidence = {
    observation: input.observation,
    machinePoint: null,
    withinMovementBounds: null,
    mappingExtrapolated: false as const,
  };
  if (input.observation.status !== "detected") {
    return {
      ...input.candidate,
      onScreenNavigationEvidence: emptyEvidence,
    };
  }
  if (input.candidate.physicalHomeButtonEvidence?.observation.status === "detected") {
    return {
      ...input.candidate,
      navigationAssessment: "unknown",
      blockers: replaceNavigationBlockers(
        input.candidate.blockers,
        "navigation_evidence_conflict",
      ),
      onScreenNavigationEvidence: emptyEvidence,
    };
  }
  if (input.observation.strategy === "gesture_handle") {
    return {
      ...input.candidate,
      navigationAssessment: "edge_gesture_candidate",
      blockers: replaceNavigationBlockers(
        input.candidate.blockers,
        "gesture_navigation_contact_unverified",
      ),
      onScreenNavigationEvidence: emptyEvidence,
    };
  }
  if (input.observation.strategy !== "three_button" || !input.observation.homePoint) {
    return {
      ...input.candidate,
      onScreenNavigationEvidence: emptyEvidence,
    };
  }
  const screen = input.candidate.canonicalScreen;
  const machinePoint = roundedPoint(mapImagePointToMachine({
    imagePoints: [
      { x: 0, y: 0 },
      { x: screen.width, y: 0 },
      { x: screen.width, y: screen.height },
      { x: 0, y: screen.height },
    ],
    machinePoints: input.candidate.machinePoints,
  }, input.observation.homePoint));
  const withinMovementBounds = boundsContain(
    finiteBounds(input.movementBounds),
    machinePoint,
  );
  return {
    ...input.candidate,
    navigationAssessment: "on_screen_home_button_candidate",
    blockers: replaceNavigationBlockers(
      input.candidate.blockers,
      withinMovementBounds
        ? "on_screen_home_button_contact_unverified"
        : "on_screen_home_button_out_of_range",
    ),
    onScreenNavigationEvidence: {
      observation: input.observation,
      machinePoint,
      withinMovementBounds,
      mappingExtrapolated: false,
    },
  };
}
