import type { Point } from "../homography";

export type CameraZTrajectorySample = {
  sequence: number;
  commandedZMm: number;
  markerPoint: Point;
  /** Contact intersection requires the projected conductive tip itself, not
   * a tracked tool feature or template-relative hover residual. */
  markerPointReference: "absolute-contact-camera-point";
  markerConfidence: number;
  frameAgeMs: number;
};

export type CameraSurfaceLineSample = {
  sequence: number;
  line: { a: number; b: number; c: number };
  confidence: number;
  frameAgeMs: number;
};

export type CameraContactTargetSample = {
  sequence: number;
  targetPoint: Point;
  confidence: number;
  frameAgeMs: number;
};

export type ContactDepthShadowReason =
  | "surface-intersection-estimated"
  | "target-intersection-estimated"
  | "insufficient-samples"
  | "sequence-invalid"
  | "z-order-invalid"
  | "trajectory-outside-hardware-range"
  | "evidence-stale"
  | "evidence-confidence-low"
  | "z-span-insufficient"
  | "z-trajectory-unobservable"
  | "z-trajectory-noisy"
  | "surface-parallel-to-trajectory"
  | "surface-estimate-unstable"
  | "target-evidence-unstable"
  | "target-trajectory-miss"
  | "free-space-margin-insufficient"
  | "surface-outside-hardware-range"
  | "existing-pressure-range-too-deep";

export type ContactDepthShadowResult = {
  version: 1;
  mode: "shadow";
  status: "estimated" | "hold";
  reason: ContactDepthShadowReason;
  wouldMoveHardware: false;
  actionReady: false;
  estimatedSurfaceZMm: number | null;
  recommendedApproachZMm: number | null;
  trajectoryPixelsPerMm: number | null;
  trajectoryNormalPixelsPerMm: number | null;
  trajectoryRmsePx: number | null;
  trajectoryMaximumErrorPx: number | null;
  trajectoryR2: number | null;
  surfaceEstimateSpreadMm: number | null;
  targetSpreadPx: number | null;
  targetTrajectoryMissPx: number | null;
  blockers: string[];
};

export type ContactDepthShadowInput = {
  trajectory: CameraZTrajectorySample[];
  surface: CameraSurfaceLineSample[];
  hardware: {
    hoverZMm: number;
    minimumTouchZMm: number;
    maximumTouchZMm: number;
  };
};

export type ContactDepthShadowOptions = {
  minimumTrajectorySamples?: number;
  minimumSurfaceSamples?: number;
  minimumConfidence?: number;
  maximumFrameAgeMs?: number;
  minimumZSpanMm?: number;
  minimumTrajectoryPixelsPerMm?: number;
  minimumNormalPixelsPerMm?: number;
  maximumTrajectoryRmsePx?: number;
  maximumTrajectoryErrorPx?: number;
  minimumTrajectoryR2?: number;
  maximumSurfaceEstimateSpreadMm?: number;
  minimumFreeSpaceMarginMm?: number;
  approachClearanceMm?: number;
  maximumInitialCompressionMm?: number;
};

export type TargetIntersectionContactDepthShadowInput = {
  trajectory: CameraZTrajectorySample[];
  targets: CameraContactTargetSample[];
  hardware: ContactDepthShadowInput["hardware"];
};

export type TargetIntersectionContactDepthShadowOptions =
  ContactDepthShadowOptions & {
    minimumTargetSamples?: number;
    maximumTargetSpreadPx?: number;
    maximumTargetTrajectoryMissPx?: number;
  };

type Fit = {
  intercept: Point;
  slope: Point;
  pixelsPerMm: number;
  rmsePx: number;
  maximumErrorPx: number;
  r2: number;
};

type ContactDepthSuccessReason =
  | "surface-intersection-estimated"
  | "target-intersection-estimated";
type ContactDepthHoldReason = Exclude<
  ContactDepthShadowReason,
  ContactDepthSuccessReason
>;

