import assert from "node:assert/strict";
import test from "node:test";

import {
  decomposeRuntimeTiming,
  LatencyRecorder,
  summarizeRuntimeTimeline,
} from "./latency-recorder";

test("runtime timeline unions overlapping work instead of double-counting it", () => {
  const summary = summarizeRuntimeTimeline([
    { phase: "action", label: "move", startedAt: 10, durationMs: 100 },
    { phase: "perception", label: "ocr", startedAt: 40, durationMs: 100 },
    { phase: "verification", label: "change", startedAt: 180, durationMs: 20 },
  ], 250);
  assert.deepEqual(summary, {
    measuredActiveMs: 150,
    measuredIdleMs: 100,
    longestIdleGapMs: 50,
    idleGapsOver50Ms: 0,
  });
});

test("runtime timeline exposes uninstrumented long idle gaps", () => {
  const summary = summarizeRuntimeTimeline([
    { phase: "perception", label: "initial", startedAt: -10, durationMs: 30 },
    { phase: "action", label: "tap", startedAt: 120, durationMs: 30 },
  ], 200);
  assert.equal(summary.measuredActiveMs, 50);
  assert.equal(summary.measuredIdleMs, 150);
  assert.equal(summary.longestIdleGapMs, 100);
  assert.equal(summary.idleGapsOver50Ms, 1);
});

test("sample-only transport measurements do not pretend to cover wall-clock gaps", () => {
  const records = [
    {
      phase: "frame_transport",
      label: "camera-to-runtime",
      startedAt: 100,
      durationMs: 80,
      kind: "sample" as const,
    },
    { phase: "perception", label: "screen", startedAt: 120, durationMs: 30 },
  ];
  assert.deepEqual(summarizeRuntimeTimeline(records, 200), {
    measuredActiveMs: 30,
    measuredIdleMs: 170,
    longestIdleGapMs: 120,
    idleGapsOver50Ms: 1,
  });
  const timing = decomposeRuntimeTiming(records, 200);
  assert.equal(timing.segmentSamples.frameTransport.p95Ms, 80);
  assert.equal(timing.segmentsMs.frameTransport, 0);
});

test("decomposes overlapping animation, perception and verification without hiding idle time", () => {
  const timing = decomposeRuntimeTiming([
    { phase: "planning", label: "decision", startedAt: 0, durationMs: 20 },
    { phase: "action", label: "tap", startedAt: 20, durationMs: 80 },
    { phase: "phone_animation", label: "wait", startedAt: 100, durationMs: 100 },
    { phase: "perception", label: "classify", startedAt: 140, durationMs: 30 },
    { phase: "verification", label: "predicate", startedAt: 170, durationMs: 10 },
    { phase: "intentional_wait", label: "requested-dwell", startedAt: 220, durationMs: 30 },
  ], 300);
  assert.deepEqual(timing.segmentsMs, {
    frameTransport: 0,
    perception: 30,
    planning: 20,
    physicalMotion: 80,
    phoneAnimation: 100,
    verification: 10,
    recovery: 0,
  });
  assert.equal(timing.categorizedTimelineMs, 200);
  assert.equal(timing.intentionalWaitMs, 30);
  assert.equal(timing.unattributedMs, 70);
  assert.equal(timing.longestUnattributedGapMs, 50);
  assert.equal(timing.unattributedGapsOver50Ms, 0);
});

test("records the decision interval from fresh evidence to an action", () => {
  let now = 1_000;
  const recorder = new LatencyRecorder(() => now);
  now += 5;
  recorder.markDecisionEvidence("screen", { sequence: 7 });
  now += 12;
  assert.equal(recorder.recordDecision("tap-search"), 12);
  now += 3;
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.byPhase.planning?.p95Ms, 12);
  assert.equal(snapshot.timing.segmentSamples.planning.count, 1);
});

test("ingests nested runtime spans on the parent wall-clock without losing samples", () => {
  let now = 100;
  const parent = new LatencyRecorder(() => now);
  now = 120;
  parent.ingest({ records: [
    { phase: "perception", label: "observe", startedAt: 5, durationMs: 20 },
    {
      phase: "frame_transport",
      label: "camera-age",
      startedAt: 5,
      durationMs: 12,
      kind: "sample",
    },
  ] }, 110, "step-1");
  now = 150;
  const snapshot = parent.snapshot();
  assert.equal(snapshot.timing.segmentsMs.perception, 20);
  assert.equal(snapshot.timing.segmentSamples.frameTransport.p95Ms, 12);
  assert.equal(snapshot.records[0]?.startedAt, 15);
  assert.equal(snapshot.records[0]?.label, "step-1:observe");
});
