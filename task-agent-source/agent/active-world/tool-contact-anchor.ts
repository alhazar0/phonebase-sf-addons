import { createHash } from "node:crypto";

import type { Point } from "../homography";

export type ToolContactAnchorSample = {
  sequence: number;
  machinePoint: Point;
  physicalZMm: number;
  markerCameraPoint: Point;
  contactTipCameraPoint: Point;
  confidence: number;
};

export type ToolContactAnchorCalibration = {
  version: 1;
  deviceId: string;
  stationPlaneSha256: string;
  sourceProfileId: string;
  verifiedAt: string;
  frame: { width: number; height: number };
  calibratedVolume: {
    minimumX: number;
    maximumX: number;
    minimumY: number;
    maximumY: number;
    minimumZ: number;
    maximumZ: number;
  };
  normalization: {
    centerX: number;
    centerY: number;
    centerZ: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
  };
  /** Affine camera-pixel offset from the tracked template anchor to the
   * conductive contact tip over normalized machine X/Y/Z. */
  offsetModel: {
    x: [number, number, number, number];
    y: [number, number, number, number];
  };
  evidence: {
    method: "stereo-factory-tip-anchor-v1";
    sampleCount: number;
    minimumConfidence: number;
    rmsePx: number;
    maximumErrorPx: number;
  };
};

export type ToolContactAnchorArtifact = {
  calibration: ToolContactAnchorCalibration;
  sha256: string;
};

export type ToolContactAnchorProjectionReason =
  | "contact-tip-anchored"
  | "station-mismatch"
  | "profile-mismatch"
  | "device-mismatch"
  | "frame-mismatch"
  | "marker-confidence-low"
  | "frame-stale"
  | "outside-calibrated-volume";

export type ToolContactAnchorProjection = {
  version: 1;
  mode: "shadow";
  status: "anchored" | "hold";
  reason: ToolContactAnchorProjectionReason;
  contactTipCameraPoint: Point | null;
  pointReference: "absolute-contact-camera-point" | null;
  confidence: number;
  estimatedOffsetPx: Point | null;
  calibrationRmsePx: number | null;
  eligibleForContactDepthEstimate: boolean;
  wouldMoveHardware: false;
  actionReady: false;
  blockers: string[];
};

const MINIMUM_SAMPLES = 8;
const MINIMUM_SAMPLE_CONFIDENCE = 0.95;
const MINIMUM_X_SPAN_MM = 20;
const MINIMUM_Y_SPAN_MM = 40;
const MINIMUM_Z_SPAN_MM = 2;
const MAXIMUM_RMSE_PX = 1;
const MAXIMUM_ERROR_PX = 2;
const MINIMUM_RUNTIME_CONFIDENCE = 0.9;
const MAXIMUM_RUNTIME_FRAME_AGE_MS = 150;

