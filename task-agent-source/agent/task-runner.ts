import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseAgentRunRequest, type AgentRunResult } from "./general-agent-contract";
import type { SemanticTargetPrediction } from "./active-world/semantic-world-model";
import type { TaskProgram, TaskStep } from "./task-ir";
import { LatencyRecorder } from "./realtime/latency-recorder";

export type TaskStepAgent = {
  run(request: ReturnType<typeof parseAgentRunRequest>): Promise<AgentRunResult>;
};

export type TaskStepCheckpoint = {
  stepId: string;
  status: "pending" | "running" | "completed" | "blocked" | "uncertain";
  attempts: number;
  startedAt: number | null;
  completedAt: number | null;
  reason: string;
};

export type UniversalTaskResult = {
  runId: string;
  status: "planned" | "completed" | "blocked" | "failed" | "timed_out";
  reason: string;
  goal: string;
  mode: "dry_run" | "execute";
  program: TaskProgram;
  startedAt: number;
  completedAt: number;
  checkpointPath: string | null;
  steps: TaskStepCheckpoint[];
  subruns: AgentRunResult[];
  evidence: Array<{
    stepId: string;
    sequence: number;
    scene: string;
    visibleText: string[];
  }>;
  lookahead: TaskLookaheadRecord[];
  metrics: {
    totalMs: number;
    compileMs: number;
    executionMs: number;
    modelRuns: number;
    actions: number;
    observations: number;
    recoveries: number;
    runtimeTiming: ReturnType<LatencyRecorder["snapshot"]>;
  };
};

export type TaskLookaheadRecord = {
  fromStepId: string;
  toStepId: string;
  objective: string;
  prediction: SemanticTargetPrediction;
  settlement: {
    status: "matched" | "action-mismatch" | "not-executed";
    actionStartedAt: number | null;
    leadTimeMs: number | null;
    targetErrorPixels: number | null;
  } | null;
  wouldMoveHardware: false;
};

export type TaskLookaheadPredictor = {
  predictTarget(input: {
    deviceId: string;
    screenKind: string;
    tokens: string[];
    label: string;
    viewport: { width: number; height: number };
    sideEffect: TaskStep["sideEffect"];
    evaluatedAt?: number;
  }): SemanticTargetPrediction;
};

export type UniversalTaskAgentOptions = {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  lookaheadPredictor?: TaskLookaheadPredictor;
};

/**
 * Executes a provider-neutral Task IR. The whole task is already compiled, so
 * the visual agent receives only the current atomic objective. Known
 * primitives stay local; unfamiliar objectives retain the existing visual
 * planner as a bounded slow path.
 */
export class UniversalTaskAgent {
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly lookaheadPredictor: TaskLookaheadPredictor | null;

  constructor(
    private readonly stepAgent: TaskStepAgent,
    options: UniversalTaskAgentOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.lookaheadPredictor = options.lookaheadPredictor ?? null;
  }

  async run(program: TaskProgram, options: {
    deviceId: string;
    mode: "dry_run" | "execute";
    timeoutMs: number;
    artifactDirectory?: string;
  }): Promise<UniversalTaskResult> {
    const runId = `task-run-${randomUUID()}`;
    const startedAt = this.now();
    const latency = new LatencyRecorder(this.now);
    latency.recordSample("planning", "compile-task-ir", program.compiler.elapsedMs, {
      strategy: program.compiler.strategy,
      cacheHit: program.compiler.cacheHit,
      steps: program.steps.length,
    });
    const deadline = startedAt + options.timeoutMs;
    const checkpoints = program.steps.map((step): TaskStepCheckpoint => ({
      stepId: step.id,
      status: "pending",
      attempts: 0,
      startedAt: null,
      completedAt: null,
      reason: "",
    }));
    const subruns: AgentRunResult[] = [];
    const evidence: UniversalTaskResult["evidence"] = [];
    const lookahead: TaskLookaheadRecord[] = [];
    const checkpointPath = options.mode === "execute"
      ? resolve(
          options.artifactDirectory ?? "build/runtime/task-programs",
          `${program.id}-${runId}.checkpoint.json`,
        )
      : null;

    const finish = (
      status: UniversalTaskResult["status"],
      reason: string,
    ): UniversalTaskResult => {
      const completedAt = this.now();
      const runtimeTiming = latency.snapshot();
      return {
        runId,
        status,
        reason,
        goal: program.goal,
        mode: options.mode,
        program,
        startedAt,
        completedAt,
        checkpointPath,
        steps: checkpoints,
        subruns,
        evidence,
        lookahead,
        metrics: {
          totalMs: Math.max(0, completedAt - startedAt) + program.compiler.elapsedMs,
          compileMs: program.compiler.elapsedMs,
          executionMs: Math.max(0, completedAt - startedAt),
          modelRuns: subruns.reduce((total, run) => total + run.metrics.modelRuns, 0),
          actions: subruns.reduce((total, run) => total + run.metrics.actions, 0),
          observations: subruns.reduce((total, run) => total + run.metrics.observations, 0),
          recoveries: subruns.reduce((total, run) => total + run.metrics.recoveries, 0),
          runtimeTiming,
        },
      };
    };

    if (options.mode === "dry_run") {
      return finish("planned", `Compiled ${program.steps.length} ordered Task IR steps without moving hardware.`);
    }
    await latency.measure(
      "runtime",
      "save-initial-checkpoint",
      () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "running"),
    );

