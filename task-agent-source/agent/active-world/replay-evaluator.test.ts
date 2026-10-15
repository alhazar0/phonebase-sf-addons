import assert from "node:assert/strict";
import test from "node:test";

import type { ActiveWorldTransition } from "./types";
import {
  evaluateSemanticWorldModel,
  splitTransitionsByRun,
} from "./replay-evaluator";

test("evaluates held-out success, next-screen and latency predictions", () => {
  const train = [1, 2, 3, 4].map((index) => transition(`train-${index}`, 100));
  const testTransitions = [
    transition("test-1", 100),
    transition("test-2", 110),
  ];
  const metrics = evaluateSemanticWorldModel(train, testTransitions);
  assert.equal(metrics.coverage, 1);
  assert.equal(metrics.successBrierScore, 0);
  assert.equal(metrics.successAccuracyAt50, 1);
  assert.equal(metrics.nextScreenTop1, 1);
  assert.equal(metrics.nextScreenTop3, 1);
  assert.equal(metrics.latencyMeanAbsoluteErrorMs, 5);
  assert.equal(metrics.criticAccuracy, 1);
  assert.equal(metrics.criticFalseRejectRate, 0);
});

test("keeps every run entirely in either train or holdout", () => {
  const transitions = [
    transition("run-a", 100, 1),
    transition("run-a", 100, 2),
    transition("run-b", 100, 3),
    transition("run-c", 100, 4),
    transition("run-d", 100, 5),
  ];
  const split = splitTransitionsByRun(transitions, 0.25);
  const trainRuns = new Set(split.train.map((value) => value.runId));
  const testRuns = new Set(split.test.map((value) => value.runId));
  assert.ok(split.train.length > 0);
  assert.ok(split.test.length > 0);
  for (const run of trainRuns) assert.equal(testRuns.has(run), false);
});

function transition(
  runId: string,
  latencyMs: number,
  suffix = 1,
): ActiveWorldTransition {
  const startedAt = 1_000 + suffix * 1_000;
  const before = {
    sequence: 10,
    capturedAt: startedAt - 30,
    observedAt: startedAt - 20,
    viewport: { width: 720, height: 1_560 },
    screenKind: "home_grid",
    sceneKind: "home_grid",
    screenConfidence: 0.96,
    sceneConfidence: 0.96,
    fingerprint: `home-${suffix}`,
    changeRatio: null,
    changeKind: "first" as const,
    keyboardVisible: false,
    averageTextConfidence: 0.95,
    ocrElapsedMs: 10,
    observationElapsedMs: 15,
    tokens: ["telegram", "gemini"],
    elements: [],
  };
  return {
    transitionId: `${runId}-${suffix}`,
    runId,
    deviceId: "fixture",
    action: {
      executionId: `action-${runId}-${suffix}`,
      label: "open app",
      action: {
        type: "tap",
        point: { x: 120, y: 220 },
        viewport: { width: 720, height: 1_560 },
        frameSequence: 10,
        durationMs: 60,
      },
      sensitiveTextRedacted: false,
      startedAt,
      beforeSequence: 10,
      completedAt: startedAt + 50,
      elapsedMs: 50,
      receiptId: `receipt-${suffix}`,
      status: "completed",
    },
    precondition: before,
    postcondition: {
      ...before,
      sequence: 11,
      capturedAt: startedAt + latencyMs - 10,
      observedAt: startedAt + latencyMs,
      screenKind: "text_ui",
      sceneKind: "text_ui",
      fingerprint: `app-${suffix}`,
      changeRatio: 0.2,
      changeKind: "major",
      tokens: ["chats", "search"],
    },
    verification: {
      freshFrame: true,
      visualChanged: true,
      semanticChanged: true,
      postSequenceDelta: 1,
      reason: "fresh-post-action-observation",
    },
  };
}
