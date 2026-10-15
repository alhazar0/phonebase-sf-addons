import assert from "node:assert/strict";
import test from "node:test";

import { DISTURBANCE_AXES } from "./curriculum";
import {
  evaluatePhysicalMobileWorld,
  physicalWorldReportToPromotionEvidence,
  type PhysicalMobileWorldRun,
} from "./physical-mobile-world";
import { evaluatePromotionGate } from "./promotion-gate";

test("certifies a complete 500-run camera-only production suite", () => {
  const runs = Array.from({ length: 500 }, (_, index) => fixtureRun(index));
  const report = evaluatePhysicalMobileWorld(runs, [{
    sessionId: "soak-8h",
    durationMs: 8 * 60 * 60 * 1_000,
    humanInterventions: 0,
    taskStateLosses: 0,
    calibrationBoundaryLosses: 0,
  }]);
  assert.equal(report.certifiedRuns, 500);
  assert.equal(report.certifiedSuccessRate, 1);
  assert.equal(report.autonomousRecoveryRate, 1);
  assert.equal(report.cameraReconnectSuccessRate, 1);
  assert.equal(report.longestPassingSoakHours, 8);
  assert.deepEqual(report.coverage.disturbanceAxes, [...DISTURBANCE_AXES]);
  const evidence = physicalWorldReportToPromotionEvidence({
    report,
    stage: "controlled_side_effect",
    passedStages: ["simulator", "replay", "reversible_physical"],
    baselineSuccessRate: 0.96,
    baselineTaskDurationP50Ms: 1_000,
  });
  assert.equal(evidence.taskDurationRatioToBaseline, 0.9);
  assert.equal(evaluatePromotionGate(evidence).passed, true);
});

test("reports timing percentiles without averaging away long-tail latency", () => {
  const report = evaluatePhysicalMobileWorld([
    fixtureRun(1, 100),
    fixtureRun(2, 200),
    fixtureRun(3, 1_000),
  ]);
  assert.equal(report.taskDurationMs.p50, 200);
  assert.equal(report.taskDurationMs.p95, 1_000);
  assert.equal(report.taskDurationMs.maximum, 1_000);
  assert.equal(report.timingSegmentsMs.planning.count, 3);
});

test("does not certify an assisted run or an unverified controlled side effect", () => {
  const run = fixtureRun(1);
  run.executionContract.cameraOnly = false;
  run.executionContract.usedAdb = true;
  run.outcome.sideEffectReceiptVerified = false;
  const report = evaluatePhysicalMobileWorld([run]);
  assert.equal(report.certifiedRuns, 0);
  assert.deepEqual(report.runs[0]?.failures, [
    "camera_only_contract_violated",
    "side_effect_receipt_unverified",
  ]);
});

test("missing recovery trials remain null and fail the promotion gate", () => {
  const runs = Array.from({ length: 500 }, (_, index) => {
    const run = fixtureRun(index);
    run.recovery = { opportunities: 0, successes: 0 };
    return run;
  });
  const report = evaluatePhysicalMobileWorld(runs, [{
    sessionId: "soak",
    durationMs: 8 * 60 * 60 * 1_000,
    humanInterventions: 0,
    taskStateLosses: 0,
    calibrationBoundaryLosses: 0,
  }]);
  assert.equal(report.autonomousRecoveryRate, null);
  const evidence = physicalWorldReportToPromotionEvidence({
    report,
    stage: "controlled_side_effect",
    passedStages: ["simulator", "replay", "reversible_physical"],
    baselineSuccessRate: 0.95,
    baselineTaskDurationP50Ms: 1_000,
  });
  assert.ok(evaluatePromotionGate(evidence).blockers.includes("autonomous_recovery_rate"));
});

test("rejects duplicated IDs and invalid cryptographic evidence", () => {
  const run = fixtureRun(1);
  assert.throws(
    () => evaluatePhysicalMobileWorld([run, structuredClone(run)]),
    /Duplicate benchmark runId/,
  );
  const invalid = fixtureRun(2);
  invalid.evidence.finalFrameSha256 = "not-a-hash";
  assert.throws(
    () => evaluatePhysicalMobileWorld([invalid]),
    /requires SHA-256/,
  );
});

function fixtureRun(index: number, durationMs = 900): PhysicalMobileWorldRun {
  const startedAt = 1_000_000 + index * 2_000;
  return {
    schemaVersion: "screenhand.physical-mobile-world.v1",
    suiteId: "held-out-production-v1",
    runId: `run-${index}`,
    scenarioId: `scenario-${index}`,
    seed: `seed-${index}`,
    startedAt,
    completedAt: startedAt + durationMs,
    heldOut: { device: true, application: true, wording: true },
    device: {
      family: index % 2 ? "held-out-ios" : "held-out-android",
      platform: index % 2 ? "ios" : "android",
      aspectRatioClass: index % 3 ? "tall" : "standard",
      placementClass: index % 2 ? "offset-left" : "offset-right",
    },
    environment: {
      language: index % 2 ? "zh-CN" : "en-US",
      theme: index % 2 ? "dark" : "light",
      applicationFamily: `unseen-app-${index % 5}`,
      disturbances: [...DISTURBANCE_AXES],
    },
    task: {
      family: "long_horizon",
      goalHash: "b".repeat(64),
      sideEffectClass: "controlled",
    },
    executionContract: {
      cameraOnly: true,
      usedAdb: false,
      usedAccessibilityTree: false,
      usedPlatformApi: false,
      usedPerAppRoute: false,
    },
    outcome: {
      status: "passed",
      terminalStateVisuallyVerified: true,
      humanInterventions: 0,
      duplicateIrreversibleActions: 0,
      wrongIrreversibleActions: 0,
      outOfEnvelopeContacts: 0,
      sideEffectReceiptVerified: true,
    },
    recovery: { opportunities: 1, successes: 1 },
    reconnect: { attempts: 1, successes: 1 },
    timing: {
      avoidableIdleGapP95Ms: 10,
      segmentsMs: {
        frameTransport: 20,
        perception: 30,
        planning: 10,
        physicalMotion: 200,
        phoneAnimation: 300,
        verification: 30,
        recovery: 0,
      },
    },
    targetCenterErrorsPixels: [2, 3],
    evidence: {
      journalSha256: "a".repeat(64),
      finalFrameSha256: "c".repeat(64),
    },
  };
}
