import assert from "node:assert/strict";
import test from "node:test";

import { DISTURBANCE_AXES } from "./curriculum";
import {
  evaluatePromotionGate,
  type PromotionGateEvidence,
} from "./promotion-gate";

test("passes a complete held-out replay evidence package", () => {
  const decision = evaluatePromotionGate(replayEvidence());
  assert.equal(decision.passed, true);
  assert.deepEqual(decision.blockers, []);
});

test("blocks a model that is accurate but slows the end-to-end task", () => {
  const decision = evaluatePromotionGate({
    ...replayEvidence(),
    taskDurationRatioToBaseline: 1.01,
    avoidableIdleGapP95Ms: 51,
  });
  assert.equal(decision.passed, false);
  assert.ok(decision.blockers.includes("task_duration_ratio_vs_baseline"));
  assert.ok(decision.blockers.includes("avoidable_idle_gap_p95_ms"));
});

test("treats absent or null replay metrics as blockers", () => {
  const evidence = replayEvidence();
  delete evidence.replayMetrics;
  const decision = evaluatePromotionGate(evidence);
  assert.equal(decision.passed, false);
  assert.ok(decision.blockers.includes("replay_train_transitions"));
  assert.ok(decision.blockers.includes("replay_success_brier"));
});

test("requires complete disturbance coverage and zero unsafe actions", () => {
  const decision = evaluatePromotionGate({
    ...replayEvidence(),
    disturbanceAxesCovered: ["popup"],
    duplicateIrreversibleActions: 1,
  });
  assert.equal(decision.passed, false);
  assert.ok(decision.blockers.includes("disturbance_axis_coverage"));
  assert.ok(decision.blockers.includes("duplicate_irreversible_actions"));
});

test("cannot pass a stage whose prerequisite evidence is absent", () => {
  const decision = evaluatePromotionGate({
    ...replayEvidence(),
    passedStages: [],
  });
  assert.equal(decision.passed, false);
  assert.deepEqual(decision.blockers, ["prerequisite_stages"]);
});

test("holds controlled side effects behind the physical and soak gates", () => {
  const evidence: PromotionGateEvidence = {
    ...baseEvidence(),
    stage: "controlled_side_effect",
    passedStages: ["simulator", "replay", "reversible_physical"],
    evaluatedRuns: 500,
    distinctSeeds: 20,
    cameraReconnectSuccessRate: 0.99,
    targetCenterErrorP95Pixels: 7,
    unattendedSoakHours: 7.9,
  };
  const blocked = evaluatePromotionGate(evidence);
  assert.equal(blocked.passed, false);
  assert.deepEqual(blocked.blockers, ["unattended_soak_hours"]);
  const passed = evaluatePromotionGate({ ...evidence, unattendedSoakHours: 8 });
  assert.equal(passed.passed, true);
});

function replayEvidence(): PromotionGateEvidence {
  return {
    ...baseEvidence(),
    stage: "replay",
    passedStages: ["simulator"],
    evaluatedRuns: 200,
    distinctSeeds: 10,
    replayMetrics: {
      trainTransitions: 500,
      testTransitions: 100,
      coveredTransitions: 90,
      coverage: 0.9,
      successBrierScore: 0.1,
      successAccuracyAt50: 0.96,
      nextScreenEvaluated: 90,
      nextScreenTop1: 0.8,
      nextScreenTop3: 0.92,
      latencyEvaluated: 90,
      latencyMeanAbsoluteErrorMs: 40,
      criticEvaluated: 100,
      criticAccuracy: 0.96,
      criticFalseAcceptRate: 0.005,
      criticFalseRejectRate: 0.02,
      meanPredictionUncertainty: 0.12,
    },
  };
}

function baseEvidence(): PromotionGateEvidence {
  return {
    stage: "simulator",
    passedStages: [],
    heldOut: true,
    evaluatedRuns: 500,
    distinctSeeds: 20,
    certifiedSuccessRate: 0.97,
    baselineSuccessRate: 0.96,
    taskDurationRatioToBaseline: 0.9,
    avoidableIdleGapP95Ms: 40,
    duplicateIrreversibleActions: 0,
    wrongIrreversibleActions: 0,
    outOfEnvelopeContacts: 0,
    autonomousRecoveryRate: 0.93,
    disturbanceAxesCovered: [...DISTURBANCE_AXES],
  };
}
