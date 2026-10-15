import { evaluateActionCandidate } from "./action-critic";
import { SemanticWorldModel } from "./semantic-world-model";
import type {
  ActiveWorldBeliefSnapshot,
  ActiveWorldTransition,
} from "./types";

export type SemanticWorldReplayMetrics = {
  trainTransitions: number;
  testTransitions: number;
  coveredTransitions: number;
  coverage: number;
  successBrierScore: number | null;
  successAccuracyAt50: number | null;
  nextScreenEvaluated: number;
  nextScreenTop1: number | null;
  nextScreenTop3: number | null;
  latencyEvaluated: number;
  latencyMeanAbsoluteErrorMs: number | null;
  criticEvaluated: number;
  criticAccuracy: number | null;
  criticFalseAcceptRate: number | null;
  criticFalseRejectRate: number | null;
  meanPredictionUncertainty: number | null;
};

export function splitTransitionsByRun(
  transitions: ActiveWorldTransition[],
  holdoutRatio = 0.2,
) {
  const ratio = Math.max(0.05, Math.min(0.95, holdoutRatio));
  const runs = [...new Set(transitions.map((transition) => transition.runId))]
    .sort((left, right) => stableHash(left) - stableHash(right) || left.localeCompare(right));
  if (runs.length < 2) return { train: [], test: [...transitions] };
  const holdoutCount = Math.max(1, Math.min(runs.length - 1, Math.round(runs.length * ratio)));
  const testRuns = new Set(runs.slice(0, holdoutCount));
  return {
    train: transitions.filter((transition) => !testRuns.has(transition.runId)),
    test: transitions.filter((transition) => testRuns.has(transition.runId)),
  };
}

export function evaluateSemanticWorldModel(
  train: ActiveWorldTransition[],
  test: ActiveWorldTransition[],
): SemanticWorldReplayMetrics {
  const model = new SemanticWorldModel(train);
  const brier: number[] = [];
  const successAccuracy: number[] = [];
  const uncertainties: number[] = [];
  const top1: number[] = [];
  const top3: number[] = [];
  const latencyErrors: number[] = [];
  const criticAccuracy: number[] = [];
  let falseAccepts = 0;
  let actualFailures = 0;
  let falseRejects = 0;
  let actualSuccesses = 0;
  let coveredTransitions = 0;

  for (const transition of test) {
    const belief = beliefFromTransition(transition);
    const prediction = model.predict({
      belief,
      action: transition.action.action,
      label: transition.action.label,
    });
    const success = transitionSuccess(transition);
    const critic = evaluateActionCandidate({
      label: transition.action.label,
      action: transition.action.action,
      planConfidence: Math.max(0.5, transition.precondition?.screenConfidence ?? 0.5),
      belief,
      prediction,
      evaluatedAt: transition.action.startedAt,
    });
    criticAccuracy.push(Number(critic.accepted === success));
    if (success) {
      actualSuccesses += 1;
      if (!critic.accepted) falseRejects += 1;
    } else {
      actualFailures += 1;
      if (critic.accepted) falseAccepts += 1;
    }
    if (prediction.successProbability === null) continue;
    coveredTransitions += 1;
    uncertainties.push(prediction.uncertainty);
    brier.push((prediction.successProbability - Number(success)) ** 2);
    successAccuracy.push(Number((prediction.successProbability >= 0.5) === success));

    const actualKind = transition.postcondition?.screenKind;
    if (actualKind) {
      const predicted = prediction.predictedScreenKinds.map((value) => value.kind);
      top1.push(Number(predicted[0] === actualKind));
      top3.push(Number(predicted.slice(0, 3).includes(actualKind)));
    }
    const actualLatencyMs = transitionLatency(transition);
    if (actualLatencyMs !== null && prediction.expectedLatencyMs !== null) {
      latencyErrors.push(Math.abs(prediction.expectedLatencyMs - actualLatencyMs));
    }
  }

  return {
    trainTransitions: train.length,
    testTransitions: test.length,
    coveredTransitions,
    coverage: rounded(coveredTransitions / Math.max(1, test.length)),
    successBrierScore: averageOrNull(brier),
    successAccuracyAt50: averageOrNull(successAccuracy),
    nextScreenEvaluated: top1.length,
    nextScreenTop1: averageOrNull(top1),
    nextScreenTop3: averageOrNull(top3),
    latencyEvaluated: latencyErrors.length,
    latencyMeanAbsoluteErrorMs: averageOrNull(latencyErrors),
    criticEvaluated: criticAccuracy.length,
    criticAccuracy: averageOrNull(criticAccuracy),
    criticFalseAcceptRate: actualFailures
      ? rounded(falseAccepts / actualFailures)
      : null,
    criticFalseRejectRate: actualSuccesses
      ? rounded(falseRejects / actualSuccesses)
      : null,
    meanPredictionUncertainty: averageOrNull(uncertainties),
  };
}

function beliefFromTransition(
  transition: ActiveWorldTransition,
): ActiveWorldBeliefSnapshot {
  const observation = transition.precondition;
  if (!observation) return emptyBelief();
  const uncertainty = clamp01(
    1 - observation.screenConfidence * 0.65 -
      observation.averageTextConfidence * 0.25 - 0.1,
  );
  return {
    revision: 1,
    observationCount: 1,
    updatedAt: observation.observedAt,
    viewport: { ...observation.viewport },
    screen: {
      kind: observation.screenKind,
      confidence: observation.screenConfidence,
      candidateKind: null,
      candidateStreak: 0,
      stableFrames: 1,
      unknownStreak: observation.screenKind === "unknown" ? 1 : 0,
      sequence: observation.sequence,
      capturedAt: observation.capturedAt,
      fingerprint: observation.fingerprint,
    },
    motion: {
      changeRatio: observation.changeRatio,
      changeKind: observation.changeKind,
    },
    keyboardVisible: observation.keyboardVisible,
    uncertainty: rounded(uncertainty),
    elements: observation.elements.map((element) => ({
      ...element,
      center: { ...element.center },
      bounds: { ...element.bounds },
      firstSeenSequence: observation.sequence,
      lastSeenSequence: observation.sequence,
      seenCount: 1,
    })),
    lastAction: null,
  };
}

function emptyBelief(): ActiveWorldBeliefSnapshot {
  return {
    revision: 0,
    observationCount: 0,
    updatedAt: 0,
    viewport: null,
    screen: null,
    motion: null,
    keyboardVisible: false,
    uncertainty: 1,
    elements: [],
    lastAction: null,
  };
}

function transitionSuccess(transition: ActiveWorldTransition) {
  return transition.action.status === "completed" && transition.verification.freshFrame;
}

function transitionLatency(transition: ActiveWorldTransition) {
  if (transition.postcondition) {
    return Math.max(0, transition.postcondition.observedAt - transition.action.startedAt);
  }
  return transition.action.elapsedMs ?? null;
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function averageOrNull(values: number[]) {
  return values.length
    ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
