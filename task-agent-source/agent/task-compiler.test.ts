import assert from "node:assert/strict";
import test from "node:test";

import { interpretGeneralGoal } from "./general-intent";
import { HybridTaskCompiler, OpenAITaskCompiler } from "./task-compiler";
import { buildTaskProgram, segmentTaskGoal, TaskProgramValidationError } from "./task-ir";
import { executionGoalForStep } from "./task-runner";

test("locally compiles an ordered multi-step primitive task without a model", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile("打开 Telegram，然后返回手机首页");
  assert.equal(program.compiler.strategy, "local");
  assert.deepEqual(program.steps.map((step) => step.operation), ["open_app", "navigate"]);
  assert.equal(program.steps[0].app, "Telegram");
  assert.equal(program.steps[1].target, "home");
  assert.deepEqual(program.steps.map((step) => step.maximumAttempts), [1, 1]);
  assert.deepEqual(
    new Set(program.steps.flatMap((step) => step.clauseIds)),
    new Set(program.clauses.map((clause) => clause.id)),
  );
});

test("preserves an explicit spatial affordance tap through Task IR", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile("点击右上角图标");
  assert.equal(program.compiler.strategy, "local");
  assert.equal(program.steps.length, 1);
  assert.equal(program.steps[0].operation, "tap");
  assert.equal(program.steps[0].target, "top-right-icon");
  assert.equal(program.steps[0].verification, "visible_target");
  assert.equal(program.steps[0].sideEffect, "reversible");
  assert.deepEqual(interpretGeneralGoal(executionGoalForStep(program.steps[0])), {
    type: "tap_affordance",
    descriptor: { role: "icon", horizontal: "right", vertical: "top" },
  });
});

test("preserves a visual symbol tap through Task IR without turning it into text OCR", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile("点击关闭 X 图标");
  assert.equal(program.steps[0].operation, "tap");
  assert.equal(program.steps[0].target, "close-icon");
  assert.deepEqual(interpretGeneralGoal(executionGoalForStep(program.steps[0])), {
    type: "tap_affordance",
    descriptor: {
      role: "icon",
      horizontal: null,
      vertical: null,
      symbol: "close",
    },
  });
});

test("preserves a Search symbol through Task IR without confusing visible Search text", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile("点击搜索图标");
  assert.equal(program.steps[0].target, "search-icon");
  assert.deepEqual(interpretGeneralGoal(executionGoalForStep(program.steps[0])), {
    type: "tap_affordance",
    descriptor: {
      role: "icon",
      horizontal: null,
      vertical: null,
      symbol: "search",
    },
  });
});

test("preserves relative visual grounding through Task IR", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile("点击 Search 右边的图标");
  assert.equal(program.steps[0].operation, "tap");
  assert.equal(program.steps[0].target, "icon right of search");
  assert.deepEqual(interpretGeneralGoal(executionGoalForStep(program.steps[0])), {
    type: "tap_affordance",
    descriptor: {
      role: "icon",
      horizontal: null,
      vertical: null,
      relativeTo: { label: "search", relation: "right_of" },
    },
  });
});

test("outer Task IR retries only read-only inspection, never physical primitives", () => {
  const goal = "查看当前页面，然后返回首页";
  const clauses = segmentTaskGoal(goal);
  const program = buildTaskProgram({
    goal,
    accessMode: "full_access",
    clauses,
    strategy: "model",
    steps: [
      step({
        operation: "inspect",
        objective: clauses[0].text,
        clauseIds: [clauses[0].id],
        sideEffect: "none",
        verification: "semantic",
      }),
      step({
        operation: "navigate",
        objective: clauses[1].text,
        clauseIds: [clauses[1].id],
        target: "home",
      }),
    ],
  });
  assert.equal(program.steps[0].maximumAttempts, 2);
  assert.equal(program.steps[1].maximumAttempts, 1);
});

