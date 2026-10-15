import { createHash } from "node:crypto";
import type { ScreenHandCalibrationProfile } from "../agent/calibration-profile";
import { mapImagePointToMachine, type Point } from "../agent/homography";
import {
  referencePointsInCurrentFrame,
  type VisionRegistrationResult,
} from "../agent/vision-register";
import { calibrationReadinessIssue } from "../shared/calibration-readiness";

export type AutoSetupReference = {
  version: 2;
  deviceId: string;
  calibrationId: string;
  capturedAt: string;
  baselineCalibrationSha256: string;
  authorizedCalibrationSha256: string;
  frame: {
    width: number;
    height: number;
    sequence: number;
    sha256: string;
  };
  calibration: ScreenHandCalibrationProfile;
};

export type AutoSetupMovementBounds = {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
};

export type AutoSetupRegistration = {
  imagePoints: [Point, Point, Point, Point];
  machinePoints: [Point, Point, Point, Point];
  controlMachinePoints?: [Point, Point, Point, Point];
  meanDriftPx: number;
  maximumDriftPx: number;
  confidence: number;
  elapsedMs: number;
  profile: ScreenHandCalibrationProfile;
};

export type AutoSetupScreenObservation = {
  sequence: number;
  frame: { width: number; height: number };
  points: [Point, Point, Point, Point];
  confidence: number;
  score: number;
  runnerUpScore: number | null;
  elapsedMs: number;
};

export type AutoSetupBaselineConsensus = {
  imagePoints: [Point, Point, Point, Point];
  frameSequences: number[];
  confidence: number;
  score: number;
  meanDeviationPx: number;
  maximumDeviationPx: number;
  elapsedMs: number;
  profile: ScreenHandCalibrationProfile;
};

const MINIMUM_REGISTRATION_CONFIDENCE = 0.78;
const MAXIMUM_MEAN_DRIFT_RATIO = 0.16;
const MAXIMUM_CORNER_DRIFT_RATIO = 0.24;
const MINIMUM_EDGE_SCALE = 0.82;
const MAXIMUM_EDGE_SCALE = 1.18;
const MINIMUM_AREA_SCALE = 0.72;
const MAXIMUM_AREA_SCALE = 1.28;
const MAXIMUM_CORNER_ANGLE_CHANGE_DEGREES = 8;
const MINIMUM_AUTOMATIC_BASELINE_FRAMES = 3;
const MINIMUM_AUTOMATIC_CONFIDENCE = 0.9;
const MINIMUM_AUTOMATIC_SCORE = 0.78;
const MINIMUM_AUTOMATIC_SCORE_MARGIN = 0.08;
const MAXIMUM_AUTOMATIC_MEAN_DEVIATION_PX = 2.5;
const MAXIMUM_AUTOMATIC_CORNER_DEVIATION_PX = 4;
const MAXIMUM_AUTOMATIC_MEAN_DRIFT_RATIO = 0.08;
const MAXIMUM_AUTOMATIC_CORNER_DRIFT_RATIO = 0.12;

export function calibrationFingerprint(profile: ScreenHandCalibrationProfile) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

