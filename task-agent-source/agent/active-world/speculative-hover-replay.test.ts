import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSpeculativeHoverReplay,
  type SpeculativeHoverReplaySource,
} from "./speculative-hover-replay";
import {
  ACTIVE_WORLD_SCHEMA_VERSION,
  type ActiveWorldBeliefSnapshot,
  type ActiveWorldJournalRecord,
} from "./types";

test("qualifies accurate early Shadow predictions only for a reversible physical trial", () => {
  const sources = [
    replaySource("phone-a", 34, 220),
    replaySource("phone-b", 34, 210),
    replaySource("phone-c", 34, 200),
  ];
  const report = evaluateSpeculativeHoverReplay(sources);

  assert.equal(report.eligibleDecisions, 102);
  assert.equal(report.physicalDevices, 3);
  assert.equal(report.targetPrecision, 1);
  assert.equal(report.leadTimeMs.p50, 210);
  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.reversiblePhysicalTrialEligible, true);
  assert.equal(report.gate.wouldEnableHardware, false);
});

test("rejects correct predictions made too late to save physical latency", () => {
  const report = evaluateSpeculativeHoverReplay([
    replaySource("phone-a", 34, 1),
    replaySource("phone-b", 34, 1),
    replaySource("phone-c", 34, 1),
  ]);

  assert.equal(report.targetPrecision, 1);
  assert.equal(report.leadTimeMs.p50, 1);
  assert.equal(report.usefulDecisionRate, 0);
  assert.ok(report.gate.blockers.includes("lead_time_p50_ms"));
  assert.ok(report.gate.blockers.includes("useful_decision_rate"));
  assert.equal(report.gate.reversiblePhysicalTrialEligible, false);
});

test("treats wrong targets, unmatched actions, and malformed candidates as failures", () => {
  const sources = [
    replaySource("phone-a", 34, 200),
    replaySource("phone-b", 34, 200),
    replaySource("phone-c", 34, 200),
  ];
  alterActualPoint(sources[0], 0, 40);
  alterActualPoint(sources[0], 1, 40);
  alterActualPoint(sources[0], 2, 40);
  alterActualPoint(sources[0], 3, 40);
  alterActualPoint(sources[0], 4, 40);
  alterActualPoint(sources[0], 5, 40);
  alterActionLabel(sources[1], 0, "different action");
  invalidateCandidate(sources[2], 0);

  const report = evaluateSpeculativeHoverReplay(sources);
  assert.ok(report.targetPrecision < 0.99);
  assert.equal(report.targetErrorPixels.p95, 40);
  assert.equal(report.unmatchedDecisions, 1);
  assert.equal(report.invalidDecisions, 1);
  assert.ok(report.gate.blockers.includes("target_precision"));
  assert.ok(report.gate.blockers.includes("target_error_p95_pixels"));
  assert.ok(report.gate.blockers.includes("unmatched_decisions"));
  assert.ok(report.gate.blockers.includes("invalid_decisions"));
});

test("development evidence cannot authorize a physical trial", () => {
  const sources = [
    replaySource("phone-a", 34, 200),
    replaySource("phone-b", 34, 200),
    replaySource("phone-c", 34, 200),
  ];
  sources[0].split = "development";
  sources[0].usedForTuning = true;
  const report = evaluateSpeculativeHoverReplay(sources);

  assert.equal(report.allEvidenceHeldOut, false);
  assert.deepEqual(report.gate.blockers, ["held_out_evidence"]);
});

test("rejects duplicate run identity and contaminated holdout sources", () => {
  const first = replaySource("phone-a", 34, 200);
  const duplicate = replaySource("phone-b", 34, 200);
  duplicate.sourceId = "another-source";
  duplicate.records = structuredClone(first.records);
  assert.throws(
    () => evaluateSpeculativeHoverReplay([first, duplicate]),
    /Duplicate replay runId/u,
  );

  const contaminated = replaySource("phone-a", 100, 200);
  contaminated.usedForTuning = true;
  assert.throws(
    () => evaluateSpeculativeHoverReplay([contaminated]),
    /cannot be used for tuning/u,
  );
});

