import { createHash } from "node:crypto";

export const TASK_IR_VERSION = "2026-09-01" as const;

export type TaskAccessMode = "full_access" | "read_only";
export type TaskOperation =
  | "open_app"
  | "navigate"
  | "tap"
  | "input_text"
  | "swipe"
  | "wait"
  | "inspect"
  | "achieve"
  | "report";
export type TaskSideEffect = "none" | "reversible" | "external" | "destructive";
export type TaskVerification =
  | "screen_transition"
  | "visible_target"
  | "visible_text"
  | "elapsed"
  | "semantic"
  | "external_receipt"
  | "report";

export type TaskClause = {
  id: string;
  text: string;
  order: number;
};

export type TaskStep = {
  id: string;
  operation: TaskOperation;
  objective: string;
  clauseIds: string[];
  app: string | null;
  target: string | null;
  text: string | null;
  direction: "up" | "down" | "left" | "right" | null;
  count: number;
  durationMs: number | null;
  sideEffect: TaskSideEffect;
  verification: TaskVerification;
  maximumAttempts: number;
};

export type TaskProgram = {
  version: typeof TASK_IR_VERSION;
  id: string;
  goal: string;
  accessMode: TaskAccessMode;
  clauses: TaskClause[];
  steps: TaskStep[];
  compiler: {
    strategy: "local" | "model" | "fallback";
    model: string | null;
    elapsedMs: number;
    cacheHit: boolean;
  };
};

export type UnvalidatedTaskStep = {
  operation: string;
  objective: string;
  clauseIds: string[];
  app?: string | null;
  target?: string | null;
  text?: string | null;
  direction?: string | null;
  count?: number | null;
  durationMs?: number | null;
  sideEffect?: string;
  verification?: string;
};

export class TaskProgramValidationError extends Error {
  readonly code = "INVALID_TASK_PROGRAM";
}

export function segmentTaskGoal(goal: string): TaskClause[] {
  const normalized = boundedGoal(goal);
  const fragments: string[] = [];
  let current = "";
  let quote: string | null = null;
  const matchingQuote = new Map([
    ["“", "”"],
    ["‘", "’"],
    ["\"", "\""],
    ["'", "'"],
  ]);
  const separators = new Set(["，", ",", "。", "；", ";", "！", "!", "？", "?", "\n"]);
  for (const character of normalized) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    const closing = matchingQuote.get(character);
    if (closing) {
      quote = closing;
      current += character;
      continue;
    }
    if (separators.has(character)) {
      pushFragment(fragments, current);
      current = "";
      continue;
    }
    current += character;
  }
  pushFragment(fragments, current);

  const expanded = fragments.flatMap((fragment) => splitOutsideQuotes(
    fragment,
    /^\s*(?:然后|接着|随后|之后|再然后|最后|and\s+then|after\s+that|finally|then)\s*/iu,
  ))
    .flatMap((fragment) => splitOutsideQuotes(
      fragment,
      /^\s*(?:并且|并(?=把|给|打开|关闭|返回|点击|搜索|查看|总结|发送|回复|进入))\s*/u,
    ))
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  const clauses = (expanded.length ? expanded : [normalized]).map((text, index) => ({
    id: `clause-${index + 1}`,
    text,
    order: index,
  }));
  if (clauses.length > 32) {
    throw new TaskProgramValidationError("A task may contain at most 32 clauses.");
  }
  return clauses;
}

