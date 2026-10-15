import { randomUUID } from "node:crypto";

import type { AgentRunRequest, AgentRunResult } from "./general-agent-contract";

export type StoredAgentRun = {
  id: string;
  deviceId: string;
  status: "running" | "finished";
  createdAt: number;
  updatedAt: number;
  request: AgentRunRequest;
  result: AgentRunResult | null;
};

export class GeneralAgentRunConflictError extends Error {
  readonly code = "AGENT_RUN_ACTIVE";
}

export class GeneralAgentRunRegistry {
  private readonly runs = new Map<string, StoredAgentRun>();

  constructor(
    private readonly execute: (request: AgentRunRequest) => Promise<AgentRunResult>,
    private readonly maximumRuns = 50,
  ) {}

  submit(request: AgentRunRequest) {
    const active = this.activeFor(request.deviceId);
    if (active) {
      throw new GeneralAgentRunConflictError(
        `Agent run ${active.id} is already controlling ${request.deviceId}.`,
      );
    }
    const now = Date.now();
    const run: StoredAgentRun = {
      id: `run-${randomUUID()}`,
      deviceId: request.deviceId,
      status: "running",
      createdAt: now,
      updatedAt: now,
      request,
      result: null,
    };
    this.runs.set(run.id, run);
    this.prune();
    void Promise.resolve()
      .then(() => this.execute(request))
      .then((result) => {
        run.status = "finished";
        run.updatedAt = Date.now();
        run.result = result;
        this.prune();
      })
      .catch((error) => {
        const completedAt = Date.now();
        run.status = "finished";
        run.updatedAt = completedAt;
        run.result = {
          protocolVersion: "2026-08-31",
          runId: run.id,
          request,
          intent: { type: "unknown", reason: "Agent runner failed before intent parsing." },
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
          steps: 0,
          startedAt: run.createdAt,
          completedAt,
          metrics: {
            totalMs: completedAt - run.createdAt,
            observations: 0,
            ocrRuns: 0,
            ocrCacheHits: 0,
            actions: 0,
            recoveries: 0,
            averageObservationMs: 0,
            averageOcrMs: 0,
            modelRuns: 0,
            averageModelMs: 0,
            actionReceiptMs: [],
          },
          events: [],
        };
        this.prune();
      });
    return snapshot(run);
  }

  get(runId: string, deviceId?: string) {
    const run = this.runs.get(runId);
    if (!run || (deviceId && run.deviceId !== deviceId)) return null;
    return snapshot(run);
  }

  list(deviceId: string) {
    return [...this.runs.values()]
      .filter((run) => run.deviceId === deviceId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(snapshot);
  }

  activeFor(deviceId: string) {
    return [...this.runs.values()].find(
      (run) => run.deviceId === deviceId && run.status === "running",
    ) ?? null;
  }

  private prune() {
    const finished = [...this.runs.values()]
      .filter((run) => run.status === "finished")
      .sort((left, right) => right.updatedAt - left.updatedAt);
    for (const run of finished.slice(this.maximumRuns)) this.runs.delete(run.id);
  }
}

function snapshot(run: StoredAgentRun): StoredAgentRun {
  return {
    ...run,
    request: { ...run.request },
    result: run.result ? { ...run.result, events: [...run.result.events] } : null,
  };
}
