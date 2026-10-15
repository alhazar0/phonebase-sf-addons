import type { ScreenHandSemanticAction } from "../action-contract";
import type { SemanticWorldPrediction } from "./semantic-world-model";
import type {
  ActiveWorldBeliefSnapshot,
  ActiveWorldCriticDecision,
  ActiveWorldCriticReason,
} from "./types";

export type ActionCriticInput = {
  label: string;
  action: ScreenHandSemanticAction;
  planConfidence: number;
  belief: ActiveWorldBeliefSnapshot;
  prediction: SemanticWorldPrediction;
  evaluatedAt?: number;
};

export type ActionCriticOptions = {
  maximumBeliefUncertainty?: number;
  maximumFrameLag?: number;
  minimumPlanConfidence?: number;
  minimumScore?: number;
  minimumHistorySamples?: number;
  minimumHistoricalSuccess?: number;
};

/** Independent Shadow critic; its decision is logged but cannot alter execution. */
export function evaluateActionCandidate(
  input: ActionCriticInput,
  options: ActionCriticOptions = {},
): ActiveWorldCriticDecision {
  const beliefSequence = input.belief.screen?.sequence ?? null;
  const actionFrameSequence = "frameSequence" in input.action
    ? input.action.frameSequence
    : null;
  const frameLag = beliefSequence !== null && actionFrameSequence !== null
    ? beliefSequence - actionFrameSequence
    : null;
  const sideEffectRisk = classifySideEffectRisk(input.action, input.label);
  const requiresBarrier = sideEffectRisk === "high";
  const historyReady = input.prediction.effectiveSamples >= boundedInteger(
    options.minimumHistorySamples,
    1,
    100,
    3,
  );
  const predictedSuccess = historyReady && input.prediction.successProbability !== null
    ? input.prediction.successProbability
    : input.planConfidence;
  const score = clamp01(
    input.planConfidence * 0.5 +
    (1 - input.belief.uncertainty) * 0.25 +
    predictedSuccess * 0.25,
  );
  const base = {
    mode: "shadow" as const,
    evaluatedAt: input.evaluatedAt ?? Date.now(),
    label: input.label,
    actionType: input.action.type,
    requiresBarrier,
    sideEffectRisk,
    wouldChangeExecution: false as const,
    score: rounded(score),
    planConfidence: rounded(clamp01(input.planConfidence)),
    beliefRevision: input.belief.revision,
    beliefUncertainty: rounded(clamp01(input.belief.uncertainty)),
    beliefSequence,
    actionFrameSequence,
    frameLag,
    prediction: compactPrediction(input.prediction),
  };
  const decision = (
    accepted: boolean,
    reason: ActiveWorldCriticReason,
  ): ActiveWorldCriticDecision => ({ ...base, accepted, reason });

  if (!input.belief.screen) return decision(false, "belief-unavailable");
  if (input.belief.lastAction?.status === "executing") {
    return decision(false, "action-in-progress");
  }
  if (input.belief.uncertainty > boundedRatio(options.maximumBeliefUncertainty, 0.55)) {
    return decision(false, "belief-uncertain");
  }
  if (frameLag !== null && frameLag < 0) return decision(false, "future-frame");
  if (
    frameLag !== null &&
    frameLag > boundedInteger(options.maximumFrameLag, 0, 20, 2)
  ) return decision(false, "stale-frame");
  if (input.planConfidence < boundedRatio(options.minimumPlanConfidence, 0.42)) {
    return decision(false, "plan-confidence-low");
  }
  if (
    historyReady &&
    input.prediction.successProbability !== null &&
    input.prediction.successProbability < boundedRatio(
      options.minimumHistoricalSuccess,
      0.45,
    )
  ) return decision(false, "verified-history-poor");
  if (score < boundedRatio(options.minimumScore, 0.55)) {
    return decision(false, "critic-score-low");
  }
  return decision(
    true,
    requiresBarrier ? "accepted-requires-barrier" : "accepted",
  );
}

function compactPrediction(prediction: SemanticWorldPrediction) {
  return {
    sampleCount: prediction.sampleCount,
    effectiveSamples: prediction.effectiveSamples,
    successProbability: prediction.successProbability,
    visualChangeProbability: prediction.visualChangeProbability,
    semanticChangeProbability: prediction.semanticChangeProbability,
    expectedLatencyMs: prediction.expectedLatencyMs,
    uncertainty: prediction.uncertainty,
    predictedScreenKinds: prediction.predictedScreenKinds,
    evidenceTransitionIds: prediction.evidenceTransitionIds,
  };
}

function classifySideEffectRisk(
  action: ScreenHandSemanticAction,
  label: string,
): "low" | "medium" | "high" {
  if (action.type === "home" || action.type === "hold" || action.type === "resume") {
    return "medium";
  }
  if (action.type === "phone_key" && action.key === "enter") return "high";
  if (action.type === "input_text") return "medium";
  const normalized = label.normalize("NFKC").toLocaleLowerCase("en-US");
  if (
    /\b(?:send|post|publish|delete|follow|unfollow|like|comment|pay|purchase|buy|submit|confirm)\b/u
      .test(normalized) ||
    /发送|发布|删除|关注|取消关注|点赞|评论|支付|购买|提交|确认/u.test(normalized)
  ) return "high";
  return "low";
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

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
    ? Number(value)
    : fallback;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