export function fitToolContactAnchorCalibration(input: {
  deviceId: string;
  stationPlaneSha256: string;
  sourceProfileId: string;
  verifiedAt: string;
  frame: { width: number; height: number };
  samples: ToolContactAnchorSample[];
}): ToolContactAnchorCalibration {
  const identity = calibrationIdentity(input);
  validateSamples(input.samples, identity.frame);
  if (input.samples.length < MINIMUM_SAMPLES) {
    throw new Error(`Tool contact anchoring requires at least ${MINIMUM_SAMPLES} samples.`);
  }
  if (!strictlyIncreasing(input.samples.map((sample) => sample.sequence))) {
    throw new Error("Tool contact anchor samples must have increasing unique sequences.");
  }
  if (input.samples.some((sample) => sample.confidence < MINIMUM_SAMPLE_CONFIDENCE)) {
    throw new Error("Tool contact anchor sample confidence is below the factory gate.");
  }
  const volume = calibratedVolume(input.samples);
  if (
    volume.maximumX - volume.minimumX < MINIMUM_X_SPAN_MM ||
    volume.maximumY - volume.minimumY < MINIMUM_Y_SPAN_MM ||
    volume.maximumZ - volume.minimumZ < MINIMUM_Z_SPAN_MM
  ) throw new Error("Tool contact anchor samples do not span the required X/Y/Z volume.");
  const normalization = normalizationFor(volume);
  const features = input.samples.map((sample) => normalizedFeatures(
    sample.machinePoint,
    sample.physicalZMm,
    normalization,
  ));
  const offsets = input.samples.map((sample) => ({
    x: sample.contactTipCameraPoint.x - sample.markerCameraPoint.x,
    y: sample.contactTipCameraPoint.y - sample.markerCameraPoint.y,
  }));
  const model = {
    x: solveLeastSquares(features, offsets.map((offset) => offset.x)),
    y: solveLeastSquares(features, offsets.map((offset) => offset.y)),
  };
  const errors = features.map((feature, index) => distance(offsets[index], {
    x: dot(model.x, feature),
    y: dot(model.y, feature),
  }));
  const rmsePx = Math.sqrt(mean(errors.map((error) => error ** 2)));
  const maximumErrorPx = Math.max(...errors);
  if (rmsePx > MAXIMUM_RMSE_PX || maximumErrorPx > MAXIMUM_ERROR_PX) {
    throw new Error(
      `Tool contact anchor fit is outside tolerance (${rmsePx.toFixed(3)} px RMSE, ` +
        `${maximumErrorPx.toFixed(3)} px maximum).`,
    );
  }
  return {
    version: 1,
    ...identity,
    calibratedVolume: roundedVolume(volume),
    normalization: roundedNormalization(normalization),
    offsetModel: {
      x: roundedCoefficients(model.x),
      y: roundedCoefficients(model.y),
    },
    evidence: {
      method: "stereo-factory-tip-anchor-v1",
      sampleCount: input.samples.length,
      minimumConfidence: rounded(Math.min(...input.samples.map((sample) =>
        sample.confidence
      ))),
      rmsePx: rounded(rmsePx),
      maximumErrorPx: rounded(maximumErrorPx),
    },
  };
}

export function createToolContactAnchorArtifact(
  calibration: ToolContactAnchorCalibration,
): ToolContactAnchorArtifact {
  const parsed = parseCalibration(calibration);
  return {
    calibration: parsed,
    sha256: toolContactAnchorFingerprint(parsed),
  };
}

export function parseToolContactAnchorArtifact(
  value: unknown,
): ToolContactAnchorArtifact {
  const input = record(value, "tool contact anchor artifact");
  const calibration = parseCalibration(input.calibration);
  const sha256 = stringValue(input.sha256, "sha256");
  if (!/^[a-f0-9]{64}$/u.test(sha256) ||
      sha256 !== toolContactAnchorFingerprint(calibration)) {
    throw new Error("Tool contact anchor hash does not match its calibration.");
  }
  return { calibration, sha256 };
}

export function toolContactAnchorFingerprint(
  calibration: ToolContactAnchorCalibration,
) {
  return createHash("sha256").update(JSON.stringify(calibration)).digest("hex");
}

export function projectContactTipCameraPoint(input: {
  artifact: ToolContactAnchorArtifact;
  deviceId: string;
  stationPlaneSha256: string;
  sourceProfileId: string;
  frame: { width: number; height: number };
  machinePoint: Point;
  physicalZMm: number;
  markerCameraPoint: Point;
  markerConfidence: number;
  frameAgeMs: number;
}): ToolContactAnchorProjection {
  const { artifact, ...projection } = input;
  return new ToolContactAnchorProjector(artifact).project(projection);
}

export class ToolContactAnchorProjector {
  readonly calibration: ToolContactAnchorCalibration;

  constructor(artifact: ToolContactAnchorArtifact) {
    this.calibration = parseToolContactAnchorArtifact(artifact).calibration;
  }

