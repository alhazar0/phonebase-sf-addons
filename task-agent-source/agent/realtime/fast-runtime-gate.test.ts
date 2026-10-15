import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFastRuntimeGate,
  fastRuntimeEvidenceFromResult,
} from "./fast-runtime-gate";

test("fast runtime gate accepts three accurate runs inside the wall-time budget", () => {
  const result = evaluateFastRuntimeGate([
    run("social", 28_000),
    run("search", 20_000),
    run("message", 30_000),
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.suiteMs, 78_000);
  assert.deepEqual(result.blockers, []);
});

test("fast runtime gate rejects recovery, long-tail perception and suite slowdown", () => {
  const result = evaluateFastRuntimeGate([
    { ...run("social", 40_000), recoveries: 1 },
    { ...run("search", 35_000), perceptionP95Ms: 450 },
    run("message", 30_000),
  ]);
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => /recoveries/.test(blocker)));
  assert.ok(result.blockers.some((blocker) => /perception/.test(blocker)));
  assert.ok(result.blockers.some((blocker) => /suite/.test(blocker)));
});

test("fast runtime gate fails closed when phase evidence is absent", () => {
  const incomplete = {
    ...run("incomplete", 10_000),
    timingComplete: false,
    missingTimingSegments: ["planning" as const, "phoneAnimation" as const],
    instrumentationCoverage: null,
  };
  const result = evaluateFastRuntimeGate([incomplete], { requiredRuns: 1 });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => /incomplete timing decomposition/.test(blocker)));
  assert.ok(result.blockers.some((blocker) => /timing coverage missing/.test(blocker)));
});

test("normalizes specialized and generic result metrics", () => {
  const specialized = fastRuntimeEvidenceFromResult({
    status: "completed",
    metrics: {
      totalMs: 12_000,
      byPhase: {
        perception: { p95Ms: 180 },
        action: { p95Ms: 1_400 },
      },
      timing: timingFixture({ perception: 180, physicalMotion: 1_400 }),
    },
    skill: { recoveries: 0 },
  }, "specialized");
  assert.equal(specialized.perceptionP95Ms, 180);
  assert.equal(specialized.actionP95Ms, 1_400);
  assert.equal(specialized.planningP95Ms, 12);
  assert.equal(specialized.timingComplete, true);

  const generic = fastRuntimeEvidenceFromResult({
    result: {
      status: "completed",
      metrics: {
        totalMs: 10_000,
        recoveries: 0,
        averageObservationMs: 90,
        averageModelMs: 900,
        actionReceiptMs: [500, 1_100, 700],
      },
    },
  }, "generic");
  assert.equal(generic.actionP95Ms, 1_100);
  assert.equal(generic.modelAverageMs, 900);
  assert.equal(generic.timingComplete, false);

  const universal = fastRuntimeEvidenceFromResult({
    status: "completed",
    metrics: {
      totalMs: 9_000,
      recoveries: 0,
      runtimeTiming: {
        byPhase: {},
        timing: timingFixture(),
      },
    },
  }, "universal");
  assert.equal(universal.timingComplete, true);
  assert.equal(universal.frameTransportP95Ms, 20);
  assert.equal(universal.planningP95Ms, 12);
});

function run(id: string, totalMs: number) {
  return {
    id,
    status: "completed",
    totalMs,
    recoveries: 0,
    frameTransportP95Ms: 20,
    perceptionP95Ms: 180,
    planningP95Ms: 12,
    actionP95Ms: 1_500,
    phoneAnimationP95Ms: 400,
    verificationP95Ms: 20,
    modelAverageMs: 1_200,
    instrumentationCoverage: 0.97,
    longestUnattributedGapMs: 20,
    timingComplete: true,
    missingTimingSegments: [],
  };
}

function timingFixture(overrides: Partial<Record<
  "frameTransport" | "perception" | "planning" | "physicalMotion" |
  "phoneAnimation" | "verification" | "recovery",
  number
>> = {}) {
  const values = {
    frameTransport: 20,
    perception: 180,
    planning: 12,
    physicalMotion: 1_500,
    phoneAnimation: 400,
    verification: 20,
    recovery: 0,
    ...overrides,
  };
  return {
    schemaVersion: "screenhand.runtime-timing.v1",
    segmentsMs: Object.fromEntries(Object.keys(values).map((segment) => [segment, 1])),
    segmentSamples: Object.fromEntries(Object.entries(values).map(([segment, p95Ms]) => [
      segment,
      { count: segment === "recovery" ? 0 : 1, p95Ms },
    ])),
    instrumentationCoverage: 0.97,
    longestUnattributedGapMs: 20,
  };
}