function replaySource(
  physicalDeviceKey: string,
  count: number,
  leadTimeMs: number,
): SpeculativeHoverReplaySource {
  const runId = `run-${physicalDeviceKey}`;
  const records: ActiveWorldJournalRecord[] = [];
  const add = (event: ActiveWorldJournalRecord["event"], recordedAt: number) => {
    records.push({
      schemaVersion: ACTIVE_WORLD_SCHEMA_VERSION,
      sequence: records.length + 1,
      recordedAt,
      event,
    });
  };
  add({
    type: "run_started",
    runId,
    deviceId: `station-${physicalDeviceKey}`,
    goal: "fixture",
    mode: "execute",
    startedAt: 1_000,
  }, 1_000);
  for (let index = 0; index < count; index += 1) {
    const evaluatedAt = 2_000 + index * 1_000;
    const label = `tap-${index}`;
    add({
      type: "speculative_hover",
      runId,
      decision: {
        mode: "shadow",
        evaluatedAt,
        label,
        actionType: "tap",
        eligible: true,
        wouldMoveHardware: false,
        reason: "eligible-shadow-only",
        planConfidence: 0.98,
        beliefRevision: index + 1,
        beliefUncertainty: 0.1,
        beliefSequence: index + 10,
        actionFrameSequence: index + 10,
        frameLag: 0,
        candidate: {
          point: { x: 360, y: 780 },
          normalizedPoint: { x: 0.5, y: 0.5 },
          viewport: { width: 720, height: 1_560 },
          frameSequence: index + 10,
        },
      },
    }, evaluatedAt);
    add({
      type: "action_started",
      runId,
      action: {
        executionId: `action-${physicalDeviceKey}-${index}`,
        label,
        action: {
          type: "tap",
          point: { x: 360, y: 780 },
          viewport: { width: 720, height: 1_560 },
          frameSequence: index + 10,
        },
        sensitiveTextRedacted: false,
        startedAt: evaluatedAt + leadTimeMs,
        beforeSequence: index + 10,
        status: "executing",
      },
    }, evaluatedAt + leadTimeMs);
  }
  add({
    type: "run_finished",
    runId,
    status: "completed",
    completedAt: 100_000,
    belief: belief(),
  }, 100_000);
  return {
    sourceId: `source-${physicalDeviceKey}`,
    physicalDeviceKey,
    split: "holdout",
    usedForTuning: false,
    records,
  };
}

function decisionAndAction(source: SpeculativeHoverReplaySource, index: number) {
  const decisions = source.records.filter((record) =>
    record.event.type === "speculative_hover"
  );
  const decision = decisions[index];
  const action = source.records[decision.sequence];
  assert.equal(decision.event.type, "speculative_hover");
  assert.equal(action.event.type, "action_started");
  return { decision, action };
}

function alterActualPoint(source: SpeculativeHoverReplaySource, index: number, offsetX: number) {
  const { action } = decisionAndAction(source, index);
  if (action.event.type === "action_started" && action.event.action.action.type === "tap") {
    action.event.action.action.point.x += offsetX;
  }
}

function alterActionLabel(source: SpeculativeHoverReplaySource, index: number, label: string) {
  const { action } = decisionAndAction(source, index);
  if (action.event.type === "action_started") action.event.action.label = label;
}

function invalidateCandidate(source: SpeculativeHoverReplaySource, index: number) {
  const { decision } = decisionAndAction(source, index);
  if (decision.event.type === "speculative_hover" && decision.event.decision.candidate) {
    decision.event.decision.candidate.normalizedPoint.x = 0.8;
  }
}

function belief(): ActiveWorldBeliefSnapshot {
  return {
    revision: 1,
    observationCount: 0,
    updatedAt: 100_000,
    viewport: { width: 720, height: 1_560 },
    screen: null,
    motion: null,
    keyboardVisible: false,
    uncertainty: 1,
    elements: [],
    lastAction: null,
  };
}
