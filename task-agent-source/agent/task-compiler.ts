import { interpretGeneralGoal } from "./general-intent";
import {
  buildTaskProgram,
  segmentTaskGoal,
  withTaskProgramCacheHit,
  type TaskAccessMode,
  type TaskClause,
  type TaskProgram,
  type UnvalidatedTaskStep,
} from "./task-ir";

export type TaskCompileOptions = {
  accessMode?: TaskAccessMode;
  signal?: AbortSignal;
};

export interface TaskCompiler {
  compile(goal: string, options?: TaskCompileOptions): Promise<TaskProgram>;
}

export type OpenAITaskCompilerOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  serviceTier?: "auto" | "default" | "priority" | "flex";
  fetchImplementation?: typeof fetch;
};

export class OpenAITaskCompiler {
  private readonly model: string;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: OpenAITaskCompilerOptions) {
    if (!options.apiKey.trim()) throw new Error("Task compilation requires an API key.");
    this.model = options.model ?? "gpt-5.6-luna";
    this.baseUrl = new URL(options.baseUrl ?? "https://api.openai.com/v1/");
    this.timeoutMs = options.timeoutMs ?? 700;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  static fromEnvironment(): OpenAITaskCompiler | null {
    const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
    const apiKey = openRouterApiKey || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    const configuredTier = process.env.SCREENHAND_OPENAI_SERVICE_TIER;
    const serviceTier = ["auto", "default", "priority", "flex"].includes(
      configuredTier ?? "",
    ) ? configuredTier as OpenAITaskCompilerOptions["serviceTier"] : undefined;
    return new OpenAITaskCompiler({
      apiKey,
      model: process.env.SCREENHAND_TASK_MODEL?.trim() ||
        process.env.SCREENHAND_VISION_MODEL?.trim() ||
        (openRouterApiKey ? "openai/gpt-5.6-luna" : "gpt-5.6-luna"),
      baseUrl: process.env.OPENAI_BASE_URL?.trim() ||
        (openRouterApiKey ? "https://openrouter.ai/api/v1/" : undefined),
      timeoutMs: compilerTimeout(process.env.SCREENHAND_TASK_COMPILER_TIMEOUT_MS),
      serviceTier,
    });
  }

  async compile(
    goal: string,
    clauses: TaskClause[],
    accessMode: TaskAccessMode,
    signal?: AbortSignal,
  ): Promise<TaskProgram> {
    const startedAt = performance.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImplementation(new URL("responses", this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        max_output_tokens: 2_400,
        reasoning: { effort: "low" },
        ...(this.options.serviceTier ? { service_tier: this.options.serviceTier } : {}),
        prompt_cache_key: "screenhand-task-compiler-v1",
        instructions: TASK_COMPILER_INSTRUCTIONS,
        input: JSON.stringify({ goal, accessMode, clauses }),
        text: {
          format: {
            type: "json_schema",
            name: "screenhand_task_program",
            strict: true,
            schema: TASK_PROGRAM_SCHEMA,
          },
        },
      }),
      signal: combinedSignal,
    });
    const payload = await response.json() as unknown;
    if (!response.ok) {
      const error = record(record(payload).error);
      throw new Error(
        typeof error.message === "string"
          ? error.message
          : `Task compiler failed with HTTP ${response.status}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseOutputText(payload));
    } catch (error) {
      throw new Error("Task compiler returned invalid structured JSON.", { cause: error });
    }
    const steps = record(parsed).steps;
    if (!Array.isArray(steps)) throw new Error("Task compiler response omitted steps.");
    return buildTaskProgram({
      goal,
      accessMode,
      clauses,
      steps: steps as UnvalidatedTaskStep[],
      strategy: "model",
      model: this.model,
      elapsedMs: performance.now() - startedAt,
    });
  }
}

export class HybridTaskCompiler implements TaskCompiler {
  private readonly cache = new Map<string, TaskProgram>();

  constructor(
    private readonly modelCompiler: OpenAITaskCompiler | null = null,
    private readonly maximumCacheEntries = 128,
  ) {}

  static fromEnvironment() {
    return new HybridTaskCompiler(OpenAITaskCompiler.fromEnvironment());
  }

  async compile(goal: string, options: TaskCompileOptions = {}): Promise<TaskProgram> {
    const accessMode = options.accessMode ?? "full_access";
    const cacheKey = `${accessMode}\u0000${goal.normalize("NFKC").trim()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return withTaskProgramCacheHit(cached);
    }
    const startedAt = performance.now();
    const clauses = segmentTaskGoal(goal);
    // Task IR intentionally has no branch primitive. Preserve conditional
    // workflows as one semantic objective so the live visual executor owns
    // the branch decision, and avoid a cloud round trip on this hot path.
    const localSteps = clauses.some((clause) =>
      containsConditionalLanguage(clause.text)
    )
      ? fallbackSteps(clauses)
      : compileLocally(clauses);
    let program: TaskProgram;
    if (localSteps) {
      program = buildTaskProgram({
        goal,
        accessMode,
        clauses,
        steps: localSteps,
        strategy: "local",
        elapsedMs: performance.now() - startedAt,
      });
    } else if (this.modelCompiler) {
      try {
        program = await this.modelCompiler.compile(goal, clauses, accessMode, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        program = fallbackProgram(
          goal,
          accessMode,
          clauses,
          performance.now() - startedAt,
        );
      }
    } else {
      program = fallbackProgram(goal, accessMode, clauses, performance.now() - startedAt);
    }
    this.cache.set(cacheKey, program);
    while (this.cache.size > this.maximumCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return program;
  }
}

function fallbackProgram(
  goal: string,
  accessMode: TaskAccessMode,
  clauses: TaskClause[],
  elapsedMs: number,
) {
  return buildTaskProgram({
    goal,
    accessMode,
    clauses,
    steps: fallbackSteps(clauses),
    strategy: "fallback",
    elapsedMs,
  });
}

/**
 * A condition is control flow, not an independent physical instruction. When
 * the structured compiler is unavailable, keep the conditional workflow in a
 * single semantic step so the visual executor evaluates the condition from
 * the live screen before choosing whether to act. Only an unambiguous leading
 * app launch may be hoisted out as a fast local primitive.
 */
function fallbackSteps(clauses: TaskClause[]): UnvalidatedTaskStep[] {
  const firstConditional = clauses.findIndex((clause) =>
    containsConditionalLanguage(clause.text)
  );
  if (firstConditional < 0) {
    return clauses.map(fallbackStepForClauses);
  }

  const steps: UnvalidatedTaskStep[] = [];
  let workflowStart = 0;
  for (let index = 0; index < firstConditional; index += 1) {
    const compiled = compileClauseLocally(clauses[index]);
    if (
      compiled?.length === 1 &&
      compiled[0].operation === "open_app"
    ) {
      steps.push(...compiled);
      workflowStart = index + 1;
      continue;
    }
    break;
  }

  const workflow = clauses.slice(workflowStart);
  if (workflow.length) steps.push(fallbackStepForClauses(workflow));
  return steps;
}

function fallbackStepForClauses(
  value: TaskClause | TaskClause[],
): UnvalidatedTaskStep {
  const clauses = Array.isArray(value) ? value : [value];
  const objective = clauses.map((clause) => clause.text).join("；");
  const sideEffect = inferredFallbackEffect(objective);
  return {
    operation: "achieve",
    objective,
    clauseIds: clauses.map((clause) => clause.id),
    sideEffect,
    verification: sideEffect === "external" || sideEffect === "destructive"
      ? "external_receipt"
      : "semantic",
  };
}

function containsConditionalLanguage(value: string) {
  return /(?:如果|若(?:有|无|没|出现|存在|只有|不是|未)|除非|否则|有且只有|(?:有|没有|没|无)[^；，,。!?！？]{0,16}(?:的话|则|就))|\b(?:if|when|unless|otherwise|only\s+if)\b/iu
    .test(value.normalize("NFKC"));
}

function compileLocally(clauses: TaskClause[]): UnvalidatedTaskStep[] | null {
  const steps: UnvalidatedTaskStep[] = [];
  for (const clause of clauses) {
    const compiled = compileClauseLocally(clause);
    if (!compiled) return null;
    steps.push(...compiled);
  }
  return steps;
}

function compileClauseLocally(clause: TaskClause): UnvalidatedTaskStep[] | null {
  const delayedAction = clause.text.match(
    /^(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|seconds?|s|分钟|minutes?|m)后\s*(.+)$/iu,
  );
  if (delayedAction) {
    const remainder = compileGenericObjective(delayedAction[3], clause.id);
    if (!remainder) return null;
    return [
      {
        operation: "wait",
        objective: `等待 ${delayedAction[1]} ${delayedAction[2]}`,
        clauseIds: [clause.id],
        durationMs: durationFromParts(delayedAction[1], delayedAction[2]),
        sideEffect: "none",
        verification: "elapsed",
      },
      remainder,
    ];
  }
  const appContext = clause.text.match(
    /^(?:(?:打开|启动|进入|open|launch|start)\s*|在\s*|(?:use|using)\s+)([A-Za-z0-9][A-Za-z0-9._+-]{1,40})(?:\s+(.*))?$/iu,
  );
  if (appContext?.[1] && !isControlTarget(appContext[1])) {
    const open: UnvalidatedTaskStep = {
      operation: "open_app",
      objective: `打开 ${appContext[1]}`,
      clauseIds: [clause.id],
      app: appContext[1],
      sideEffect: "reversible",
      verification: "screen_transition",
    };
    if (!appContext[2]?.trim()) return [open];
    const remainder = compileGenericObjective(appContext[2].trim(), clause.id);
    return remainder ? [open, remainder] : null;
  }

  const wait = requestedWait(clause.text);
  if (wait !== null) {
    return [{
      operation: "wait",
      objective: clause.text,
      clauseIds: [clause.id],
      durationMs: wait,
      sideEffect: "none",
      verification: "elapsed",
    }];
  }
  if (/^(?:给我)?(?:汇报|报告|总结)|^(?:report|summarize)\b/iu.test(clause.text)) {
    return [{
      operation: "report",
      objective: clause.text,
      clauseIds: [clause.id],
      sideEffect: "none",
      verification: "report",
    }];
  }
  const controlName = clause.text.replace(
    /^(?:打开|开启|切换到|open|enable)\s*/iu,
    "",
  );
  if (isControlTarget(controlName)) {
    return [compileGenericObjective(clause.text, clause.id)!];
  }
  const intent = interpretGeneralGoal(clause.text);
  if (intent.type === "unknown") {
    const generic = compileGenericObjective(clause.text, clause.id);
    return generic ? [generic] : null;
  }
  if (intent.type === "open_app") {
    return [{
      operation: "open_app",
      objective: clause.text,
      clauseIds: [clause.id],
      app: intent.appName,
      sideEffect: "reversible",
      verification: "screen_transition",
    }];
  }
  if (intent.type === "navigate") {
    return [{
      operation: "navigate",
      objective: clause.text,
      clauseIds: [clause.id],
      target: intent.key,
      sideEffect: "reversible",
      verification: "screen_transition",
    }];
  }
  if (intent.type === "tap_text") {
    return [{
      operation: "tap",
      objective: clause.text,
      clauseIds: [clause.id],
      target: intent.text,
      sideEffect: inferredFallbackEffect(clause.text),
      verification: "visible_target",
    }];
  }
  if (intent.type === "tap_affordance") {
    return [{
      operation: "tap",
      objective: clause.text,
      clauseIds: [clause.id],
      target: describeVisualAffordance(intent.descriptor),
      sideEffect: inferredFallbackEffect(clause.text),
      verification: "visible_target",
    }];
  }
  if (intent.type === "input_text") {
    return [{
      operation: "input_text",
      objective: clause.text,
      clauseIds: [clause.id],
      target: intent.field,
      text: intent.text,
      sideEffect: "reversible",
      verification: "visible_text",
    }];
  }
  if (intent.type === "scroll") {
    return [{
      operation: "swipe",
      objective: clause.text,
      clauseIds: [clause.id],
      direction: intent.direction,
      sideEffect: "reversible",
      verification: "screen_transition",
    }];
  }
  return null;
}

function describeVisualAffordance(
  descriptor: Extract<ReturnType<typeof interpretGeneralGoal>, { type: "tap_affordance" }>["descriptor"],
) {
  if (descriptor.relativeTo) {
    const relation = descriptor.relativeTo.relation.replace(/_/gu, " ");
    return `${descriptor.symbol ?? descriptor.role} ${relation} ${descriptor.relativeTo.label}`;
  }
  const parts: Array<string | null | undefined> = [
    descriptor.vertical,
    descriptor.horizontal,
    descriptor.symbol,
    descriptor.role,
  ];
  return parts
    .filter((value): value is string => Boolean(value))
    .join("-");
}

function compileGenericObjective(
  objective: string,
  clauseId: string,
): UnvalidatedTaskStep | null {
  if (!(
    /(?:刷|浏览|观看|查看|读取|看看|看|找|搜索|总结|写|拟|发送|发布|点赞|关注|评论|回复|打电话|拨打|扬声器|挂掉|挂断|通话|聊天|search|find|inspect|read|summar|write|draft|send|post|like|follow|comment|reply|call|dial|speaker|hang\s*up|chat)/iu
      .test(objective)
  )) return null;
  const sideEffect = inferredFallbackEffect(objective);
  const inspect = sideEffect === "reversible" &&
    /(?:查看|读取|看看|看|找|搜索|总结|search|find|inspect|read|summar)/iu.test(objective);
  return {
    operation: inspect ? "inspect" : "achieve",
    objective,
    clauseIds: [clauseId],
    sideEffect,
    verification: sideEffect === "external" || sideEffect === "destructive"
      ? "external_receipt"
      : "semantic",
  };
}

function requestedWait(value: string) {
  const normalized = value.normalize("NFKC");
  const match = normalized.match(
    /^(?:等待|等|wait(?:\s+for)?)\s*(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|seconds?|s|分钟|minutes?|m)$/iu,
  );
  if (!match) return null;
  return durationFromParts(match[1], match[2]);
}

function inferredFallbackEffect(value: string) {
  const actionable = stripNegatedMutations(value);
  if (/删除|清空|购买|支付|转账|delete|purchase|pay|transfer/iu.test(actionable)) {
    return "destructive";
  }
  if (/发送|发布|点赞|关注|评论|回复|打电话|send|post|like|follow|comment|reply|call/iu.test(actionable)) {
    const draftOnly = (
      /(?:写|拟|草拟|撰写).*(?:回复|评论|消息|文案)/u.test(actionable) ||
      /\b(?:write|draft|compose)\b.*\b(?:reply|comment|message|post)\b/iu.test(actionable)
    ) && !/发送|发布|提交|\b(?:send|post|publish|submit)\b/iu.test(actionable);
    if (draftOnly) return "reversible";
    return "external";
  }
  return "reversible";
}

function stripNegatedMutations(value: string) {
  return value.normalize("NFKC")
    .replace(
      /(?:不要|不应|不得|禁止|无需|不需要|切勿)\s*(?:发送|发布|提交|点赞|关注|取消关注|评论|回复|拨打|打电话|分享|删除|清空|购买|支付|转账)/gu,
      "",
    )
    .replace(
      /\b(?:do\s+not|don't|never|must\s+not|should\s+not)\s+(?:send|post|publish|submit|like|follow|unfollow|comment|reply|call|dial|share|delete|erase|remove|purchase|buy|pay|transfer)\b/giu,
      "",
    );
}

function durationFromParts(amountValue: string, unitValue: string) {
  const amount = Number(amountValue);
  const unit = unitValue.toLocaleLowerCase("en-US");
  const multiplier = unit === "毫秒" || unit === "ms" ? 1
    : unit === "分钟" || unit === "minute" || unit === "minutes" || unit === "m"
      ? 60_000
      : 1_000;
  return Math.min(300_000, Math.round(amount * multiplier));
}

function isControlTarget(value: string) {
  return /^(?:扬声器|免提|键盘|拨号盘|麦克风|静音|闪光灯|speaker|speakerphone|keypad|microphone|mute|flash)$/iu
    .test(value.trim());
}

function compilerTimeout(value: string | undefined) {
  const parsed = Number(value ?? 700);
  return Number.isInteger(parsed) && parsed >= 200 && parsed <= 15_000 ? parsed : 700;
}

function responseOutputText(value: unknown) {
  const payload = record(value);
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const itemValue of output) {
    const content = Array.isArray(record(itemValue).content) ? record(itemValue).content : [];
    for (const contentValue of content) {
      const block = record(contentValue);
      if (block.type === "output_text" && typeof block.text === "string") return block.text;
    }
  }
  throw new Error("Task compiler response did not contain output text.");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const TASK_COMPILER_INSTRUCTIONS = `Compile one natural-language phone task into a short ordered semantic program.
The supplied clauses are immutable source coverage units. Every clause id must appear in at least one step, no unknown clause id may appear, and step order must preserve clause order. A clause may map to several atomic steps and related clauses may share one step.
This is a general camera-only phone agent. Do not emit pixel coordinates, selectors, application scripts, or hidden platform APIs. Express visible goals and completion evidence only.
Use open_app for launching an app, navigate for back/home/enter, tap for a named visible target, input_text for text entry, swipe for a directional gesture, wait only for an explicit duration, inspect for reading information, achieve for any other visible multi-action objective, and report for returning gathered results.
Preserve counts, durations, recipients, phone numbers, quoted text, ordering, and requested side effects exactly. Never reinterpret a UI control such as speaker, keypad, send, or home as an app name.
Mark sends, calls, likes, follows, comments, posts, and submissions external. Mark deletes, purchases, payments, transfers, and irreversible account changes destructive. Mark observation/report/wait none and navigation or unsent edits reversible.
Do not remove a requested side effect in read_only mode; classify it accurately so the executor can fail closed before acting.`;

const nullableString = { type: ["string", "null"] } as const;
const TASK_PROGRAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["open_app", "navigate", "tap", "input_text", "swipe", "wait", "inspect", "achieve", "report"],
          },
          objective: { type: "string", minLength: 1, maxLength: 240 },
          clauseIds: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 32 },
          },
          app: nullableString,
          target: nullableString,
          text: nullableString,
          direction: {
            type: ["string", "null"],
            enum: ["up", "down", "left", "right", null],
          },
          count: { type: ["integer", "null"], minimum: 1, maximum: 100 },
          durationMs: { type: ["integer", "null"], minimum: 0, maximum: 300_000 },
          sideEffect: {
            type: "string",
            enum: ["none", "reversible", "external", "destructive"],
          },
          verification: {
            type: "string",
            enum: ["screen_transition", "visible_target", "visible_text", "elapsed", "semantic", "external_receipt", "report"],
          },
        },
        required: [
          "operation", "objective", "clauseIds", "app", "target", "text",
          "direction", "count", "durationMs", "sideEffect", "verification",
        ],
      },
    },
  },
  required: ["steps"],
} as const;