  project(input: {
    deviceId: string;
    stationPlaneSha256: string;
    sourceProfileId: string;
    frame: { width: number; height: number };
    machinePoint: Point;
    physicalZMm: number;
    markerCameraPoint: Point;
    markerConfidence: number;
    frameAgeMs: number;
  }): ToolContactAnchorProjection {
    const calibration = this.calibration;
    if (input.stationPlaneSha256 !== calibration.stationPlaneSha256) {
      return projectionHold("station-mismatch");
    }
    if (input.sourceProfileId !== calibration.sourceProfileId) {
      return projectionHold("profile-mismatch");
    }
    if (input.deviceId !== calibration.deviceId) {
      return projectionHold("device-mismatch");
    }
    if (
      input.frame.width !== calibration.frame.width ||
      input.frame.height !== calibration.frame.height
    ) return projectionHold("frame-mismatch");
    validateProjectionNumbers(input);
    if (input.markerConfidence < MINIMUM_RUNTIME_CONFIDENCE) {
      return projectionHold("marker-confidence-low");
    }
    if (input.frameAgeMs > MAXIMUM_RUNTIME_FRAME_AGE_MS) {
      return projectionHold("frame-stale");
    }
    if (!insideFrame(input.markerCameraPoint, calibration.frame)) {
      return projectionHold("outside-calibrated-volume");
    }
    if (!insideVolume(
      input.machinePoint,
      input.physicalZMm,
      calibration.calibratedVolume,
    )) return projectionHold("outside-calibrated-volume");
    const feature = normalizedFeatures(
      input.machinePoint,
      input.physicalZMm,
      calibration.normalization,
    );
    const estimatedOffsetPx = {
      x: dot(calibration.offsetModel.x, feature),
      y: dot(calibration.offsetModel.y, feature),
    };
    const contactTipCameraPoint = {
      x: input.markerCameraPoint.x + estimatedOffsetPx.x,
      y: input.markerCameraPoint.y + estimatedOffsetPx.y,
    };
    if (!insideFrame(contactTipCameraPoint, calibration.frame)) {
      return projectionHold("outside-calibrated-volume");
    }
    const calibrationQuality = clamp01(1 - calibration.evidence.rmsePx / 5);
    return {
      version: 1,
      mode: "shadow",
      status: "anchored",
      reason: "contact-tip-anchored",
      contactTipCameraPoint: roundedPoint(contactTipCameraPoint),
      pointReference: "absolute-contact-camera-point",
      confidence: rounded(Math.min(input.markerConfidence, calibrationQuality)),
      estimatedOffsetPx: roundedPoint(estimatedOffsetPx),
      calibrationRmsePx: calibration.evidence.rmsePx,
      eligibleForContactDepthEstimate: true,
      wouldMoveHardware: false,
      actionReady: false,
      blockers: [
        "contact_depth_not_evaluated",
        "compliant_contact_response_unverified",
        "capacitive_activation_unverified",
        "physical_promotion_gate_locked",
      ],
    };
  }
}

function projectionHold(
  reason: Exclude<ToolContactAnchorProjectionReason, "contact-tip-anchored">,
): ToolContactAnchorProjection {
  return {
    version: 1,
    mode: "shadow",
    status: "hold",
    reason,
    contactTipCameraPoint: null,
    pointReference: null,
    confidence: 0,
    estimatedOffsetPx: null,
    calibrationRmsePx: null,
    eligibleForContactDepthEstimate: false,
    wouldMoveHardware: false,
    actionReady: false,
    blockers: [reason],
  };
}