export function buildTaskProgram(input: {
  goal: string;
  accessMode: TaskAccessMode;
  clauses: TaskClause[];
  steps: UnvalidatedTaskStep[];
  strategy: TaskProgram["compiler"]["strategy"];
  model?: string | null;
  elapsedMs?: number;
  cacheHit?: boolean;
}): TaskProgram {
  const goal = boundedGoal(input.goal);
  if (!input.clauses.length) {
    throw new TaskProgramValidationError("A task program requires at least one source clause.");
  }
  if (!input.steps.length || input.steps.length > 64) {
    throw new TaskProgramValidationError("A task program requires 1 to 64 steps.");
  }
  const clauseOrder = new Map(input.clauses.map((clause) => [clause.id, clause.order]));
  const covered = new Set<string>();
  let previousClauseOrder = -1;
  const steps = input.steps.map((candidate, index): TaskStep => {
    const operation = enumValue(
      candidate.operation,
      ["open_app", "navigate", "tap", "input_text", "swipe", "wait", "inspect", "achieve", "report"] as const,
      `steps[${index}].operation`,
    );
    const objective = boundedText(candidate.objective, `steps[${index}].objective`, 240);
    const clauseIds = [...new Set(candidate.clauseIds ?? [])];
    if (!clauseIds.length) {
      throw new TaskProgramValidationError(`steps[${index}] must reference a source clause.`);
    }
    const orders = clauseIds.map((clauseId) => {
      const order = clauseOrder.get(clauseId);
      if (order === undefined) {
        throw new TaskProgramValidationError(
          `steps[${index}] references unknown clause ${JSON.stringify(clauseId)}.`,
        );
      }
      covered.add(clauseId);
      return order;
    });
    const firstOrder = Math.min(...orders);
    if (firstOrder < previousClauseOrder) {
      throw new TaskProgramValidationError("Task steps must preserve source-clause order.");
    }
    previousClauseOrder = Math.max(...orders);

    const app = nullableText(candidate.app, `steps[${index}].app`, 80);
    const target = nullableText(candidate.target, `steps[${index}].target`, 160);
    const text = nullableText(candidate.text, `steps[${index}].text`, 500);
    const direction = candidate.direction === null || candidate.direction === undefined
      ? null
      : enumValue(
          candidate.direction,
          ["up", "down", "left", "right"] as const,
          `steps[${index}].direction`,
        );
    const count = candidate.count === null || candidate.count === undefined
      ? 1
      : boundedInteger(candidate.count, `steps[${index}].count`, 1, 100);
    const durationMs = candidate.durationMs === null || candidate.durationMs === undefined
      ? null
      : boundedInteger(candidate.durationMs, `steps[${index}].durationMs`, 0, 300_000);
    validateOperationFields(operation, { app, target, text, direction, durationMs }, index);
    const declaredEffect = enumValue(
      candidate.sideEffect ?? "reversible",
      ["none", "reversible", "external", "destructive"] as const,
      `steps[${index}].sideEffect`,
    );
    const sideEffect = strongestEffect(
      declaredEffect,
      minimumSideEffect(operation, `${objective} ${target ?? ""}`),
    );
    const declaredVerification = enumValue(
      candidate.verification ?? defaultVerification(operation, sideEffect),
      [
        "screen_transition", "visible_target", "visible_text", "elapsed",
        "semantic", "external_receipt", "report",
      ] as const,
      `steps[${index}].verification`,
    );
    const verification = sideEffect === "external" || sideEffect === "destructive"
      ? "external_receipt"
      : declaredVerification;
    return {
      id: `step-${String(index + 1).padStart(2, "0")}`,
      operation,
      objective,
      clauseIds,
      app,
      target,
      text,
      direction,
      count,
      durationMs,
      sideEffect,
      verification,
      // The visual step agent owns bounded perception/action recovery. Replaying
      // a whole physical step here multiplies taps and gestures after an
      // uncertain postcondition. Only a side-effect-free inspection may be
      // rerun by the outer Task IR runner.
      maximumAttempts: operation === "inspect" && sideEffect === "none" ? 2 : 1,
    };
  });
  const missing = input.clauses.filter((clause) => !covered.has(clause.id));
  if (missing.length) {
    throw new TaskProgramValidationError(
      `Task program omitted source clauses: ${missing.map((clause) => clause.id).join(", ")}.`,
    );
  }
  const identity = JSON.stringify({ goal, accessMode: input.accessMode, clauses: input.clauses, steps });
  return {
    version: TASK_IR_VERSION,
    id: `task-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
    goal,
    accessMode: input.accessMode,
    clauses: input.clauses,
    steps,
    compiler: {
      strategy: input.strategy,
      model: input.model ?? null,
      elapsedMs: Math.max(0, Math.round(input.elapsedMs ?? 0)),
      cacheHit: input.cacheHit ?? false,
    },
  };
}

export function withTaskProgramCacheHit(program: TaskProgram): TaskProgram {
  return {
    ...program,
    compiler: { ...program.compiler, elapsedMs: 0, cacheHit: true },
  };
}

function validateOperationFields(
  operation: TaskOperation,
  fields: {
    app: string | null;
    target: string | null;
    text: string | null;
    direction: TaskStep["direction"];
    durationMs: number | null;
  },
  index: number,
) {
  if (operation === "open_app" && !fields.app) {
    throw new TaskProgramValidationError(`steps[${index}] open_app requires app.`);
  }
  if (operation === "navigate" && !["back", "home", "enter"].includes(fields.target ?? "")) {
    throw new TaskProgramValidationError(`steps[${index}] navigate requires back, home, or enter.`);
  }
  if (operation === "tap" && !fields.target) {
    throw new TaskProgramValidationError(`steps[${index}] tap requires target.`);
  }
  if (operation === "input_text" && !fields.text) {
    throw new TaskProgramValidationError(`steps[${index}] input_text requires text.`);
  }
  if (operation === "swipe" && !fields.direction) {
    throw new TaskProgramValidationError(`steps[${index}] swipe requires direction.`);
  }
  if (operation === "wait" && fields.durationMs === null) {
    throw new TaskProgramValidationError(`steps[${index}] wait requires durationMs.`);
  }
}

function minimumSideEffect(operation: TaskOperation, description: string): TaskSideEffect {
  const normalized = description.normalize("NFKC").toLocaleLowerCase("en-US");
  const actionable = normalized
    .replace(
      /(?:不要|不应|不得|禁止|无需|不需要|切勿)\s*(?:发送|发布|提交|点赞|关注|取消关注|评论|回复|拨打|打电话|分享|删除|清空|移除|购买|支付|转账|付款|注销)/gu,
      "",
    )
    .replace(
      /\b(?:do\s+not|don't|never|must\s+not|should\s+not)\s+(?:send|post|publish|submit|like|follow|unfollow|comment|reply|call|dial|share|delete|erase|remove|purchase|buy|pay|transfer|unsubscribe)\b/gu,
      "",
    );
  if (
    /\b(?:delete|erase|remove|purchase|buy|pay|transfer|unsubscribe)\b/u.test(actionable) ||
    /删除|清空|移除|购买|支付|转账|付款|注销/u.test(actionable)
  ) return "destructive";
  const draftOnly = (
    /\b(?:write|draft|compose)\b.*\b(?:reply|comment|message|post)\b/u.test(actionable) ||
    /(?:写|拟|草拟|撰写).*(?:回复|评论|消息|文案)/u.test(actionable)
  ) && !(
    /\b(?:send|post|publish|submit)\b/u.test(actionable) ||
    /发送|发布|提交/u.test(actionable)
  );
  if (draftOnly) return "reversible";
  if (
    /\b(?:send|post|publish|submit|like|follow|unfollow|comment|reply|call|dial|share)\b/u
      .test(actionable) ||
    /发送|发布|提交|点赞|关注|取消关注|评论|回复|拨打|打电话|分享/u.test(actionable)
  ) return "external";
  if (operation === "inspect" || operation === "report" || operation === "wait") return "none";
  return "reversible";
}

function strongestEffect(left: TaskSideEffect, right: TaskSideEffect): TaskSideEffect {
  const rank: Record<TaskSideEffect, number> = {
    none: 0,
    reversible: 1,
    external: 2,
    destructive: 3,
  };
  return rank[left] >= rank[right] ? left : right;
}

function defaultVerification(
  operation: TaskOperation,
  sideEffect: TaskSideEffect,
): TaskVerification {
  if (sideEffect === "external" || sideEffect === "destructive") return "external_receipt";
  if (operation === "wait") return "elapsed";
  if (operation === "report") return "report";
  if (operation === "inspect" || operation === "achieve") return "semantic";
  if (operation === "input_text") return "visible_text";
  if (operation === "tap") return "visible_target";
  return "screen_transition";
}

function pushFragment(target: string[], value: string) {
  const trimmed = value.trim();
  if (trimmed) target.push(trimmed);
}

function splitOutsideQuotes(value: string, separator: RegExp) {
  const result: string[] = [];
  let current = "";
  let closingQuote: string | null = null;
  const quotes = new Map([
    ["“", "”"],
    ["‘", "’"],
    ["\"", "\""],
    ["'", "'"],
  ]);
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (closingQuote) {
      current += character;
      if (character === closingQuote) closingQuote = null;
      index += 1;
      continue;
    }
    const matchingQuote = quotes.get(character);
    if (matchingQuote) {
      closingQuote = matchingQuote;
      current += character;
      index += 1;
      continue;
    }
    const match = value.slice(index).match(separator);
    if (match?.[0]) {
      pushFragment(result, current);
      current = "";
      index += match[0].length;
      continue;
    }
    current += character;
    index += 1;
  }
  pushFragment(result, current);
  return result;
}

function boundedGoal(value: string) {
  return boundedText(value, "goal", 2_000);
}

function boundedText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskProgramValidationError(`${name} is required.`);
  }
  const result = value.trim();
  if (result.length > maximum) {
    throw new TaskProgramValidationError(`${name} exceeds ${maximum} characters.`);
  }
  return result;
}

function nullableText(value: unknown, name: string, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, name, maximum);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TaskProgramValidationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  name: string,
): Values[number] {
  if (!values.includes(value as Values[number])) {
    throw new TaskProgramValidationError(`${name} is invalid.`);
  }
  return value as Values[number];
}
