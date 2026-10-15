import {
  homographyFromFourPoints,
  projectPoint,
  type Point,
} from "../homography";
import type { ScreenQuad } from "../vision-screen";

export type VisualServoSafetyBounds = {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
};

export type VisualServoCorrectionInput = {
  phonePoints: ScreenQuad;
  controlMachinePoints: ScreenQuad;
  targetCameraPoint: Point;
  observedTipCameraPoint: Point;
  currentMachinePoint: Point;
  safeMachineBounds: VisualServoSafetyBounds;
  phoneConfidence: number;
  tipConfidence: number;
  frameAgeMs: number;
  occluded: boolean;
};

export type VisualServoCorrectionOptions = {
  minimumPhoneConfidence?: number;
  minimumTipConfidence?: number;
  maximumFrameAgeMs?: number;
  deadbandMm?: number;
  maximumResidualMm?: number;
  maximumCorrectionStepMm?: number;
  correctionGain?: number;
  boundsMarginMm?: number;
};

export type VisualServoCorrection = {
  mode: "shadow";
  status: "correct" | "settled" | "hold";
  reason:
    | "correction-proposed"
    | "inside-deadband"
    | "phone-confidence-low"
    | "tip-confidence-low"
    | "frame-stale"
    | "tip-occluded"
    | "residual-excessive"
    | "target-outside-safe-bounds"
    | "correction-outside-safe-bounds";
  wouldMoveHardware: false;
  targetMachinePoint: Point | null;
  observedTipMachinePoint: Point | null;
  residualMachine: Point | null;
  residualMm: number | null;
  correctionDelta: Point | null;
  proposedMachinePoint: Point | null;
};

/**
 * Converts image-space tip error into a bounded machine-space correction.
 * The output is Shadow-only and cannot execute a motor command.
 */
export function evaluateVisualServoCorrection(
  input: VisualServoCorrectionInput,
  options: VisualServoCorrectionOptions = {},
): VisualServoCorrection {
  const base = {
    mode: "shadow" as const,
    wouldMoveHardware: false as const,
  };
  const hold = (
    reason: Extract<VisualServoCorrection["reason"],
      "phone-confidence-low" | "tip-confidence-low" | "frame-stale" |
      "tip-occluded" | "residual-excessive" | "target-outside-safe-bounds" |
      "correction-outside-safe-bounds">,
    detail: Partial<VisualServoCorrection> = {},
  ): VisualServoCorrection => ({
    ...base,
    status: "hold",
    reason,
    targetMachinePoint: null,
    observedTipMachinePoint: null,
    residualMachine: null,
    residualMm: null,
    correctionDelta: null,
    proposedMachinePoint: null,
    ...detail,
  });

  if (input.phoneConfidence < boundedRatio(options.minimumPhoneConfidence, 0.82)) {
    return hold("phone-confidence-low");
  }
  if (input.tipConfidence < boundedRatio(options.minimumTipConfidence, 0.78)) {
    return hold("tip-confidence-low");
  }
  if (input.frameAgeMs > boundedNumber(options.maximumFrameAgeMs, 20, 2_000, 120)) {
    return hold("frame-stale");
  }
  if (input.occluded) return hold("tip-occluded");

  const cameraToMachine = homographyFromFourPoints(
    input.phonePoints,
    input.controlMachinePoints,
  );
  const targetMachinePoint = projectPoint(cameraToMachine, input.targetCameraPoint);
  const observedTipMachinePoint = projectPoint(
    cameraToMachine,
    input.observedTipCameraPoint,
  );
  if (!insideBounds(targetMachinePoint, input.safeMachineBounds, 0)) {
    return hold("target-outside-safe-bounds", {
      targetMachinePoint: roundedPoint(targetMachinePoint),
      observedTipMachinePoint: roundedPoint(observedTipMachinePoint),
    });
  }
  const residualMachine = {
    x: targetMachinePoint.x - observedTipMachinePoint.x,
    y: targetMachinePoint.y - observedTipMachinePoint.y,
  };
  const residualMm = Math.hypot(residualMachine.x, residualMachine.y);
  const common = {
    targetMachinePoint: roundedPoint(targetMachinePoint),
    observedTipMachinePoint: roundedPoint(observedTipMachinePoint),
    residualMachine: roundedPoint(residualMachine),
    residualMm: rounded(residualMm),
  };
  if (residualMm > boundedNumber(options.maximumResidualMm, 0.5, 50, 8)) {
    return hold("residual-excessive", common);
  }
  if (residualMm <= boundedNumber(options.deadbandMm, 0, 5, 0.18)) {
    return {
      ...base,
      status: "settled",
      reason: "inside-deadband",
      ...common,
      correctionDelta: { x: 0, y: 0 },
      proposedMachinePoint: roundedPoint(input.currentMachinePoint),
    };
  }

  const gain = boundedRatio(options.correctionGain, 0.72);
  const maximumStep = boundedNumber(options.maximumCorrectionStepMm, 0.05, 5, 0.8);
  const requested = {
    x: residualMachine.x * gain,
    y: residualMachine.y * gain,
  };
  const requestedLength = Math.hypot(requested.x, requested.y);
  const scale = requestedLength > maximumStep ? maximumStep / requestedLength : 1;
  const correctionDelta = {
    x: requested.x * scale,
    y: requested.y * scale,
  };
  const proposedMachinePoint = {
    x: input.currentMachinePoint.x + correctionDelta.x,
    y: input.currentMachinePoint.y + correctionDelta.y,
  };
  const margin = boundedNumber(options.boundsMarginMm, 0, 10, 0.35);
  if (!insideBounds(proposedMachinePoint, input.safeMachineBounds, margin)) {
    return hold("correction-outside-safe-bounds", {
      ...common,
      correctionDelta: roundedPoint(correctionDelta),
      proposedMachinePoint: roundedPoint(proposedMachinePoint),
    });
  }
  return {
    ...base,
    status: "correct",
    reason: "correction-proposed",
    ...common,
    correctionDelta: roundedPoint(correctionDelta),
    proposedMachinePoint: roundedPoint(proposedMachinePoint),
  };
}

function insideBounds(
  point: Point,
  bounds: VisualServoSafetyBounds,
  margin: number,
) {
  return point.x >= bounds.minimumX + margin &&
    point.x <= bounds.maximumX - margin &&
    point.y >= bounds.minimumY + margin &&
    point.y <= bounds.maximumY - margin;
}

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
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

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundedPoint(point: Point) {
  return { x: rounded(point.x), y: rounded(point.y) };
}