/**
 * Estimates where a camera-visible stylus marker's free-space Z trajectory
 * intersects the visible glass plane. The evaluator is deliberately pure and
 * motorless: even a good estimate remains Shadow-only until compliant-contact
 * and capacitive-response evidence pass a separate physical promotion gate.
 */
export function evaluateContactDepthShadow(
  input: ContactDepthShadowInput,
  options: ContactDepthShadowOptions = {},
): ContactDepthShadowResult {
  validateHardware(input.hardware);
  const limits = contactDepthLimits(options);
  const empty = (reason: ContactDepthHoldReason) => hold(reason);
  if (
    input.trajectory.length < limits.minimumTrajectorySamples ||
    input.surface.length < limits.minimumSurfaceSamples
  ) return empty("insufficient-samples");

  validateTrajectory(input.trajectory);
  validateSurface(input.surface);
  if (
    !strictlyIncreasing(input.trajectory.map((sample) => sample.sequence)) ||
    !strictlyIncreasing(input.surface.map((sample) => sample.sequence))
  ) return empty("sequence-invalid");
  if (!strictlyIncreasing(input.trajectory.map((sample) => sample.commandedZMm))) {
    return empty("z-order-invalid");
  }
  if (input.trajectory.some((sample) =>
    sample.commandedZMm < input.hardware.hoverZMm ||
    sample.commandedZMm > input.hardware.maximumTouchZMm
  )) return empty("trajectory-outside-hardware-range");
  if ([...input.trajectory, ...input.surface].some((sample) =>
    sample.frameAgeMs > limits.maximumFrameAgeMs
  )) return empty("evidence-stale");
  if (
    input.trajectory.some((sample) =>
      sample.markerConfidence < limits.minimumConfidence
    ) ||
    input.surface.some((sample) => sample.confidence < limits.minimumConfidence)
  ) return empty("evidence-confidence-low");

  const zValues = input.trajectory.map((sample) => sample.commandedZMm);
  const zSpan = Math.max(...zValues) - Math.min(...zValues);
  if (zSpan < limits.minimumZSpanMm) return empty("z-span-insufficient");
  const fit = fitTrajectory(input.trajectory);
  const detail = fitDetail(fit);
  if (fit.pixelsPerMm < limits.minimumTrajectoryPixelsPerMm) {
    return hold("z-trajectory-unobservable", detail);
  }
  if (
    fit.rmsePx > limits.maximumTrajectoryRmsePx ||
    fit.maximumErrorPx > limits.maximumTrajectoryErrorPx ||
    fit.r2 < limits.minimumTrajectoryR2
  ) return hold("z-trajectory-noisy", detail);

  const intersections: number[] = [];
  const normalSpeeds: number[] = [];
  for (const sample of input.surface) {
    const line = normalizeLine(sample.line);
    const denominator = (line.a * fit.slope.x) + (line.b * fit.slope.y);
    normalSpeeds.push(Math.abs(denominator));
    if (Math.abs(denominator) < limits.minimumNormalPixelsPerMm) {
      return hold("surface-parallel-to-trajectory", {
        ...detail,
        trajectoryNormalPixelsPerMm: rounded(Math.abs(denominator)),
      });
    }
    intersections.push(-(
      (line.a * fit.intercept.x) +
      (line.b * fit.intercept.y) +
      line.c
    ) / denominator);
  }
  const estimatedSurfaceZMm = median(intersections);
  const surfaceEstimateSpreadMm = Math.max(...intersections.map((value) =>
    Math.abs(value - estimatedSurfaceZMm)
  ));
  const completeDetail = {
    ...detail,
    trajectoryNormalPixelsPerMm: rounded(Math.min(...normalSpeeds)),
    estimatedSurfaceZMm: rounded(estimatedSurfaceZMm),
    surfaceEstimateSpreadMm: rounded(surfaceEstimateSpreadMm),
    targetSpreadPx: null,
    targetTrajectoryMissPx: null,
  };
  if (surfaceEstimateSpreadMm > limits.maximumSurfaceEstimateSpreadMm) {
    return hold("surface-estimate-unstable", completeDetail);
  }
  return finalizeEstimate({
    estimatedSurfaceZMm,
    zValues,
    hardware: input.hardware,
    limits,
    detail: completeDetail,
    reason: "surface-intersection-estimated",
    blockers: [
      "compliant_contact_response_unverified",
      "capacitive_activation_unverified",
      "physical_promotion_gate_locked",
    ],
  });
}