export function autoSetupReferenceIntegrityIssue(input: {
  reference: AutoSetupReference;
  expectedDeviceId: string;
  imageSha256: string;
}) {
  const { reference } = input;
  if (reference.version !== 2) return "Unsupported visual-reference version.";
  if (reference.deviceId !== input.expectedDeviceId) {
    return "The visual reference belongs to another device.";
  }
  if (reference.frame.sha256 !== input.imageSha256) {
    return "The visual-reference image hash does not match its metadata.";
  }
  if (
    reference.baselineCalibrationSha256 !==
      calibrationFingerprint(reference.calibration)
  ) {
    return "The baseline calibration hash does not match its metadata.";
  }
  if (!/^[a-f0-9]{64}$/.test(reference.authorizedCalibrationSha256)) {
    return "The authorized calibration hash is invalid.";
  }
  return null;
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function polygonArea(points: [Point, Point, Point, Point]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

function cornerAngleDegrees(
  points: [Point, Point, Point, Point],
  index: number,
) {
  const point = points[index];
  const previous = points[(index + points.length - 1) % points.length];
  const next = points[(index + 1) % points.length];
  const left = { x: previous.x - point.x, y: previous.y - point.y };
  const right = { x: next.x - point.x, y: next.y - point.y };
  const denominator = Math.hypot(left.x, left.y) * Math.hypot(right.x, right.y);
  if (!Number.isFinite(denominator) || denominator < 1e-6) return Number.NaN;
  const cosine = Math.max(-1, Math.min(1, (
    left.x * right.x + left.y * right.y
  ) / denominator));
  return Math.acos(cosine) * 180 / Math.PI;
}

function registrationGeometryIssue(
  baseline: [Point, Point, Point, Point],
  registered: [Point, Point, Point, Point],
) {
  const edgeScales = baseline.map((point, index) => {
    const baselineLength = distance(point, baseline[(index + 1) % baseline.length]);
    const registeredLength = distance(
      registered[index],
      registered[(index + 1) % registered.length],
    );
    return registeredLength / baselineLength;
  });
  if (edgeScales.some((scale) =>
    !Number.isFinite(scale) ||
    scale < MINIMUM_EDGE_SCALE ||
    scale > MAXIMUM_EDGE_SCALE
  )) {
    return "Visual registration distorted a screen edge beyond the allowed scale.";
  }
  const areaScale = polygonArea(registered) / polygonArea(baseline);
  if (
    !Number.isFinite(areaScale) ||
    areaScale < MINIMUM_AREA_SCALE ||
    areaScale > MAXIMUM_AREA_SCALE
  ) {
    return "Visual registration distorted the screen area beyond the allowed scale.";
  }
  const angleChanges = baseline.map((_, index) => Math.abs(
    cornerAngleDegrees(registered, index) - cornerAngleDegrees(baseline, index)
  ));
  if (angleChanges.some((change) =>
    !Number.isFinite(change) || change > MAXIMUM_CORNER_ANGLE_CHANGE_DEGREES
  )) {
    return "Visual registration distorted the screen corner angles.";
  }
  return null;
}

function finiteBounds(bounds: AutoSetupMovementBounds) {
  const values = [
    bounds.minimumX,
    bounds.maximumX,
    bounds.minimumY,
    bounds.maximumY,
  ];
  if (
    !values.every(Number.isFinite) ||
    bounds.minimumX >= bounds.maximumX ||
    bounds.minimumY >= bounds.maximumY
  ) {
    throw new Error("The hardware node did not publish valid movement bounds.");
  }
  return bounds;
}

function mappedMachineCorners(
  baseline: ScreenHandCalibrationProfile,
  imagePoints: [Point, Point, Point, Point],
  useControlPoints: boolean,
) {
  const machinePoints = useControlPoints
    ? baseline.controlMachinePoints ?? baseline.machinePoints
    : baseline.machinePoints;
  return imagePoints.map((point) => mapImagePointToMachine({
    imagePoints: baseline.imagePoints,
    machinePoints,
  }, point)) as [Point, Point, Point, Point];
}

function roundedPoints(points: [Point, Point, Point, Point]) {
  return points.map((point) => ({
    x: Math.round(point.x * 1_000) / 1_000,
    y: Math.round(point.y * 1_000) / 1_000,
  })) as [Point, Point, Point, Point];
}

function canonicalScreenPoints(profile: ScreenHandCalibrationProfile) {
  return [
    { x: 0, y: 0 },
    { x: profile.screen.width, y: 0 },
    { x: profile.screen.width, y: profile.screen.height },
    { x: 0, y: profile.screen.height },
  ] as [Point, Point, Point, Point];
}

function remapNavigation(
  baseline: ScreenHandCalibrationProfile,
  currentControlMachinePoints: [Point, Point, Point, Point],
) {
  if (!baseline.navigation?.home) return undefined;
  if (baseline.navigation.home.strategy === "screen-swipe") {
    // These anchors live in logical screen space and therefore remain valid
    // when camera registration changes the phone's machine-space placement.
    return {
      home: {
        ...baseline.navigation.home,
        startPoint: { ...baseline.navigation.home.startPoint },
        endPoint: { ...baseline.navigation.home.endPoint },
      },
    } satisfies NonNullable<ScreenHandCalibrationProfile["navigation"]>;
  }
  const baselineControlMachinePoints = baseline.controlMachinePoints ??
    baseline.machinePoints;
  const relativeScreenPoint = mapImagePointToMachine({
    imagePoints: baselineControlMachinePoints,
    machinePoints: canonicalScreenPoints(baseline),
  }, baseline.navigation.home.machinePoint);
  const machinePoint = mapImagePointToMachine({
    imagePoints: canonicalScreenPoints(baseline),
    machinePoints: currentControlMachinePoints,
  }, relativeScreenPoint);
  return {
    home: {
      ...baseline.navigation.home,
      machinePoint: {
        x: Math.round(machinePoint.x * 1_000) / 1_000,
        y: Math.round(machinePoint.y * 1_000) / 1_000,
      },
    },
  } satisfies NonNullable<ScreenHandCalibrationProfile["navigation"]>;
}

function boundsContainPoint(bounds: AutoSetupMovementBounds, point: Point) {
  return point.x >= bounds.minimumX && point.x <= bounds.maximumX &&
    point.y >= bounds.minimumY && point.y <= bounds.maximumY;
}

function validateProfileBounds(input: {
  profile: ScreenHandCalibrationProfile;
  movementBounds?: AutoSetupMovementBounds;
  calibrationMovementBounds?: AutoSetupMovementBounds;
}) {
  const movement = input.movementBounds
    ? finiteBounds(input.movementBounds)
    : null;
  const calibration = input.calibrationMovementBounds
    ? finiteBounds(input.calibrationMovementBounds)
    : movement;
  const corners = input.profile.controlMachinePoints ?? input.profile.machinePoints;
  if (calibration && corners.some((point) => !boundsContainPoint(calibration, point))) {
    throw new Error(
      "The detected phone corners are outside the hardware calibration movement envelope.",
    );
  }
  if (movement) {
    const safe = input.profile.safeMachineBounds;
    if (
      safe.minimumX < movement.minimumX || safe.maximumX > movement.maximumX ||
      safe.minimumY < movement.minimumY || safe.maximumY > movement.maximumY
    ) {
      throw new Error("The existing safe touch area is outside the hardware movement envelope.");
    }
    const home = input.profile.navigation?.home.strategy === "physical-button"
      ? input.profile.navigation.home.machinePoint
      : null;
    if (home && !boundsContainPoint(movement, home)) {
      throw new Error("The recovered physical Home button is outside normal movement bounds.");
    }
  }
}

export function buildVisionBaselineProfile(input: {
  currentProfile: ScreenHandCalibrationProfile;
  imagePoints: [Point, Point, Point, Point];
  frame: { width: number; height: number };
  movementBounds?: AutoSetupMovementBounds;
  calibrationMovementBounds?: AutoSetupMovementBounds;
  now?: Date;
}) {
  const imagePoints = roundedPoints(input.imagePoints);
  if (imagePoints.some((point) =>
    point.x < 0 || point.x > input.frame.width ||
    point.y < 0 || point.y > input.frame.height
  )) {
    throw new Error("The detected screen corners extend outside the camera frame.");
  }
  const machinePoints = roundedPoints(mappedMachineCorners(
    input.currentProfile,
    imagePoints,
    false,
  ));
  const controlMachinePoints = input.currentProfile.controlMachinePoints
    ? roundedPoints(mappedMachineCorners(
        input.currentProfile,
        imagePoints,
        true,
      ))
    : undefined;
  const geometryIssue = calibrationReadinessIssue({
    imagePoints,
    machinePoints: controlMachinePoints ?? machinePoints,
  });
  if (geometryIssue) throw new Error(geometryIssue);
  const navigation = remapNavigation(
    input.currentProfile,
    controlMachinePoints ?? machinePoints,
  );
  const profile: ScreenHandCalibrationProfile = {
    ...input.currentProfile,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    frame: { ...input.frame },
    imagePoints,
    machinePoints,
    ...(controlMachinePoints ? { controlMachinePoints } : {}),
    ...(navigation ? { navigation } : { navigation: undefined }),
  };
  // A changed camera outline invalidates the previous joint camera/touch error
  // measurement, whether the new outline was operator-reviewed or accepted by
  // the multi-frame automatic gate.
  delete profile.placementCalibration;
  validateProfileBounds({
    profile,
    movementBounds: input.movementBounds,
    calibrationMovementBounds: input.calibrationMovementBounds,
  });
  return profile;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function buildAutomaticVisionBaseline(input: {
  currentProfile: ScreenHandCalibrationProfile;
  observations: AutoSetupScreenObservation[];
  movementBounds: AutoSetupMovementBounds;
  calibrationMovementBounds?: AutoSetupMovementBounds;
  now?: Date;
}): AutoSetupBaselineConsensus {
  const observations = input.observations;
  if (observations.length < MINIMUM_AUTOMATIC_BASELINE_FRAMES) {
    throw new Error(
      `Automatic visual setup requires ${MINIMUM_AUTOMATIC_BASELINE_FRAMES} fresh frames.`,
    );
  }
  const sequences = observations.map((observation) => observation.sequence);
  if (new Set(sequences).size !== sequences.length ||
      sequences.some((sequence, index) =>
        !Number.isInteger(sequence) || sequence <= 0 ||
        (index > 0 && sequence <= sequences[index - 1])
      )) {
    throw new Error("Automatic visual setup requires distinct, ordered camera frames.");
  }
  const frame = observations[0].frame;
  if (observations.some((observation) =>
    observation.frame.width !== frame.width ||
    observation.frame.height !== frame.height
  )) {
    throw new Error("The camera resolution changed during automatic visual setup.");
  }
  for (const observation of observations) {
    if (observation.confidence < MINIMUM_AUTOMATIC_CONFIDENCE) {
      throw new Error("Automatic screen confidence is below the fail-closed threshold.");
    }
    if (observation.score < MINIMUM_AUTOMATIC_SCORE) {
      throw new Error("Automatic screen geometry score is below the fail-closed threshold.");
    }
    if (
      observation.runnerUpScore !== null &&
      observation.score - observation.runnerUpScore < MINIMUM_AUTOMATIC_SCORE_MARGIN
    ) {
      throw new Error("Two screen candidates are too ambiguous for automatic setup.");
    }
  }
  const imagePoints = [0, 1, 2, 3].map((index) => ({
    x: median(observations.map((observation) => observation.points[index].x)),
    y: median(observations.map((observation) => observation.points[index].y)),
  })) as [Point, Point, Point, Point];
  const deviations = observations.flatMap((observation) =>
    observation.points.map((point, index) => distance(point, imagePoints[index]))
  );
  const meanDeviationPx = deviations.reduce((sum, value) => sum + value, 0) /
    deviations.length;
  const maximumDeviationPx = Math.max(...deviations);
  if (
    meanDeviationPx > MAXIMUM_AUTOMATIC_MEAN_DEVIATION_PX ||
    maximumDeviationPx > MAXIMUM_AUTOMATIC_CORNER_DEVIATION_PX
  ) {
    throw new Error(
      `The detected screen moved during automatic setup ` +
        `(mean ${meanDeviationPx.toFixed(1)} px, max ${maximumDeviationPx.toFixed(1)} px).`,
    );
  }
  const geometryIssue = registrationGeometryIssue(
    input.currentProfile.imagePoints,
    imagePoints,
  );
  if (geometryIssue) throw new Error(geometryIssue);
  const frameDiagonal = Math.hypot(frame.width, frame.height);
  const drift = imagePoints.map((point, index) =>
    distance(point, input.currentProfile.imagePoints[index])
  );
  const meanDriftPx = drift.reduce((sum, value) => sum + value, 0) / drift.length;
  const maximumDriftPx = Math.max(...drift);
  if (
    meanDriftPx > frameDiagonal * MAXIMUM_AUTOMATIC_MEAN_DRIFT_RATIO ||
    maximumDriftPx > frameDiagonal * MAXIMUM_AUTOMATIC_CORNER_DRIFT_RATIO
  ) {
    throw new Error(
      `The phone moved too far to establish an automatic baseline ` +
        `(mean ${meanDriftPx.toFixed(1)} px, max ${maximumDriftPx.toFixed(1)} px).`,
    );
  }
  const profile = buildVisionBaselineProfile({
    currentProfile: input.currentProfile,
    imagePoints,
    frame,
    movementBounds: input.movementBounds,
    calibrationMovementBounds: input.calibrationMovementBounds,
    now: input.now,
  });
  return {
    imagePoints: profile.imagePoints,
    frameSequences: sequences,
    confidence: Math.min(...observations.map((observation) => observation.confidence)),
    score: Math.min(...observations.map((observation) => observation.score)),
    meanDeviationPx: Math.round(meanDeviationPx * 1_000) / 1_000,
    maximumDeviationPx: Math.round(maximumDeviationPx * 1_000) / 1_000,
    elapsedMs: Math.max(...observations.map((observation) => observation.elapsedMs)),
    profile,
  };
}

export function buildRegisteredAutoSetup(input: {
  reference: AutoSetupReference;
  currentProfile: ScreenHandCalibrationProfile;
  registration: VisionRegistrationResult;
  movementBounds: AutoSetupMovementBounds;
  calibrationMovementBounds?: AutoSetupMovementBounds;
  now?: Date;
}): AutoSetupRegistration {
  const { reference, currentProfile, registration } = input;
  if (
    reference.version !== 2 ||
    reference.deviceId !== currentProfile.deviceId ||
    reference.calibrationId !== currentProfile.id ||
    reference.calibration.id !== currentProfile.id
  ) {
    throw new Error("The saved visual reference does not belong to this device profile.");
  }
  if (
    registration.referenceWidth !== reference.frame.width ||
    registration.referenceHeight !== reference.frame.height ||
    registration.currentWidth !== reference.frame.width ||
    registration.currentHeight !== reference.frame.height
  ) {
    throw new Error("The camera resolution changed after the visual reference was saved.");
  }
  if (registration.confidence < MINIMUM_REGISTRATION_CONFIDENCE) {
    throw new Error(
      `Camera registration confidence ${registration.confidence.toFixed(3)} is below ` +
        `${MINIMUM_REGISTRATION_CONFIDENCE.toFixed(2)}.`,
    );
  }

  const rawImagePoints = referencePointsInCurrentFrame(
    registration.referenceToCurrentVision,
    reference.calibration.imagePoints,
    registration.currentHeight,
  );
  const frameDiagonal = Math.hypot(reference.frame.width, reference.frame.height);
  const drift = rawImagePoints.map((point, index) =>
    distance(point, reference.calibration.imagePoints[index])
  );
  const meanDriftPx = drift.reduce((sum, value) => sum + value, 0) / drift.length;
  const maximumDriftPx = Math.max(...drift);
  if (
    meanDriftPx > frameDiagonal * MAXIMUM_MEAN_DRIFT_RATIO ||
    maximumDriftPx > frameDiagonal * MAXIMUM_CORNER_DRIFT_RATIO
  ) {
    throw new Error(
      `The phone moved too far for automatic recovery ` +
        `(mean ${meanDriftPx.toFixed(1)} px, max ${maximumDriftPx.toFixed(1)} px).`,
    );
  }
  if (rawImagePoints.some((point) =>
    point.x < -2 || point.x > reference.frame.width + 2 ||
    point.y < -2 || point.y > reference.frame.height + 2
  )) {
    throw new Error("The registered screen corners extend outside the camera frame.");
  }
  const registrationIssue = registrationGeometryIssue(
    reference.calibration.imagePoints,
    rawImagePoints,
  );
  if (registrationIssue) throw new Error(registrationIssue);

  const imagePoints = roundedPoints(rawImagePoints);
  const machinePoints = roundedPoints(mappedMachineCorners(
    reference.calibration,
    imagePoints,
    false,
  ));
  const controlMachinePoints = reference.calibration.controlMachinePoints
    ? roundedPoints(mappedMachineCorners(
        reference.calibration,
        imagePoints,
        true,
      ))
    : undefined;
  const navigation = remapNavigation(
    reference.calibration,
    controlMachinePoints ?? machinePoints,
  );
  const geometryIssue = calibrationReadinessIssue({
    imagePoints,
    machinePoints: controlMachinePoints ?? machinePoints,
  });
  if (geometryIssue) throw new Error(geometryIssue);

  const movementBounds = finiteBounds(input.movementBounds);
  const calibrationMovementBounds = finiteBounds(
    input.calibrationMovementBounds ?? input.movementBounds,
  );
  const safetyPoints = controlMachinePoints ?? machinePoints;
  if (safetyPoints.some((point) =>
    point.x < calibrationMovementBounds.minimumX ||
    point.x > calibrationMovementBounds.maximumX ||
    point.y < calibrationMovementBounds.minimumY ||
    point.y > calibrationMovementBounds.maximumY
  )) {
    throw new Error(
      "The recovered phone corners are outside the hardware calibration movement envelope.",
    );
  }
  const xs = safetyPoints.map((point) => point.x);
  const ys = safetyPoints.map((point) => point.y);
  let safeMachineBounds = {
    minimumX: Math.max(Math.min(...xs) + 0.5, movementBounds.minimumX),
    maximumX: Math.min(Math.max(...xs) - 0.5, movementBounds.maximumX),
    minimumY: Math.max(Math.min(...ys) + 0.5, movementBounds.minimumY),
    maximumY: Math.min(Math.max(...ys) - 0.5, movementBounds.maximumY),
  };
  if (
    safeMachineBounds.minimumX >= safeMachineBounds.maximumX ||
    safeMachineBounds.minimumY >= safeMachineBounds.maximumY
  ) {
    throw new Error("Automatic recovery produced an empty safe touch area.");
  }

  const physicalHome = navigation?.home.strategy === "physical-button"
    ? navigation.home
    : null;
  if (physicalHome) {
    if (!boundsContainPoint(movementBounds, physicalHome.machinePoint)) {
      throw new Error("The recovered physical Home button is outside normal movement bounds.");
    }
    safeMachineBounds = {
      minimumX: Math.max(
        Math.min(safeMachineBounds.minimumX, physicalHome.machinePoint.x - 0.25),
        movementBounds.minimumX,
      ),
      maximumX: Math.min(
        Math.max(safeMachineBounds.maximumX, physicalHome.machinePoint.x + 0.25),
        movementBounds.maximumX,
      ),
      minimumY: Math.max(
        Math.min(safeMachineBounds.minimumY, physicalHome.machinePoint.y - 0.25),
        movementBounds.minimumY,
      ),
      maximumY: Math.min(
        Math.max(safeMachineBounds.maximumY, physicalHome.machinePoint.y + 0.25),
        movementBounds.maximumY,
      ),
    };
  }

  const profile: ScreenHandCalibrationProfile = {
    ...currentProfile,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    frame: {
      width: registration.currentWidth,
      height: registration.currentHeight,
    },
    imagePoints,
    machinePoints,
    ...(controlMachinePoints ? { controlMachinePoints } : {}),
    safeMachineBounds,
    ...(navigation ? { navigation } : { navigation: undefined }),
    placementCalibration: undefined,
  };
  return {
    imagePoints,
    machinePoints,
    ...(controlMachinePoints ? { controlMachinePoints } : {}),
    meanDriftPx: Math.round(meanDriftPx * 1_000) / 1_000,
    maximumDriftPx: Math.round(maximumDriftPx * 1_000) / 1_000,
    confidence: registration.confidence,
    elapsedMs: registration.elapsedMs,
    profile,
  };
}