test("local compiler preserves every clause instead of collapsing the first app phrase", async () => {
  const compiler = new HybridTaskCompiler();
  const goal =
    "帮我看看手机有多少图片和视频；打开 TikTok 刷10个视频，点赞三个；" +
    "给19195525252打电话并打开扬声器，10秒后挂掉";
  const program = await compiler.compile(goal);
  assert.equal(program.compiler.strategy, "local");
  assert.ok(program.steps.length >= 5);
  const covered = new Set(program.steps.flatMap((step) => step.clauseIds));
  assert.deepEqual(covered, new Set(program.clauses.map((clause) => clause.id)));
  assert.match(program.steps.map((step) => step.objective).join(" "), /19195525252/);
  assert.match(program.steps.map((step) => step.objective).join(" "), /扬声器/);
  assert.ok(program.steps.some((step) => step.sideEffect === "external"));
});

test("generic local compilation separates apps from controls and keeps timed call steps", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile(
    "打开 TikTok 刷四个视频，点赞两个；给19195525252打电话并打开扬声器，10秒后挂掉",
  );
  assert.equal(program.compiler.strategy, "local");
  assert.equal(program.steps[0].operation, "open_app");
  assert.equal(program.steps[0].app, "TikTok");
  assert.ok(program.steps.some((step) => step.objective.includes("刷四个视频")));
  const speaker = program.steps.find((step) => step.objective.includes("扬声器"));
  assert.ok(speaker);
  assert.notEqual(speaker.operation, "open_app");
  const wait = program.steps.find((step) => step.operation === "wait");
  assert.equal(wait?.durationMs, 10_000);
  assert.ok(program.steps.some((step) => step.objective.includes("挂掉")));
});

test("drafting a reply is reversible until a separate send step", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile("给他写个合理的回复，然后发送");
  assert.equal(program.compiler.strategy, "local");
  assert.equal(program.steps[0].sideEffect, "reversible");
  assert.equal(program.steps[1].sideEffect, "external");
});

test("clause segmentation never splits connector words inside quoted text", () => {
  const clauses = segmentTaskGoal(
    "打开 Telegram，然后输入\"This and then that\"，最后发送",
  );
  assert.deepEqual(clauses.map((clause) => clause.text), [
    "打开 Telegram",
    "输入\"This and then that\"",
    "发送",
  ]);
});

