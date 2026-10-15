import type { ScreenHandSemanticAction } from "../action-contract";
import type {
  ActiveWorldBeliefSnapshot,
  ActiveWorldSpeculativeHoverDecision,
  ActiveWorldSpeculativeHoverReason,
} from "./types";

export type SpeculativeHoverInput = {
  label: string;
  action: ScreenHandSemanticAction;
  planConfidence: number;
  belief: ActiveWorldBeliefSnapshot;
  evaluatedAt?: number;
};

export type SpeculativeHoverOptions = {
  minimumPlanConfidence?: number;
  maximumBeliefUncertainty?: number;
  minimumScreenConfidence?: number;
  maximumFrameLag?: number;
  safeInsetRatio?: number;
};

/**
 * Evaluates reversible pre-positioning without ever constructing or sending a
 * hardware command. This is intentionally a pure shadow decision until replay
 * and physical benchmarks prove that speculation improves the full task.
 */
export function evaluateSpeculativeHover(
  input: SpeculativeHoverInput,
  options: SpeculativeHoverOptions = {},
): ActiveWorldSpeculativeHoverDecision {
  const minimumPlanConfidence = boundedRatio(options.minimumPlanConfidence, 0.86);
  const maximumBeliefUncertainty = boundedRatio(options.maximumBeliefUncertainty, 0.3);
  const minimumScreenConfidence = boundedRatio(options.minimumScreenConfidence, 0.75);
  const maximumFrameLag = boundedInteger(options.maximumFrameLag, 0, 12, 1);
  const safeInsetRatio = boundedRatio(options.safeInsetRatio, 0.03);
  const beliefSequence = input.belief.screen?.sequence ?? null;
  const actionFrameSequence = "frameSequence" in input.action
    ? input.action.frameSequence
    : null;
  const frameLag = beliefSequence !== null && actionFrameSequence !== null
    ? beliefSequence - actionFrameSequence
    : null;
  const base = {
    mode: "shadow" as const,
    evaluatedAt: input.evaluatedAt ?? Date.now(),
    label: input.label,
    actionType: input.action.type,
    wouldMoveHardware: false as const,
    planConfidence: rounded(clamp01(input.planConfidence)),
    beliefRevision: input.belief.revision,
    beliefUncertainty: rounded(clamp01(input.belief.uncertainty)),
    beliefSequence,
    actionFrameSequence,
    frameLag,
  };
  const reject = (
    reason: Exclude<ActiveWorldSpeculativeHoverReason, "eligible-shadow-only">,
  ): ActiveWorldSpeculativeHoverDecision => ({ ...base, eligible: false, reason });

  if (input.action.type !== "tap") return reject("action-not-tap");
  const screen = input.belief.screen;
  const beliefViewport = input.belief.viewport;
  if (!screen || !beliefViewport) return reject("belief-unavailable");
  if (input.belief.lastAction?.status === "executing") {
    return reject("action-in-progress");
  }
  if (input.planConfidence < minimumPlanConfidence) {
    return reject("plan-confidence-low");
  }
  if (input.belief.uncertainty > maximumBeliefUncertainty) {
    return reject("belief-uncertain");
  }
  if (screen.confidence < minimumScreenConfidence) {
    return reject("screen-confidence-low");
  }
  if (
    input.belief.motion &&
    input.belief.motion.changeKind !== "first" &&
    input.belief.motion.changeKind !== "stable"
  ) return reject("screen-moving");
  if (frameLag === null) return reject("belief-unavailable");
  if (frameLag < 0) return reject("future-frame");
  if (frameLag > maximumFrameLag) return reject("stale-frame");
  if (!sameViewport(input.action.viewport, beliefViewport)) {
    return reject("viewport-mismatch");
  }

  const { point, viewport, frameSequence } = input.action;
  if (
    point.x < 0 || point.x > viewport.width ||
    point.y < 0 || point.y > viewport.height
  ) return reject("target-out-of-range");
  const normalizedPoint = {
    x: rounded(point.x / viewport.width),
    y: rounded(point.y / viewport.height),
  };
  if (
    normalizedPoint.x < safeInsetRatio ||
    normalizedPoint.x > 1 - safeInsetRatio ||
    normalizedPoint.y < safeInsetRatio ||
    normalizedPoint.y > 1 - safeInsetRatio
  ) return reject("target-near-edge");

  return {
    ...base,
    eligible: true,
    reason: "eligible-shadow-only",
    candidate: {
      point: { ...point },
      normalizedPoint,
      viewport: { ...viewport },
      frameSequence,
    },
  };
}

function sameViewport(
  left: { width: number; height: number },
  right: { width: number; height: number },
) {
  return left.width === right.width && left.height === right.height;
}

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
    ? Number(value)
    : fallback;
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

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