/**
 * Estimates contact from the intersection of a tracked stylus trajectory and
 * the camera projection of the intended glass target. This is suitable for a
 * main camera that sees the screen as a plane rather than as a side-view line.
 * It remains motorless and cannot authorize contact.
 */
export function evaluateTargetIntersectionContactDepthShadow(
  input: TargetIntersectionContactDepthShadowInput,
  options: TargetIntersectionContactDepthShadowOptions = {},
): ContactDepthShadowResult {
  validateHardware(input.hardware);
  const limits = contactDepthLimits(options);
  const minimumTargetSamples = boundedInteger(
    options.minimumTargetSamples,
    2,
    20,
    3,
  );
  const maximumTargetSpreadPx = boundedNumber(
    options.maximumTargetSpreadPx,
    0.05,
    10,
    0.75,
  );
  const maximumTargetTrajectoryMissPx = boundedNumber(
    options.maximumTargetTrajectoryMissPx,
    0.05,
    10,
    0.75,
  );
  if (
    input.trajectory.length < limits.minimumTrajectorySamples ||
    input.targets.length < minimumTargetSamples
  ) return hold("insufficient-samples");
  validateTrajectory(input.trajectory);
  validateTargets(input.targets);
  if (
    !strictlyIncreasing(input.trajectory.map((sample) => sample.sequence)) ||
    !strictlyIncreasing(input.targets.map((sample) => sample.sequence))
  ) return hold("sequence-invalid");
  if (!strictlyIncreasing(input.trajectory.map((sample) => sample.commandedZMm))) {
    return hold("z-order-invalid");
  }
  if (input.trajectory.some((sample) =>
    sample.commandedZMm < input.hardware.hoverZMm ||
    sample.commandedZMm > input.hardware.maximumTouchZMm
  )) return hold("trajectory-outside-hardware-range");
  if ([...input.trajectory, ...input.targets].some((sample) =>
    sample.frameAgeMs > limits.maximumFrameAgeMs
  )) return hold("evidence-stale");
  if (
    input.trajectory.some((sample) =>
      sample.markerConfidence < limits.minimumConfidence
    ) ||
    input.targets.some((sample) => sample.confidence < limits.minimumConfidence)
  ) return hold("evidence-confidence-low");

  const zValues = input.trajectory.map((sample) => sample.commandedZMm);
  if (Math.max(...zValues) - Math.min(...zValues) < limits.minimumZSpanMm) {
    return hold("z-span-insufficient");
  }
  const fit = fitTrajectory(input.trajectory);
  const detail = fitDetail(fit);
  if (fit.pixelsPerMm < limits.minimumTrajectoryPixelsPerMm) {
    return hold("z-trajectory-unobservable", detail);
  }
  if (
    fit.rmsePx > limits.maximumTrajectoryRmsePx ||
    fit.maximumErrorPx > limits.maximumTrajectoryErrorPx ||
    fit.r2 < limits.minimumTrajectoryR2
  ) return hold("z-trajectory-noisy", detail);

  const target = {
    x: median(input.targets.map((sample) => sample.targetPoint.x)),
    y: median(input.targets.map((sample) => sample.targetPoint.y)),
  };
  const targetSpreadPx = Math.max(...input.targets.map((sample) =>
    distance(sample.targetPoint, target)
  ));
  const targetDetail = {
    ...detail,
    trajectoryNormalPixelsPerMm: rounded(fit.pixelsPerMm),
    targetSpreadPx: rounded(targetSpreadPx),
  };
  if (targetSpreadPx > maximumTargetSpreadPx) {
    return hold("target-evidence-unstable", targetDetail);
  }
  const slopeMagnitudeSquared =
    (fit.slope.x ** 2) + (fit.slope.y ** 2);
  const intersections = input.targets.map((sample) => (
    ((sample.targetPoint.x - fit.intercept.x) * fit.slope.x) +
    ((sample.targetPoint.y - fit.intercept.y) * fit.slope.y)
  ) / slopeMagnitudeSquared);
  const misses = input.targets.map((sample, index) => distance(
    sample.targetPoint,
    {
      x: fit.intercept.x + (fit.slope.x * intersections[index]),
      y: fit.intercept.y + (fit.slope.y * intersections[index]),
    },
  ));
  const targetTrajectoryMissPx = Math.max(...misses);
  const estimatedSurfaceZMm = median(intersections);
  const surfaceEstimateSpreadMm = Math.max(...intersections.map((value) =>
    Math.abs(value - estimatedSurfaceZMm)
  ));
  const completeDetail = {
    ...targetDetail,
    estimatedSurfaceZMm: rounded(estimatedSurfaceZMm),
    surfaceEstimateSpreadMm: rounded(surfaceEstimateSpreadMm),
    targetTrajectoryMissPx: rounded(targetTrajectoryMissPx),
  };
  if (targetTrajectoryMissPx > maximumTargetTrajectoryMissPx) {
    return hold("target-trajectory-miss", completeDetail);
  }
  if (surfaceEstimateSpreadMm > limits.maximumSurfaceEstimateSpreadMm) {
    return hold("surface-estimate-unstable", completeDetail);
  }
  return finalizeEstimate({
    estimatedSurfaceZMm,
    zValues,
    hardware: input.hardware,
    limits,
    detail: completeDetail,
    reason: "target-intersection-estimated",
    blockers: [
      "marker_contact_offset_unverified",
      "compliant_contact_response_unverified",
      "capacitive_activation_unverified",
      "physical_promotion_gate_locked",
    ],
  });
}