test("one structured model call compiles a complex general task with source coverage", async () => {
  let calls = 0;
  const model = new OpenAITaskCompiler({
    apiKey: "test-key",
    model: "test-model",
    fetchImplementation: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as {
        input: string;
        text: { format: { type: string; strict: boolean } };
      };
      const input = JSON.parse(body.input) as { clauses: Array<{ id: string }> };
      assert.equal(body.text.format.type, "json_schema");
      assert.equal(body.text.format.strict, true);
      const [first, second, ...remaining] = input.clauses;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          steps: [
            step({ operation: "open_app", objective: "Open Telegram", clauseIds: [first.id], app: "Telegram" }),
            step({ operation: "inspect", objective: "Read the latest message from Work", clauseIds: [second.id], sideEffect: "none", verification: "semantic" }),
            step({ operation: "achieve", objective: "Write and send a reasonable reply", clauseIds: remaining.map((clause) => clause.id), sideEffect: "external", verification: "external_receipt" }),
          ],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const compiler = new HybridTaskCompiler(model);
  const goal = "打开 Telegram，然后处理 Work 中最新的事情，然后完成合适的后续操作";
  const program = await compiler.compile(goal);
  assert.equal(calls, 1);
  assert.equal(program.compiler.strategy, "model");
  assert.deepEqual(program.steps.map((item) => item.operation), ["open_app", "inspect", "achieve"]);
  assert.equal(program.steps[2].sideEffect, "external");
  assert.equal(program.steps[2].maximumAttempts, 1);

  const cached = await compiler.compile(goal);
  assert.equal(calls, 1);
  assert.equal(cached.compiler.cacheHit, true);
  assert.equal(cached.id, program.id);
});

test("validation rejects a model program that drops a user clause", () => {
  const goal = "打开 TikTok，然后点赞一个视频";
  const clauses = segmentTaskGoal(goal);
  assert.throws(() => buildTaskProgram({
    goal,
    accessMode: "full_access",
    clauses,
    strategy: "model",
    steps: [step({
      operation: "open_app",
      objective: "Open TikTok",
      clauseIds: [clauses[0].id],
      app: "TikTok",
    })],
  }), TaskProgramValidationError);
});

test("a remote compiler failure falls back without dropping the task", async () => {
  let calls = 0;
  const compiler = new HybridTaskCompiler(new OpenAITaskCompiler({
    apiKey: "test-key",
    fetchImplementation: async () => {
      calls += 1;
      throw new Error("network unavailable");
    },
  }));
  const goal = "打开一个未知应用，然后完成里面的未知任务";
  const program = await compiler.compile(goal);
  assert.equal(calls, 1);
  assert.equal(program.compiler.strategy, "fallback");
  assert.deepEqual(
    new Set(program.steps.flatMap((step) => step.clauseIds)),
    new Set(program.clauses.map((clause) => clause.id)),
  );
});

test("local compilation keeps conditional control flow atomic after an app launch", async () => {
  let modelCalls = 0;
  const compiler = new HybridTaskCompiler(new OpenAITaskCompiler({
    apiKey: "test-key",
    fetchImplementation: async () => {
      modelCalls += 1;
      throw new Error("compiler timeout");
    },
  }));
  const goal =
    "打开 Snapchat；检查是否有新消息；如果有且只有一个来自她的新消息，回复 I love you babe；" +
    "如果没有新消息则不要发送；如果有多个候选联系人则停止并汇报";
  const program = await compiler.compile(goal);

  assert.equal(modelCalls, 0);
  assert.equal(program.compiler.strategy, "local");
  assert.deepEqual(program.steps.map((step) => step.operation), ["open_app", "achieve"]);
  assert.equal(program.steps[0].app, "Snapchat");
  assert.deepEqual(
    program.steps[1].clauseIds,
    program.clauses.slice(1).map((clause) => clause.id),
  );
  assert.match(program.steps[1].objective, /如果有且只有一个/);
  assert.match(program.steps[1].objective, /如果没有新消息则不要发送/);
  assert.equal(program.steps[1].sideEffect, "external");
  assert.equal(program.steps[1].verification, "external_receipt");
  assert.equal(program.steps[1].maximumAttempts, 1);
});

test("fallback recognizes colloquial Chinese conditional wording", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile(
    "打开 Snapchat，看看有没有新消息，有的话给她回复 I love you babe",
  );

  assert.deepEqual(program.steps.map((step) => step.operation), ["open_app", "achieve"]);
  assert.match(program.steps[1].objective, /看看有没有新消息/);
  assert.match(program.steps[1].objective, /有的话给她回复/);
  assert.equal(program.steps[1].sideEffect, "external");
});

test("a negated mutation is not classified as an action", async () => {
  const compiler = new HybridTaskCompiler();
  const program = await compiler.compile("如果没有新消息则不要发送");
  assert.equal(program.steps.length, 1);
  assert.equal(program.steps[0].sideEffect, "reversible");
});

test("validation elevates understated mutation risk and never retries it", () => {
  const goal = "给 Work 发送 hello";
  const clauses = segmentTaskGoal(goal);
  const program = buildTaskProgram({
    goal,
    accessMode: "full_access",
    clauses,
    strategy: "model",
    steps: [step({
      operation: "achieve",
      objective: goal,
      clauseIds: [clauses[0].id],
      sideEffect: "reversible",
      verification: "semantic",
    })],
  });
  assert.equal(program.steps[0].sideEffect, "external");
  assert.equal(program.steps[0].verification, "external_receipt");
  assert.equal(program.steps[0].maximumAttempts, 1);
});

test("validation rejects a later step that moves backward inside overlapping clause coverage", () => {
  const goal = "打开 Telegram，然后查看 Work，然后回复";
  const clauses = segmentTaskGoal(goal);
  assert.throws(() => buildTaskProgram({
    goal,
    accessMode: "full_access",
    strategy: "model",
    clauses,
    steps: [
      step({
        objective: "Open and prepare the reply",
        clauseIds: [clauses[0].id, clauses[2].id],
      }),
      step({ objective: "Inspect Work", clauseIds: [clauses[1].id] }),
    ],
  }), /preserve source-clause order/);
});

function step(overrides: Record<string, unknown>) {
  return {
    operation: "achieve",
    objective: "Do the requested visible task",
    clauseIds: ["clause-1"],
    app: null,
    target: null,
    text: null,
    direction: null,
    count: 1,
    durationMs: null,
    sideEffect: "reversible",
    verification: "screen_transition",
    ...overrides,
  };
}