function calibrationIdentity(input: {
  deviceId: string;
  stationPlaneSha256: string;
  sourceProfileId: string;
  verifiedAt: string;
  frame: { width: number; height: number };
}) {
  const deviceId = stringValue(input.deviceId, "deviceId");
  const stationPlaneSha256 = stringValue(
    input.stationPlaneSha256,
    "stationPlaneSha256",
  );
  if (!/^[a-f0-9]{64}$/u.test(stationPlaneSha256)) {
    throw new Error("stationPlaneSha256 must be a lowercase SHA-256 digest.");
  }
  const sourceProfileId = stringValue(input.sourceProfileId, "sourceProfileId");
  const verifiedAt = stringValue(input.verifiedAt, "verifiedAt");
  if (!Number.isFinite(Date.parse(verifiedAt))) {
    throw new Error("verifiedAt must be an ISO-compatible timestamp.");
  }
  const frame = {
    width: positiveInteger(input.frame.width, "frame.width"),
    height: positiveInteger(input.frame.height, "frame.height"),
  };
  return { deviceId, stationPlaneSha256, sourceProfileId, verifiedAt, frame };
}

function parseCalibration(value: unknown): ToolContactAnchorCalibration {
  const input = record(value, "tool contact anchor calibration");
  const identity = calibrationIdentity({
    deviceId: stringValue(input.deviceId, "deviceId"),
    stationPlaneSha256: stringValue(input.stationPlaneSha256, "stationPlaneSha256"),
    sourceProfileId: stringValue(input.sourceProfileId, "sourceProfileId"),
    verifiedAt: stringValue(input.verifiedAt, "verifiedAt"),
    frame: record(input.frame, "frame") as { width: number; height: number },
  });
  const volumeInput = record(input.calibratedVolume, "calibratedVolume");
  const normalizationInput = record(input.normalization, "normalization");
  const modelInput = record(input.offsetModel, "offsetModel");
  const evidenceInput = record(input.evidence, "evidence");
  const calibration: ToolContactAnchorCalibration = {
    version: finiteNumber(input.version, "version") as 1,
    ...identity,
    calibratedVolume: {
      minimumX: finiteNumber(volumeInput.minimumX, "calibratedVolume.minimumX"),
      maximumX: finiteNumber(volumeInput.maximumX, "calibratedVolume.maximumX"),
      minimumY: finiteNumber(volumeInput.minimumY, "calibratedVolume.minimumY"),
      maximumY: finiteNumber(volumeInput.maximumY, "calibratedVolume.maximumY"),
      minimumZ: finiteNumber(volumeInput.minimumZ, "calibratedVolume.minimumZ"),
      maximumZ: finiteNumber(volumeInput.maximumZ, "calibratedVolume.maximumZ"),
    },
    normalization: {
      centerX: finiteNumber(normalizationInput.centerX, "normalization.centerX"),
      centerY: finiteNumber(normalizationInput.centerY, "normalization.centerY"),
      centerZ: finiteNumber(normalizationInput.centerZ, "normalization.centerZ"),
      scaleX: finiteNumber(normalizationInput.scaleX, "normalization.scaleX"),
      scaleY: finiteNumber(normalizationInput.scaleY, "normalization.scaleY"),
      scaleZ: finiteNumber(normalizationInput.scaleZ, "normalization.scaleZ"),
    },
    offsetModel: {
      x: coefficients(modelInput.x, "offsetModel.x"),
      y: coefficients(modelInput.y, "offsetModel.y"),
    },
    evidence: {
      method: stringValue(evidenceInput.method, "evidence.method") as
        "stereo-factory-tip-anchor-v1",
      sampleCount: positiveInteger(evidenceInput.sampleCount, "evidence.sampleCount"),
      minimumConfidence: ratio(
        evidenceInput.minimumConfidence,
        "evidence.minimumConfidence",
      ),
      rmsePx: nonnegativeNumber(evidenceInput.rmsePx, "evidence.rmsePx"),
      maximumErrorPx: nonnegativeNumber(
        evidenceInput.maximumErrorPx,
        "evidence.maximumErrorPx",
      ),
    },
  };
  if (calibration.version !== 1) throw new Error("Unsupported tool contact anchor version.");
  if (calibration.evidence.method !== "stereo-factory-tip-anchor-v1") {
    throw new Error("Unsupported tool contact anchor evidence method.");
  }
  if (
    calibration.evidence.sampleCount < MINIMUM_SAMPLES ||
    calibration.evidence.minimumConfidence < MINIMUM_SAMPLE_CONFIDENCE ||
    calibration.evidence.rmsePx > MAXIMUM_RMSE_PX ||
    calibration.evidence.maximumErrorPx > MAXIMUM_ERROR_PX ||
    calibration.evidence.maximumErrorPx < calibration.evidence.rmsePx
  ) throw new Error("Tool contact anchor evidence is outside the production gate.");
  const volume = calibration.calibratedVolume;
  if (
    volume.maximumX - volume.minimumX < MINIMUM_X_SPAN_MM ||
    volume.maximumY - volume.minimumY < MINIMUM_Y_SPAN_MM ||
    volume.maximumZ - volume.minimumZ < MINIMUM_Z_SPAN_MM
  ) throw new Error("Tool contact anchor calibrated volume is invalid.");
  const expectedNormalization = normalizationFor(volume);
  if (normalizationDistance(calibration.normalization, expectedNormalization) > 0.002) {
    throw new Error("Tool contact anchor normalization does not match its volume.");
  }
  return calibration;
}

