import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRunResult } from "./general-agent-contract";
import { buildTaskProgram, segmentTaskGoal } from "./task-ir";
import { executionGoalForStep, UniversalTaskAgent } from "./task-runner";

test("dry run returns the whole Task IR without invoking perception or hardware", async () => {
  let calls = 0;
  const program = simpleProgram("打开 Telegram，然后返回手机首页");
  const runner = new UniversalTaskAgent({
    run: async () => {
      calls += 1;
      throw new Error("must not execute");
    },
  });
  const result = await runner.run(program, {
    deviceId: "black-arm-01",
    mode: "dry_run",
    timeoutMs: 20_000,
  });
  assert.equal(result.status, "planned");
  assert.equal(result.program.steps.length, 2);
  assert.equal(calls, 0);
});

test("executes local steps in order and writes a 0600 completion checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-task-runner-"));
  const goals: string[] = [];
  const program = simpleProgram("打开 Telegram，然后返回手机首页");
  const runner = new UniversalTaskAgent({
    run: async (request) => {
      goals.push(request.goal);
      return completedRun(request.goal, goals.length);
    },
  });
  try {
    const result = await runner.run(program, {
      deviceId: "black-arm-01",
      mode: "execute",
      timeoutMs: 20_000,
      artifactDirectory: directory,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(goals, ["Open Telegram", "Go home"]);
    assert.ok(result.checkpointPath);
    const checkpoint = JSON.parse(await readFile(result.checkpointPath!, "utf8")) as {
      status: string;
      steps: Array<{ status: string }>;
    };
    assert.equal(checkpoint.status, "completed");
    assert.deepEqual(checkpoint.steps.map((step) => step.status), ["completed", "completed"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only mode blocks external steps before calling the visual executor", async () => {
  const goal = "给 Work 发送 hello";
  const clauses = segmentTaskGoal(goal);
  const program = buildTaskProgram({
    goal,
    accessMode: "read_only",
    clauses,
    strategy: "model",
    steps: [{
      operation: "achieve",
      objective: goal,
      clauseIds: [clauses[0].id],
      sideEffect: "external",
      verification: "external_receipt",
    }],
  });
  let calls = 0;
  const directory = await mkdtemp(join(tmpdir(), "screenhand-task-readonly-"));
  try {
    const result = await new UniversalTaskAgent({
      run: async () => {
        calls += 1;
        throw new Error("must not execute");
      },
    }).run(program, {
      deviceId: "black-arm-01",
      mode: "execute",
      timeoutMs: 20_000,
      artifactDirectory: directory,
    });
    assert.equal(result.status, "blocked");
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unverified external step becomes uncertain and is never retried", async () => {
  const goal = "给 Work 发送 hello";
  const clauses = segmentTaskGoal(goal);
  const program = buildTaskProgram({
    goal,
    accessMode: "full_access",
    clauses,
    strategy: "model",
    steps: [{
      operation: "achieve",
      objective: goal,
      clauseIds: [clauses[0].id],
      sideEffect: "external",
      verification: "external_receipt",
    }],
  });
  let calls = 0;
  const directory = await mkdtemp(join(tmpdir(), "screenhand-task-external-"));
  try {
    const result = await new UniversalTaskAgent({
      run: async (request) => {
        calls += 1;
        return blockedRun(request.goal);
      },
    }).run(program, {
      deviceId: "black-arm-01",
      mode: "execute",
      timeoutMs: 20_000,
      artifactDirectory: directory,
    });
    assert.equal(calls, 1);
    assert.equal(result.steps[0].status, "uncertain");
    assert.match(result.reason, /not automatically retried/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a blocked reversible physical step is not replayed by the outer runner", async () => {
  const program = simpleProgram("打开 Telegram，然后返回手机首页");
  let calls = 0;
  const directory = await mkdtemp(join(tmpdir(), "screenhand-task-no-replay-"));
  try {
    const result = await new UniversalTaskAgent({
      run: async (request) => {
        calls += 1;
        return calls === 1 ? completedRun(request.goal, calls) : blockedRun(request.goal);
      },
    }).run(program, {
      deviceId: "black-arm-01",
      mode: "execute",
      timeoutMs: 20_000,
      artifactDirectory: directory,
    });
    assert.equal(result.status, "blocked");
    assert.equal(calls, 2);
    assert.equal(result.steps[1].attempts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps semantic IR primitives to the existing fast local goal grammar", () => {
  const goal = "向下滚动";
  const clauses = segmentTaskGoal(goal);
  const program = buildTaskProgram({
    goal,
    accessMode: "full_access",
    clauses,
    strategy: "local",
    steps: [{
      operation: "swipe",
      objective: goal,
      clauseIds: [clauses[0].id],
      direction: "down",
      count: 2,
      sideEffect: "reversible",
      verification: "screen_transition",
    }],
  });
  assert.equal(executionGoalForStep(program.steps[0], 0, 2), "Scroll down (1 of 2)");
});

test("records a cross-step target prediction early and settles it without moving hardware", async () => {
  const clauses = segmentTaskGoal("Open Telegram, then tap Chats");
  const program = buildTaskProgram({
    goal: "Open Telegram, then tap Chats",
    accessMode: "full_access",
    clauses,
    strategy: "local",
    steps: [
      {
        operation: "open_app",
        objective: clauses[0].text,
        clauseIds: [clauses[0].id],
        app: "Telegram",
        sideEffect: "reversible",
        verification: "screen_transition",
      },
      {
        operation: "tap",
        objective: clauses[1].text,
        clauseIds: [clauses[1].id],
        target: "Chats",
        sideEffect: "reversible",
        verification: "visible_target",
      },
    ],
  });
  const directory = await mkdtemp(join(tmpdir(), "screenhand-task-lookahead-"));
  let calls = 0;
  let clock = 1_000;
  try {
    const result = await new UniversalTaskAgent({
      run: async (request) => {
        calls += 1;
        if (calls === 1) {
          clock = 1_200;
          return { ...completedRun(request.goal, 10), lastObservation: observation(10) };
        }
        clock = 1_500;
        return {
          ...completedRun(request.goal, 11),
          lastObservation: observation(11),
          plan: {
            kind: "tap_text",
            action: {
              type: "tap",
              point: { x: 360, y: 780 },
              viewport: { width: 720, height: 1_560 },
              frameSequence: 11,
            },
            label: "tap Chats",
            rationale: "fixture",
            confidence: 0.98,
            completesGoal: true,
            requiresVisualChange: true,
          },
          events: [{
            at: 1_450,
            phase: "act",
            step: 1,
            message: "Executing tap Chats.",
            data: {
              action: {
                type: "tap",
                point: { x: 360, y: 780 },
                viewport: { width: 720, height: 1_560 },
                frameSequence: 11,
              },
            },
          }],
        };
      },
    }, {
      now: () => clock,
      lookaheadPredictor: {
        predictTarget: (input) => ({
          mode: "shadow",
          evaluatedAt: input.evaluatedAt ?? clock,
          eligible: true,
          reason: "predicted-shadow-only",
          wouldMoveHardware: false,
          sampleCount: 4,
          effectiveSamples: 4,
          confidence: 0.96,
          uncertainty: 0.04,
          targetErrorP95Pixels: 2,
          candidate: {
            point: { x: 360, y: 780 },
            normalizedPoint: { x: 0.5, y: 0.5 },
            viewport: { width: 720, height: 1_560 },
          },
          evidenceTransitionIds: ["a", "b", "c", "d"],
        }),
      },
    }).run(program, {
      deviceId: "black-arm-01",
      mode: "execute",
      timeoutMs: 20_000,
      artifactDirectory: directory,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.lookahead.length, 1);
    assert.equal(result.lookahead[0].prediction.eligible, true);
    assert.equal(result.lookahead[0].settlement?.status, "matched");
    assert.equal(result.lookahead[0].settlement?.leadTimeMs, 250);
    assert.equal(result.lookahead[0].settlement?.targetErrorPixels, 0);
    assert.equal(result.lookahead[0].wouldMoveHardware, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function simpleProgram(goal: string) {
  const clauses = segmentTaskGoal(goal);
  return buildTaskProgram({
    goal,
    accessMode: "full_access",
    clauses,
    strategy: "local",
    steps: [
      {
        operation: "open_app",
        objective: clauses[0].text,
        clauseIds: [clauses[0].id],
        app: "Telegram",
        sideEffect: "reversible",
        verification: "screen_transition",
      },
      {
        operation: "navigate",
        objective: clauses[1].text,
        clauseIds: [clauses[1].id],
        target: "home",
        sideEffect: "reversible",
        verification: "screen_transition",
      },
    ],
  });
}

function completedRun(goal: string, sequence: number): AgentRunResult {
  return runResult(goal, "completed", sequence);
}

function blockedRun(goal: string): AgentRunResult {
  return runResult(goal, "blocked", 1);
}

function runResult(
  goal: string,
  status: AgentRunResult["status"],
  sequence: number,
): AgentRunResult {
  return {
    protocolVersion: "2026-08-31",
    runId: `subrun-${sequence}`,
    request: {
      deviceId: "black-arm-01",
      goal,
      mode: "execute",
      maxSteps: 20,
      timeoutMs: 20_000,
    },
    intent: { type: "unknown", reason: "test" },
    status,
    reason: status === "completed" ? "verified" : "not verified",
    steps: 1,
    startedAt: 0,
    completedAt: 1,
    metrics: {
      totalMs: 1,
      observations: 1,
      ocrRuns: 1,
      ocrCacheHits: 0,
      actions: status === "completed" ? 1 : 0,
      recoveries: 0,
      averageObservationMs: 1,
      averageOcrMs: 1,
      modelRuns: 0,
      averageModelMs: 0,
      actionReceiptMs: [],
    },
    events: [],
  };
}

function observation(sequence: number): NonNullable<AgentRunResult["lastObservation"]> {
  return {
    sequence,
    capturedAt: 1_100,
    viewport: { width: 720, height: 1_560 },
    fingerprint: `fixture-${sequence}`,
    changeRatio: 0.2,
    changeKind: "major",
    ocrCacheHit: false,
    ocrElapsedMs: 10,
    observationElapsedMs: 15,
    averageTextConfidence: 0.95,
    textSignature: ["chats"],
    elements: [{
      id: "text-chats",
      role: "text",
      text: "Chats",
      confidence: 0.95,
      center: { x: 360, y: 780 },
      bounds: { left: 320, top: 750, width: 80, height: 60 },
    }],
    scene: {
      kind: "text_ui",
      confidence: 0.95,
      homeGridScore: 0,
      keyboardVisible: false,
    },
  };
}
