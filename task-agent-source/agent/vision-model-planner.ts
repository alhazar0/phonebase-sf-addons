import type { ScreenObservation } from "./general-agent-contract";
import type { AgentFrame } from "./screen-observer";

export type VisionModelProposal = {
  operation:
    | "tap"
    | "swipe"
    | "input_text"
    | "back"
    | "home"
    | "enter"
    | "wait"
    | "complete"
    | "blocked";
  target: string | null;
  text: string | null;
  x: number | null;
  y: number | null;
  startX: number | null;
  startY: number | null;
  endX: number | null;
  endY: number | null;
  durationMs: number | null;
  confidence: number;
  rationale: string;
};

export type VisionModelPlannerInput = {
  goal: string;
  step: number;
  frame: AgentFrame;
  observation: ScreenObservation;
  accessMode?: "full_access" | "read_only";
  history?: string[];
  signal?: AbortSignal;
};

export interface VisionModelPlanner {
  plan(input: VisionModelPlannerInput): Promise<VisionModelProposal>;
}

export type OpenAIVisionPlannerOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  serviceTier?: "auto" | "default" | "priority" | "flex";
  fetchImplementation?: typeof fetch;
};

export class OpenAIVisionPlanner implements VisionModelPlanner {
  private readonly model: string;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: OpenAIVisionPlannerOptions) {
    if (!options.apiKey.trim()) throw new Error("OpenAI visual planning requires an API key.");
    this.model = options.model ?? "gpt-5.6-luna";
    this.baseUrl = new URL(options.baseUrl ?? "https://api.openai.com/v1/");
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  static fromEnvironment(): OpenAIVisionPlanner | null {
    const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
    const apiKey = openRouterApiKey || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    const configuredTier = process.env.SCREENHAND_OPENAI_SERVICE_TIER;
    const serviceTier = ["auto", "default", "priority", "flex"].includes(
      configuredTier ?? "",
    ) ? configuredTier as OpenAIVisionPlannerOptions["serviceTier"] : undefined;
    return new OpenAIVisionPlanner({
      apiKey,
      model: process.env.SCREENHAND_VISION_MODEL?.trim() ||
        (openRouterApiKey ? "openai/gpt-5.6-luna" : "gpt-5.6-luna"),
      baseUrl: process.env.OPENAI_BASE_URL?.trim() ||
        (openRouterApiKey ? "https://openrouter.ai/api/v1/" : undefined),
      serviceTier,
    });
  }

  async plan(input: VisionModelPlannerInput): Promise<VisionModelProposal> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    const response = await this.fetchImplementation(new URL("responses", this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        max_output_tokens: 500,
        reasoning: { effort: "low" },
        ...(this.options.serviceTier ? { service_tier: this.options.serviceTier } : {}),
        prompt_cache_key: "screenhand-visual-planner-v1",
        instructions: VISUAL_PLANNER_INSTRUCTIONS,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: plannerContext(input),
            },
            {
              type: "input_image",
              image_url: `data:${input.frame.mimeType};base64,${input.frame.bytes.toString("base64")}`,
              detail: "low",
            },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "screenhand_visual_action",
            strict: true,
            schema: PROPOSAL_SCHEMA,
          },
        },
      }),
      signal,
    });
    const payload = await response.json() as unknown;
    if (!response.ok) {
      const error = record(record(payload).error);
      throw new Error(
        typeof error.message === "string"
          ? error.message
          : `OpenAI visual planner failed with HTTP ${response.status}.`,
      );
    }
    const outputText = responseOutputText(payload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch (error) {
      throw new Error("OpenAI visual planner returned invalid structured JSON.", { cause: error });
    }
    return validateProposal(parsed);
  }
}

const VISUAL_PLANNER_INSTRUCTIONS = `You are the low-latency slow-path visual planner for a physical phone robot.
Choose exactly one next primitive from the current screenshot. Coordinates are normalized from 0 to 1.
Use complete only when the screenshot itself proves the user's goal is already satisfied.
Use blocked when the next step is ambiguous or lacks a visible safe target.
Preserve every clause in a multi-step goal. Never reinterpret a requested control such as speaker, keypad, or send as an app name. Use recent verified actions to select the first unfinished clause.
Use wait only when the goal explicitly requests a delay or when a visible loading state needs a bounded pause. durationMs must be from 0 to 30000.
The context declares access mode. In read_only mode never propose posting, sending, liking, following, sharing, deleting, purchasing, authentication, or permission changes. In full_access mode you may propose a visible external action only when the user's stated goal explicitly requests that exact effect. Never invent an effect that the goal did not request.
Never infer hidden controls, credentials, payment authorization, or destructive intent.
Prefer visible text centers. For swipe, use a clear content area and avoid system edges unless the operation is home or back.`;