function finalizeEstimate(input: {
  estimatedSurfaceZMm: number;
  zValues: number[];
  hardware: ContactDepthShadowInput["hardware"];
  limits: ReturnType<typeof contactDepthLimits>;
  detail: Partial<ContactDepthShadowResult>;
  reason: ContactDepthSuccessReason;
  blockers: string[];
}): ContactDepthShadowResult {
  const deepestFreeSpaceZ = Math.max(...input.zValues);
  if (
    deepestFreeSpaceZ >
      input.estimatedSurfaceZMm - input.limits.minimumFreeSpaceMarginMm
  ) return hold("free-space-margin-insufficient", input.detail);
  if (
    input.estimatedSurfaceZMm <=
      input.hardware.hoverZMm + input.limits.approachClearanceMm ||
    input.estimatedSurfaceZMm > input.hardware.maximumTouchZMm
  ) return hold("surface-outside-hardware-range", input.detail);
  if (
    input.hardware.minimumTouchZMm - input.estimatedSurfaceZMm >
      input.limits.maximumInitialCompressionMm
  ) return hold("existing-pressure-range-too-deep", input.detail);
  return {
    version: 1,
    mode: "shadow",
    status: "estimated",
    reason: input.reason,
    wouldMoveHardware: false,
    actionReady: false,
    estimatedSurfaceZMm: rounded(input.estimatedSurfaceZMm),
    recommendedApproachZMm: rounded(
      input.estimatedSurfaceZMm - input.limits.approachClearanceMm,
    ),
    trajectoryPixelsPerMm: null,
    trajectoryNormalPixelsPerMm: null,
    trajectoryRmsePx: null,
    trajectoryMaximumErrorPx: null,
    trajectoryR2: null,
    surfaceEstimateSpreadMm: null,
    targetSpreadPx: null,
    targetTrajectoryMissPx: null,
    ...input.detail,
    blockers: input.blockers,
  };
}

