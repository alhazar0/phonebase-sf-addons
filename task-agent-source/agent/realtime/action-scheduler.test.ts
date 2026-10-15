import assert from "node:assert/strict";
import test from "node:test";

import type { GeneralAgentDeviceClient } from "../general-agent-client";
import { RealtimeActionScheduler } from "./action-scheduler";
import type { RealtimeFrameHub } from "./frame-hub";
import { LatencyRecorder } from "./latency-recorder";

test("action scheduler emits ordered lifecycle events around a completed action", async () => {
  const events: string[] = [];
  const metrics = new LatencyRecorder();
  metrics.markDecisionEvidence("fixture-screen", { sequence: 9 });
  const scheduler = new RealtimeActionScheduler(
    client(async () => ({
      receipt: { id: "receipt-1", status: "completed", elapsedMs: 10 },
      elapsedMs: 12,
      response: {},
    })),
    frames(),
    metrics,
    undefined,
    {
      onStarted: (event) => events.push(`started:${event.executionId}:${event.action.type}`),
      onCompleted: (event) => events.push(`completed:${event.executionId}:${event.result.receipt.id}`),
      onFailed: () => events.push("failed"),
    },
  );
  await scheduler.tap({ x: 0.5, y: 0.25 }, "fixture-tap");
  assert.equal(events.length, 2);
  const executionId = events[0].split(":")[1];
  assert.match(executionId, /^action-/);
  assert.equal(events[0], `started:${executionId}:tap`);
  assert.equal(events[1], `completed:${executionId}:receipt-1`);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.byPhase.planning?.count, 1);
  assert.equal(snapshot.byPhase.action?.count, 1);
  assert.equal(snapshot.byPhase.physical_motion?.p95Ms, 10);
});

test("action scheduler reports physical failures to the lifecycle sink", async () => {
  const events: string[] = [];
  const scheduler = new RealtimeActionScheduler(
    client(async () => {
      throw new Error("arm rejected move");
    }),
    frames(),
    new LatencyRecorder(),
    undefined,
    {
      onStarted: () => events.push("started"),
      onCompleted: () => events.push("completed"),
      onFailed: (event) => events.push(`failed:${String(event.error)}`),
    },
  );
  await assert.rejects(
    () => scheduler.tap({ x: 0.5, y: 0.25 }, "fixture-tap"),
    /arm rejected move/,
  );
  assert.deepEqual(events, ["started", "failed:Error: arm rejected move"]);
});

function frames() {
  return {
    latestModelFrame: async () => ({
      bytes: Buffer.from("fixture"),
      mimeType: "image/jpeg" as const,
      width: 720,
      height: 1_560,
      sequence: 9,
      capturedAt: 1,
    }),
  } as unknown as RealtimeFrameHub;
}

function client(executeAction: GeneralAgentDeviceClient["executeAction"]) {
  return {
    executeAction,
  } as unknown as GeneralAgentDeviceClient;
}