function validateSamples(
  samples: ToolContactAnchorSample[],
  frame: { width: number; height: number },
) {
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.sequence) || sample.sequence <= 0) {
      throw new Error("Tool contact anchor sample sequence is invalid.");
    }
    const numbers = [
      sample.machinePoint.x,
      sample.machinePoint.y,
      sample.physicalZMm,
      sample.markerCameraPoint.x,
      sample.markerCameraPoint.y,
      sample.contactTipCameraPoint.x,
      sample.contactTipCameraPoint.y,
      sample.confidence,
    ];
    if (!numbers.every(Number.isFinite) || sample.confidence < 0 || sample.confidence > 1) {
      throw new Error("Tool contact anchor sample is malformed.");
    }
    if (
      !insideFrame(sample.markerCameraPoint, frame) ||
      !insideFrame(sample.contactTipCameraPoint, frame)
    ) throw new Error("Tool contact anchor camera evidence is outside the frame.");
  }
}

function validateProjectionNumbers(input: {
  machinePoint: Point;
  physicalZMm: number;
  markerCameraPoint: Point;
  markerConfidence: number;
  frameAgeMs: number;
}) {
  if (![
    input.machinePoint.x,
    input.machinePoint.y,
    input.physicalZMm,
    input.markerCameraPoint.x,
    input.markerCameraPoint.y,
    input.markerConfidence,
    input.frameAgeMs,
  ].every(Number.isFinite) || input.markerConfidence < 0 ||
      input.markerConfidence > 1 || input.frameAgeMs < 0) {
    throw new Error("Tool contact anchor projection input is malformed.");
  }
}

function calibratedVolume(samples: ToolContactAnchorSample[]) {
  const xs = samples.map((sample) => sample.machinePoint.x);
  const ys = samples.map((sample) => sample.machinePoint.y);
  const zs = samples.map((sample) => sample.physicalZMm);
  return {
    minimumX: Math.min(...xs),
    maximumX: Math.max(...xs),
    minimumY: Math.min(...ys),
    maximumY: Math.max(...ys),
    minimumZ: Math.min(...zs),
    maximumZ: Math.max(...zs),
  };
}

function normalizationFor(volume: ToolContactAnchorCalibration["calibratedVolume"]) {
  return {
    centerX: (volume.minimumX + volume.maximumX) / 2,
    centerY: (volume.minimumY + volume.maximumY) / 2,
    centerZ: (volume.minimumZ + volume.maximumZ) / 2,
    scaleX: (volume.maximumX - volume.minimumX) / 2,
    scaleY: (volume.maximumY - volume.minimumY) / 2,
    scaleZ: (volume.maximumZ - volume.minimumZ) / 2,
  };
}