function fitTrajectory(samples: CameraZTrajectorySample[]): Fit {
  const meanZ = mean(samples.map((sample) => sample.commandedZMm));
  const meanX = mean(samples.map((sample) => sample.markerPoint.x));
  const meanY = mean(samples.map((sample) => sample.markerPoint.y));
  const denominator = samples.reduce((sum, sample) =>
    sum + ((sample.commandedZMm - meanZ) ** 2), 0
  );
  if (denominator <= 1e-9) {
    return {
      intercept: { x: meanX, y: meanY },
      slope: { x: 0, y: 0 },
      pixelsPerMm: 0,
      rmsePx: Number.POSITIVE_INFINITY,
      maximumErrorPx: Number.POSITIVE_INFINITY,
      r2: 0,
    };
  }
  const slope = {
    x: samples.reduce((sum, sample) => sum +
      ((sample.commandedZMm - meanZ) * (sample.markerPoint.x - meanX)), 0) /
      denominator,
    y: samples.reduce((sum, sample) => sum +
      ((sample.commandedZMm - meanZ) * (sample.markerPoint.y - meanY)), 0) /
      denominator,
  };
  const intercept = {
    x: meanX - (slope.x * meanZ),
    y: meanY - (slope.y * meanZ),
  };
  const errors = samples.map((sample) => Math.hypot(
    sample.markerPoint.x - (intercept.x + slope.x * sample.commandedZMm),
    sample.markerPoint.y - (intercept.y + slope.y * sample.commandedZMm),
  ));
  const squaredError = errors.reduce((sum, value) => sum + (value ** 2), 0);
  const totalVariance = samples.reduce((sum, sample) => sum +
    ((sample.markerPoint.x - meanX) ** 2) +
    ((sample.markerPoint.y - meanY) ** 2), 0
  );
  return {
    intercept,
    slope,
    pixelsPerMm: Math.hypot(slope.x, slope.y),
    rmsePx: Math.sqrt(squaredError / samples.length),
    maximumErrorPx: Math.max(...errors),
    r2: totalVariance > 1e-9 ? 1 - (squaredError / totalVariance) : 0,
  };
}

function fitDetail(fit: Fit): Partial<ContactDepthShadowResult> {
  return {
    trajectoryPixelsPerMm: rounded(fit.pixelsPerMm),
    trajectoryRmsePx: rounded(fit.rmsePx),
    trajectoryMaximumErrorPx: rounded(fit.maximumErrorPx),
    trajectoryR2: rounded(fit.r2),
  };
}

function hold(
  reason: ContactDepthHoldReason,
  detail: Partial<ContactDepthShadowResult> = {},
): ContactDepthShadowResult {
  return {
    version: 1,
    mode: "shadow",
    status: "hold",
    reason,
    wouldMoveHardware: false,
    actionReady: false,
    estimatedSurfaceZMm: null,
    recommendedApproachZMm: null,
    trajectoryPixelsPerMm: null,
    trajectoryNormalPixelsPerMm: null,
    trajectoryRmsePx: null,
    trajectoryMaximumErrorPx: null,
    trajectoryR2: null,
    surfaceEstimateSpreadMm: null,
    targetSpreadPx: null,
    targetTrajectoryMissPx: null,
    blockers: [reason],
    ...detail,
  };
}

function validateHardware(hardware: ContactDepthShadowInput["hardware"]) {
  const values = [
    hardware.hoverZMm,
    hardware.minimumTouchZMm,
    hardware.maximumTouchZMm,
  ];
  if (!values.every(Number.isFinite)) {
    throw new Error("Contact-depth hardware limits must be finite.");
  }
  if (
    hardware.hoverZMm >= hardware.minimumTouchZMm ||
    hardware.minimumTouchZMm > hardware.maximumTouchZMm
  ) throw new Error("Contact-depth hardware limits are invalid.");
}

