import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenHandSemanticAction } from "../action-contract";
import { evaluateActionCandidate } from "./action-critic";
import type { SemanticWorldPrediction } from "./semantic-world-model";
import type { ActiveWorldBeliefSnapshot } from "./types";

test("accepts a fresh candidate and identifies an irreversible-action barrier", () => {
  const accepted = evaluateActionCandidate({
    label: "open profile",
    action: tap(10),
    planConfidence: 0.92,
    belief: belief(),
    prediction: prediction(),
    evaluatedAt: 1_000,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.requiresBarrier, false);
  assert.equal(accepted.wouldChangeExecution, false);

  const send = evaluateActionCandidate({
    label: "send message",
    action: tap(10),
    planConfidence: 0.92,
    belief: belief(),
    prediction: prediction(),
  });
  assert.equal(send.accepted, true);
  assert.equal(send.requiresBarrier, true);
  assert.equal(send.reason, "accepted-requires-barrier");
});

test("rejects stale, uncertain, and historically poor candidates in Shadow", () => {
  assert.equal(evaluateActionCandidate({
    label: "stale",
    action: tap(7),
    planConfidence: 0.92,
    belief: belief(),
    prediction: prediction(),
  }).reason, "stale-frame");
  assert.equal(evaluateActionCandidate({
    label: "uncertain",
    action: tap(10),
    planConfidence: 0.92,
    belief: { ...belief(), uncertainty: 0.8 },
    prediction: prediction(),
  }).reason, "belief-uncertain");
  assert.equal(evaluateActionCandidate({
    label: "poor history",
    action: tap(10),
    planConfidence: 0.92,
    belief: belief(),
    prediction: prediction({ successProbability: 0.2 }),
  }).reason, "verified-history-poor");
});

function tap(sequence: number): ScreenHandSemanticAction {
  return {
    type: "tap",
    point: { x: 200, y: 300 },
    viewport: { width: 720, height: 1_560 },
    frameSequence: sequence,
    durationMs: 60,
  };
}

function prediction(
  overrides: Partial<SemanticWorldPrediction> = {},
): SemanticWorldPrediction {
  return {
    sampleCount: 4,
    effectiveSamples: 4,
    successProbability: 0.9,
    visualChangeProbability: 0.9,
    semanticChangeProbability: 0.8,
    expectedLatencyMs: 180,
    uncertainty: 0.2,
    predictedScreenKinds: [{ kind: "text_ui", probability: 1 }],
    evidenceTransitionIds: ["a", "b", "c", "d"],
    ...overrides,
  };
}

function belief(): ActiveWorldBeliefSnapshot {
  return {
    revision: 2,
    observationCount: 2,
    updatedAt: 1_000,
    viewport: { width: 720, height: 1_560 },
    screen: {
      kind: "home_grid",
      confidence: 0.95,
      candidateKind: null,
      candidateStreak: 0,
      stableFrames: 2,
      unknownStreak: 0,
      sequence: 10,
      capturedAt: 990,
      fingerprint: "home-10",
    },
    motion: { changeRatio: 0.001, changeKind: "stable" },
    keyboardVisible: false,
    uncertainty: 0.1,
    elements: [],
    lastAction: null,
  };
}