    for (let index = 0; index < program.steps.length; index += 1) {
      const step = program.steps[index];
      const checkpoint = checkpoints[index];
      if (this.now() >= deadline) {
        checkpoint.status = "blocked";
        checkpoint.reason = "The task deadline expired before this step started.";
        await latency.measure(
          "runtime",
          "save-timeout-checkpoint",
          () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "timed_out"),
        );
        return finish("timed_out", checkpoint.reason);
      }
      if (
        program.accessMode === "read_only" &&
        (step.sideEffect === "external" || step.sideEffect === "destructive")
      ) {
        checkpoint.status = "blocked";
        checkpoint.reason = `Read-only execution blocked ${step.sideEffect} step: ${step.objective}`;
        await latency.measure(
          "runtime",
          "save-policy-blocked-checkpoint",
          () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "blocked"),
        );
        return finish("blocked", checkpoint.reason);
      }

      checkpoint.status = "running";
      checkpoint.startedAt = this.now();
      await latency.measure(
        "runtime",
        "save-step-start-checkpoint",
        () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "running"),
        { stepId: step.id },
      );
      if (step.operation === "wait") {
        const waitMs = Math.min(
          step.durationMs ?? 0,
          Math.max(0, deadline - this.now()),
        );
        await latency.measure(
          "intentional_wait",
          "task-requested-wait",
          () => this.delay(waitMs),
          { stepId: step.id, waitMs },
        );
        checkpoint.status = "completed";
        checkpoint.completedAt = this.now();
        checkpoint.reason = `Waited ${step.durationMs ?? 0} ms.`;
        await latency.measure(
          "runtime",
          "save-wait-checkpoint",
          () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "running"),
          { stepId: step.id },
        );
        continue;
      }
      if (step.operation === "report") {
        checkpoint.status = "completed";
        checkpoint.completedAt = this.now();
        checkpoint.reason = "The report checkpoint retained all previously collected visual evidence.";
        await latency.measure(
          "runtime",
          "save-report-checkpoint",
          () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "running"),
          { stepId: step.id },
        );
        continue;
      }

      const repetitions = repeatCount(step);
      let stepCompleted = true;
      let lastCompletedResult: AgentRunResult | null = null;
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        let repetitionCompleted = false;
        for (let attempt = 1; attempt <= step.maximumAttempts; attempt += 1) {
          checkpoint.attempts += 1;
          const remainingMs = deadline - this.now();
          if (remainingMs < 2_000) {
            checkpoint.reason = "The task deadline expired during this step.";
            stepCompleted = false;
            break;
          }
          const executionGoal = executionGoalForStep(step, repetition, repetitions);
          const subrunStartedAt = this.now();
          const result = await latency.measure(
            "runtime",
            "step-agent-run",
            () => this.stepAgent.run(parseAgentRunRequest({
              deviceId: options.deviceId,
              goal: executionGoal,
              mode: "execute",
              maxSteps: 20,
              timeoutMs: Math.min(180_000, Math.max(2_000, remainingMs)),
            })),
            { stepId: step.id, attempt, repetition: repetition + 1 },
          );
          if (result.metrics.runtimeTiming) {
            latency.ingest(
              result.metrics.runtimeTiming,
              subrunStartedAt,
              `${step.id}:attempt-${attempt}`,
            );
          }
          subruns.push(result);
          const pendingLookahead = lookahead.find((record) =>
            record.toStepId === step.id &&
            record.prediction.eligible &&
            record.settlement === null
          );
          if (pendingLookahead) settleLookahead(pendingLookahead, result);
          if (result.lastObservation) {
            evidence.push({
              stepId: step.id,
              sequence: result.lastObservation.sequence,
              scene: result.lastObservation.scene.kind,
              visibleText: result.lastObservation.elements
                .filter((element) => element.confidence >= 0.35)
                .slice(0, 50)
                .map((element) => element.text),
            });
          }
          if (result.status === "completed") {
            repetitionCompleted = true;
            lastCompletedResult = result;
            checkpoint.reason = result.reason;
            break;
          }
          checkpoint.reason = result.reason;
          if (step.sideEffect === "external" || step.sideEffect === "destructive") break;
        }
        if (!repetitionCompleted) {
          stepCompleted = false;
          break;
        }
      }
      if (!stepCompleted) {
        checkpoint.status = step.sideEffect === "external" || step.sideEffect === "destructive"
          ? "uncertain"
          : "blocked";
        checkpoint.completedAt = this.now();
        await latency.measure(
          "runtime",
          "save-step-blocked-checkpoint",
          () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "blocked"),
          { stepId: step.id },
        );
        const uncertainty = checkpoint.status === "uncertain"
          ? " The step is not automatically retried because its external effect may already exist."
          : "";
        return finish("blocked", `${checkpoint.reason}${uncertainty}`);
      }
      checkpoint.status = "completed";
      checkpoint.completedAt = this.now();
      await latency.measure(
        "runtime",
        "save-step-complete-checkpoint",
        () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "running"),
        { stepId: step.id },
      );
      const nextStep = program.steps[index + 1];
      const observation = lastCompletedResult?.lastObservation;
      if (this.lookaheadPredictor && nextStep && observation) {
        const evaluatedAt = this.now();
        const prediction = latency.measureSync(
          "planning",
          "predict-next-step-target",
          () => this.lookaheadPredictor!.predictTarget({
            deviceId: options.deviceId,
            screenKind: observation.scene.kind,
            tokens: observation.elements
              .filter((element) => element.confidence >= 0.35)
              .map((element) => normalizeToken(element.text))
              .filter(Boolean),
            label: executionGoalForStep(nextStep),
            viewport: observation.viewport,
            sideEffect: nextStep.sideEffect,
            evaluatedAt,
          }),
          { fromStepId: step.id, toStepId: nextStep.id },
        );
        lookahead.push({
          fromStepId: step.id,
          toStepId: nextStep.id,
          objective: nextStep.objective,
          prediction,
          settlement: null,
          wouldMoveHardware: false,
        });
      }
    }
    await latency.measure(
      "runtime",
      "save-completed-checkpoint",
      () => this.saveCheckpoint(checkpointPath!, runId, program, checkpoints, "completed"),
    );
    return finish("completed", `Completed and checkpointed all ${program.steps.length} Task IR steps.`);
  }

  private async saveCheckpoint(
    path: string,
    runId: string,
    program: TaskProgram,
    steps: TaskStepCheckpoint[],
    status: "running" | "completed" | "blocked" | "timed_out",
  ) {
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({
      version: program.version,
      runId,
      taskId: program.id,
      goal: program.goal,
      status,
      updatedAt: this.now(),
      program,
      steps,
    }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }
}