function normalizedFeatures(
  point: Point,
  z: number,
  normalization: ToolContactAnchorCalibration["normalization"],
): [number, number, number, number] {
  return [
    1,
    (point.x - normalization.centerX) / normalization.scaleX,
    (point.y - normalization.centerY) / normalization.scaleY,
    (z - normalization.centerZ) / normalization.scaleZ,
  ];
}

function solveLeastSquares(
  features: Array<[number, number, number, number]>,
  targets: number[],
): [number, number, number, number] {
  const matrix = Array.from({ length: 4 }, () => Array(4).fill(0) as number[]);
  const vector = Array(4).fill(0) as number[];
  for (let row = 0; row < features.length; row += 1) {
    for (let left = 0; left < 4; left += 1) {
      vector[left] += features[row][left] * targets[row];
      for (let right = 0; right < 4; right += 1) {
        matrix[left][right] += features[row][left] * features[row][right];
      }
    }
  }
  return solveLinearSystem(matrix, vector) as [number, number, number, number];
}

function solveLinearSystem(matrix: number[][], vector: number[]) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < augmented.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < augmented.length; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) {
      throw new Error("Tool contact anchor samples are geometrically degenerate.");
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= augmented.length; index += 1) {
      augmented[column][index] /= divisor;
    }
    for (let row = 0; row < augmented.length; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= augmented.length; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[augmented.length]);
}

function insideVolume(
  point: Point,
  z: number,
  volume: ToolContactAnchorCalibration["calibratedVolume"],
) {
  return point.x >= volume.minimumX && point.x <= volume.maximumX &&
    point.y >= volume.minimumY && point.y <= volume.maximumY &&
    z >= volume.minimumZ && z <= volume.maximumZ;
}

function insideFrame(point: Point, frame: { width: number; height: number }) {
  return point.x >= 0 && point.x <= frame.width &&
    point.y >= 0 && point.y <= frame.height;
}

function coefficients(value: unknown, label: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} must contain four coefficients.`);
  }
  return value.map((entry, index) =>
    finiteNumber(entry, `${label}[${index}]`)
  ) as [number, number, number, number];
}

function dot(
  coefficientsValue: [number, number, number, number],
  features: [number, number, number, number],
) {
  return coefficientsValue.reduce((sum, coefficient, index) =>
    sum + coefficient * features[index], 0
  );
}

function normalizationDistance(
  left: ToolContactAnchorCalibration["normalization"],
  right: ToolContactAnchorCalibration["normalization"],
) {
  return Math.max(...(Object.keys(left) as Array<keyof typeof left>).map((key) =>
    Math.abs(left[key] - right[key])
  ));
}

function roundedVolume(value: ToolContactAnchorCalibration["calibratedVolume"]) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    rounded(entry),
  ])) as ToolContactAnchorCalibration["calibratedVolume"];
}

function roundedNormalization(value: ToolContactAnchorCalibration["normalization"]) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    rounded(entry),
  ])) as ToolContactAnchorCalibration["normalization"];
}

function roundedCoefficients(values: number[]): [number, number, number, number] {
  return values.map(roundedSix) as [number, number, number, number];
}

function roundedPoint(value: Point): Point {
  return { x: rounded(value.x), y: rounded(value.y) };
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundedSix(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function strictlyIncreasing(values: number[]) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
  return value;
}

function nonnegativeNumber(value: unknown, label: string) {
  const parsed = finiteNumber(value, label);
  if (parsed < 0) throw new Error(`${label} must be nonnegative.`);
  return parsed;
}

function positiveInteger(value: unknown, label: string) {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function ratio(value: unknown, label: string) {
  const parsed = finiteNumber(value, label);
  if (parsed < 0 || parsed > 1) throw new Error(`${label} must be in [0, 1].`);
  return parsed;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