function validateTrajectory(samples: CameraZTrajectorySample[]) {
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.sequence) || sample.sequence <= 0 ||
      !Number.isFinite(sample.commandedZMm) ||
      sample.markerPointReference !== "absolute-contact-camera-point" ||
      !Number.isFinite(sample.markerPoint.x) ||
      !Number.isFinite(sample.markerPoint.y) ||
      !Number.isFinite(sample.markerConfidence) ||
      sample.markerConfidence < 0 || sample.markerConfidence > 1 ||
      !Number.isFinite(sample.frameAgeMs) || sample.frameAgeMs < 0
    ) throw new Error("Contact-depth trajectory evidence is malformed.");
  }
}

function validateSurface(samples: CameraSurfaceLineSample[]) {
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.sequence) || sample.sequence <= 0 ||
      !Number.isFinite(sample.confidence) ||
      sample.confidence < 0 || sample.confidence > 1 ||
      !Number.isFinite(sample.frameAgeMs) || sample.frameAgeMs < 0
    ) throw new Error("Contact-depth surface evidence is malformed.");
    normalizeLine(sample.line);
  }
}

function validateTargets(samples: CameraContactTargetSample[]) {
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.sequence) || sample.sequence <= 0 ||
      !Number.isFinite(sample.targetPoint.x) ||
      !Number.isFinite(sample.targetPoint.y) ||
      !Number.isFinite(sample.confidence) ||
      sample.confidence < 0 || sample.confidence > 1 ||
      !Number.isFinite(sample.frameAgeMs) || sample.frameAgeMs < 0
    ) throw new Error("Contact-depth target evidence is malformed.");
  }
}

function normalizeLine(line: CameraSurfaceLineSample["line"]) {
  if (![line.a, line.b, line.c].every(Number.isFinite)) {
    throw new Error("Contact-depth surface line must be finite.");
  }
  const length = Math.hypot(line.a, line.b);
  if (length <= 1e-9) throw new Error("Contact-depth surface line is degenerate.");
  return { a: line.a / length, b: line.b / length, c: line.c / length };
}

function strictlyIncreasing(values: number[]) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function rounded(value: number) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : value;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isFinite(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function boundedRatio(value: number | undefined, fallback: number) {
  return boundedNumber(value, 0, 1, fallback);
}

function contactDepthLimits(options: ContactDepthShadowOptions) {
  return {
    minimumTrajectorySamples: boundedInteger(
      options.minimumTrajectorySamples,
      3,
      20,
      4,
    ),
    minimumSurfaceSamples: boundedInteger(options.minimumSurfaceSamples, 2, 20, 3),
    minimumConfidence: boundedRatio(options.minimumConfidence, 0.9),
    maximumFrameAgeMs: boundedNumber(options.maximumFrameAgeMs, 20, 2_000, 150),
    minimumZSpanMm: boundedNumber(options.minimumZSpanMm, 0.5, 8, 2),
    minimumTrajectoryPixelsPerMm: boundedNumber(
      options.minimumTrajectoryPixelsPerMm,
      0.25,
      100,
      1.5,
    ),
    minimumNormalPixelsPerMm: boundedNumber(
      options.minimumNormalPixelsPerMm,
      0.25,
      100,
      1.25,
    ),
    maximumTrajectoryRmsePx: boundedNumber(
      options.maximumTrajectoryRmsePx,
      0.1,
      20,
      0.75,
    ),
    maximumTrajectoryErrorPx: boundedNumber(
      options.maximumTrajectoryErrorPx,
      0.1,
      30,
      1.5,
    ),
    minimumTrajectoryR2: boundedRatio(options.minimumTrajectoryR2, 0.995),
    maximumSurfaceEstimateSpreadMm: boundedNumber(
      options.maximumSurfaceEstimateSpreadMm,
      0.02,
      2,
      0.2,
    ),
    minimumFreeSpaceMarginMm: boundedNumber(
      options.minimumFreeSpaceMarginMm,
      0.1,
      3,
      0.5,
    ),
    approachClearanceMm: boundedNumber(options.approachClearanceMm, 0.1, 2, 0.35),
    maximumInitialCompressionMm: boundedNumber(
      options.maximumInitialCompressionMm,
      0.1,
      2,
      0.75,
    ),
  };
}
