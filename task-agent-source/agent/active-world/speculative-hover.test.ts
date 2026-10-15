import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenHandSemanticAction } from "../action-contract";
import { evaluateSpeculativeHover } from "./speculative-hover";
import type { ActiveWorldBeliefSnapshot } from "./types";

test("marks a fresh high-confidence tap eligible without moving hardware", () => {
  const decision = evaluateSpeculativeHover({
    label: "open result",
    action: tap(42, 360, 780),
    planConfidence: 0.96,
    belief: belief(),
    evaluatedAt: 1_000,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, "eligible-shadow-only");
  assert.equal(decision.wouldMoveHardware, false);
  assert.deepEqual(decision.candidate?.normalizedPoint, { x: 0.5, y: 0.5 });
  assert.equal(decision.frameLag, 0);
});

test("rejects stale, moving, uncertain, edge and non-tap candidates", () => {
  assert.equal(evaluateSpeculativeHover({
    label: "stale",
    action: tap(39, 360, 780),
    planConfidence: 0.96,
    belief: belief(),
  }).reason, "stale-frame");
  assert.equal(evaluateSpeculativeHover({
    label: "moving",
    action: tap(42, 360, 780),
    planConfidence: 0.96,
    belief: belief({ motion: { changeRatio: 0.2, changeKind: "major" } }),
  }).reason, "screen-moving");
  assert.equal(evaluateSpeculativeHover({
    label: "uncertain",
    action: tap(42, 360, 780),
    planConfidence: 0.96,
    belief: belief({ uncertainty: 0.5 }),
  }).reason, "belief-uncertain");
  assert.equal(evaluateSpeculativeHover({
    label: "edge",
    action: tap(42, 5, 780),
    planConfidence: 0.96,
    belief: belief(),
  }).reason, "target-near-edge");
  const swipe: ScreenHandSemanticAction = {
    type: "swipe",
    start: { x: 360, y: 1_200 },
    end: { x: 360, y: 300 },
    viewport: { width: 720, height: 1_560 },
    frameSequence: 42,
    durationMs: 500,
  };
  assert.equal(evaluateSpeculativeHover({
    label: "scroll",
    action: swipe,
    planConfidence: 0.96,
    belief: belief(),
  }).reason, "action-not-tap");
});

function tap(sequence: number, x: number, y: number): ScreenHandSemanticAction {
  return {
    type: "tap",
    point: { x, y },
    viewport: { width: 720, height: 1_560 },
    frameSequence: sequence,
    durationMs: 60,
  };
}

function belief(
  overrides: Partial<ActiveWorldBeliefSnapshot> = {},
): ActiveWorldBeliefSnapshot {
  return {
    revision: 3,
    observationCount: 3,
    updatedAt: 900,
    viewport: { width: 720, height: 1_560 },
    screen: {
      kind: "text_ui",
      confidence: 0.94,
      candidateKind: null,
      candidateStreak: 0,
      stableFrames: 3,
      unknownStreak: 0,
      sequence: 42,
      capturedAt: 850,
      fingerprint: "screen-42",
    },
    motion: { changeRatio: 0.001, changeKind: "stable" },
    keyboardVisible: false,
    uncertainty: 0.12,
    elements: [],
    lastAction: null,
    ...overrides,
  };
}
