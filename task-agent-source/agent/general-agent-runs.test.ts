import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunRequest, AgentRunResult } from "./general-agent-contract";
import {
  GeneralAgentRunConflictError,
  GeneralAgentRunRegistry,
} from "./general-agent-runs";

test("serializes agent ownership per physical device", async () => {
  let finish!: (result: AgentRunResult) => void;
  const registry = new GeneralAgentRunRegistry(
    async () => new Promise<AgentRunResult>((resolve) => { finish = resolve; }),
  );
  const request = fixtureRequest();
  const first = registry.submit(request);
  assert.equal(first.status, "running");
  assert.throws(() => registry.submit(request), GeneralAgentRunConflictError);
  await new Promise((resolve) => setImmediate(resolve));
  finish(fixtureResult(request));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get(first.id)?.status, "finished");
  assert.equal(registry.get(first.id)?.result?.status, "planned");
});

function fixtureRequest(): AgentRunRequest {
  return {
    deviceId: "black-arm-01",
    goal: "返回首页",
    mode: "dry_run",
    maxSteps: 4,
    timeoutMs: 5_000,
  };
}

function fixtureResult(request: AgentRunRequest): AgentRunResult {
  return {
    protocolVersion: "2026-08-31",
    runId: "agent-test",
    request,
    intent: { type: "navigate", key: "home" },
    status: "planned",
    reason: "test",
    steps: 1,
    startedAt: 1,
    completedAt: 2,
    metrics: {
      totalMs: 1,
      observations: 1,
      ocrRuns: 1,
      ocrCacheHits: 0,
      actions: 0,
      recoveries: 0,
      averageObservationMs: 1,
      averageOcrMs: 1,
      actionReceiptMs: [],
    },
    events: [],
  };
}