const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: {
      type: "string",
      enum: ["tap", "swipe", "input_text", "back", "home", "enter", "wait", "complete", "blocked"],
    },
    target: { type: ["string", "null"] },
    text: { type: ["string", "null"] },
    x: { type: ["number", "null"], minimum: 0, maximum: 1 },
    y: { type: ["number", "null"], minimum: 0, maximum: 1 },
    startX: { type: ["number", "null"], minimum: 0, maximum: 1 },
    startY: { type: ["number", "null"], minimum: 0, maximum: 1 },
    endX: { type: ["number", "null"], minimum: 0, maximum: 1 },
    endY: { type: ["number", "null"], minimum: 0, maximum: 1 },
    durationMs: { type: ["integer", "null"], minimum: 0, maximum: 30_000 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", minLength: 1, maxLength: 240 },
  },
  required: [
    "operation", "target", "text", "x", "y", "startX", "startY",
    "endX", "endY", "durationMs", "confidence", "rationale",
  ],
} as const;

function plannerContext(input: VisionModelPlannerInput) {
  const visibleText = input.observation.elements
    .filter((element) => element.confidence >= 0.35)
    .slice(0, 40)
    .map((element) => element.text)
    .join(" · ");
  return [
    `Goal: ${input.goal}`,
    `Step: ${input.step}`,
    `Access mode: ${input.accessMode ?? "read_only"}`,
    `Viewport: ${input.observation.viewport.width}x${input.observation.viewport.height}`,
    `Local scene: ${input.observation.scene.kind}`,
    `OCR text: ${visibleText || "none"}`,
    `Recent verified actions: ${input.history?.slice(-8).join(" | ") || "none"}`,
  ].join("\n");
}

function responseOutputText(value: unknown) {
  const payload = record(value);
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const itemValue of output) {
    const item = record(itemValue);
    const content = Array.isArray(item.content) ? item.content : [];
    for (const contentValue of content) {
      const block = record(contentValue);
      if (block.type === "output_text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  throw new Error("OpenAI visual planner response did not contain output text.");
}

function validateProposal(value: unknown): VisionModelProposal {
  const proposal = record(value);
  const operation = String(proposal.operation ?? "");
  const operations = [
    "tap", "swipe", "input_text", "back", "home", "enter", "wait", "complete", "blocked",
  ] as const;
  if (!operations.includes(operation as typeof operations[number])) {
    throw new Error(`Visual planner returned an unsupported operation: ${operation}.`);
  }
  const confidence = Number(proposal.confidence);
  const rationale = typeof proposal.rationale === "string"
    ? proposal.rationale.trim().slice(0, 240)
    : "";
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error("Visual planner returned invalid confidence or rationale fields.");
  }
  const normalized = (field: string) => {
    if (proposal[field] === null) return null;
    const number = Number(proposal[field]);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      throw new Error(`Visual planner returned invalid ${field}.`);
    }
    return number;
  };
  const result: VisionModelProposal = {
    operation: operation as VisionModelProposal["operation"],
    target: nullableString(proposal.target, 120),
    text: nullableString(proposal.text, 120),
    x: normalized("x"),
    y: normalized("y"),
    startX: normalized("startX"),
    startY: normalized("startY"),
    endX: normalized("endX"),
    endY: normalized("endY"),
    durationMs: proposal.durationMs === null
      ? null
      : boundedInteger(proposal.durationMs, "durationMs", 0, 30_000),
    confidence,
    rationale,
  };
  if (result.operation === "tap" && (result.x === null || result.y === null)) {
    throw new Error("Visual planner tap requires normalized x and y coordinates.");
  }
  if (
    result.operation === "swipe" &&
    [result.startX, result.startY, result.endX, result.endY].some((point) => point === null)
  ) {
    throw new Error("Visual planner swipe requires four normalized coordinates.");
  }
  if (result.operation === "input_text" && !result.text) {
    throw new Error("Visual planner input_text requires bounded text.");
  }
  if (result.operation === "wait" && result.durationMs === null) {
    throw new Error("Visual planner wait requires durationMs.");
  }
  return result;
}

function nullableString(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Visual planner returned invalid ${field}.`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