function settleLookahead(record: TaskLookaheadRecord, result: AgentRunResult) {
  const event = result.events.find((candidate) =>
    candidate.phase === "act" && isSemanticAction(candidate.data?.action)
  );
  if (!event || !record.prediction.candidate) {
    record.settlement = {
      status: "not-executed",
      actionStartedAt: null,
      leadTimeMs: null,
      targetErrorPixels: null,
    };
    return;
  }
  const action = event.data!.action as Record<string, unknown>;
  if (action.type !== "tap") {
    record.settlement = {
      status: "action-mismatch",
      actionStartedAt: event.at,
      leadTimeMs: Math.max(0, event.at - record.prediction.evaluatedAt),
      targetErrorPixels: null,
    };
    return;
  }
  const point = action.point as { x: number; y: number };
  const viewport = action.viewport as { width: number; height: number };
  const normalized = { x: point.x / viewport.width, y: point.y / viewport.height };
  const predicted = record.prediction.candidate;
  const error = Math.hypot(
    (predicted.normalizedPoint.x - normalized.x) * predicted.viewport.width,
    (predicted.normalizedPoint.y - normalized.y) * predicted.viewport.height,
  );
  record.settlement = {
    status: error <= 8 ? "matched" : "action-mismatch",
    actionStartedAt: event.at,
    leadTimeMs: Math.max(0, event.at - record.prediction.evaluatedAt),
    targetErrorPixels: rounded(error),
  };
}

function isSemanticAction(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.type !== "string") return false;
  if (action.type !== "tap") return true;
  const point = action.point as Record<string, unknown> | undefined;
  const viewport = action.viewport as Record<string, unknown> | undefined;
  return Boolean(
    point && viewport &&
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Number.isFinite(viewport.width) && Number(viewport.width) > 0 &&
    Number.isFinite(viewport.height) && Number(viewport.height) > 0,
  );
}

function normalizeToken(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

export function executionGoalForStep(
  step: TaskStep,
  repetition = 0,
  repetitions = repeatCount(step),
) {
  const suffix = repetitions > 1 ? ` (${repetition + 1} of ${repetitions})` : "";
  if (step.operation === "open_app") return `Open ${step.app}`;
  if (step.operation === "navigate") {
    return step.target === "home" ? "Go home"
      : step.target === "back" ? "Go back"
      : "Press enter";
  }
  if (step.operation === "tap") return `Tap "${step.target}"${suffix}`;
  if (step.operation === "input_text" && step.target) {
    return `Type "${step.text}" into the "${step.target}" field`;
  }
  if (step.operation === "swipe") {
    return step.direction === "left" || step.direction === "right"
      ? `Swipe ${step.direction}${suffix}`
      : `Scroll ${step.direction}${suffix}`;
  }
  return step.objective;
}

function repeatCount(step: TaskStep) {
  return step.sideEffect === "none" || step.sideEffect === "reversible"
    ? (step.operation === "swipe" || step.operation === "tap" ? step.count : 1)
    : 1;
}
