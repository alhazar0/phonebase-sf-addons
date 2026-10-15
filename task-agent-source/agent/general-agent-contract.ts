import type {
  ScreenHandPoint,
  ScreenHandSemanticAction,
  ScreenHandViewport,
} from "./action-contract";
import type { ActiveWorldSessionSummary } from "./active-world/types";
import type { LatencyRecorder } from "./realtime/latency-recorder";
import type { VisualChangeRegion } from "./frame-delta";
import type { SemanticSceneGraph } from "./semantic-scene-graph";
import type {
  VisualAffordance,
  VisualAffordanceSymbol,
} from "./visual-affordance-detector";

export const GENERAL_AGENT_PROTOCOL_VERSION = "2026-08-31" as const;

export type AgentRunMode = "dry_run" | "execute";

export type VisualAffordanceDescriptor = {
  role: "icon" | "button" | "control";
  horizontal: "left" | "center" | "right" | null;
  vertical: "top" | "middle" | "bottom" | null;
  symbol?: VisualAffordanceSymbol;
  relativeTo?: {
    label: string;
    relation: "left_of" | "right_of" | "above" | "below";
  };
};

export type GeneralAgentIntent =
  | { type: "open_app"; appName: string }
  | { type: "tap_text"; text: string }
  | { type: "tap_affordance"; descriptor: VisualAffordanceDescriptor }
  | { type: "input_text"; field: string; text: string }
  | { type: "scroll"; direction: "down" | "up" | "left" | "right" }
  | { type: "navigate"; key: "back" | "home" | "enter" }
  | { type: "unknown"; reason: string };

export type AgentRunRequest = {
  deviceId: string;
  goal: string;
  mode: AgentRunMode;
  maxSteps: number;
  timeoutMs: number;
};

export type AgentPhase =
  | "observe"
  | "understand"
  | "plan"
  | "act"
  | "verify"
  | "recover"
  | "remember";

export type ScreenElement = {
  id: string;
  role: "text";
  text: string;
  confidence: number;
  center: ScreenHandPoint;
  bounds: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

export type ScreenScene = {
  kind:
    | "screen_off"
    | "home_grid"
    | "app_switcher"
    | "app_library"
    | "keyboard"
    | "text_ui"
    | "unknown";
  confidence: number;
  homeGridScore: number;
  keyboardVisible: boolean;
};

export type ScreenObservation = {
  sequence: number;
  capturedAt: number;
  viewport: ScreenHandViewport;
  fingerprint: string;
  changeRatio: number | null;
  changeKind: "first" | "stable" | "minor" | "major";
  ocrCacheHit: boolean;
  ocrElapsedMs: number;
  observationElapsedMs: number;
  averageTextConfidence: number;
  textSignature: Set<string>;
  elements: ScreenElement[];
  scene: ScreenScene;
  /** Present on live observations produced by the incremental observer. */
  changedRegions?: VisualChangeRegion[];
  ocrStrategy?: "full" | "regions" | "cache";
  ocrRegionCount?: number;
  visualAffordances?: VisualAffordance[];
  affordanceCacheHit?: boolean;
  affordanceElapsedMs?: number;
  sceneGraph?: SemanticSceneGraph;
};

export type AgentPlan = {
  kind:
    | "wake_screen"
    | "reach_home"
    | "open_app"
    | "open_app_search"
    | "search_app"
    | "open_app_result"
    | "dismiss_app_switcher"
    | "leave_app_library"
    | "search_home_page"
    | "tap_text"
    | "tap_affordance"
    | "focus_field"
    | "prepare_keyboard"
    | "input_text"
    | "scroll"
    | "navigate"
    | "popup_guardian"
    | "model"
    | "recover";
  action: ScreenHandSemanticAction;
  label: string;
  rationale: string;
  confidence: number;
  completesGoal: boolean;
  requiresVisualChange: boolean;
};

export type AgentRunEvent = {
  at: number;
  phase: AgentPhase;
  step: number;
  message: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

export type AgentRunStatus =
  | "planned"
  | "completed"
  | "blocked"
  | "failed"
  | "timed_out";

export type AgentRunResult = {
  protocolVersion: typeof GENERAL_AGENT_PROTOCOL_VERSION;
  runId: string;
  request: AgentRunRequest;
  intent: GeneralAgentIntent;
  status: AgentRunStatus;
  reason: string;
  steps: number;
  startedAt: number;
  completedAt: number;
  metrics: {
    totalMs: number;
    observations: number;
    ocrRuns: number;
    ocrCacheHits: number;
    actions: number;
    recoveries: number;
    averageObservationMs: number;
    averageOcrMs: number;
    modelRuns: number;
    averageModelMs: number;
    actionReceiptMs: number[];
    runtimeTiming?: ReturnType<LatencyRecorder["snapshot"]>;
  };
  plan?: AgentPlan;
  lastObservation?: Omit<ScreenObservation, "textSignature"> & {
    textSignature: string[];
  };
  events: AgentRunEvent[];
  activeWorld?: ActiveWorldSessionSummary;
};

export class GeneralAgentValidationError extends Error {
  readonly code = "INVALID_AGENT_REQUEST";
}

export function parseAgentRunRequest(value: unknown): AgentRunRequest {
  const input = record(value);
  const allowed = new Set(["deviceId", "goal", "mode", "maxSteps", "timeoutMs"]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new GeneralAgentValidationError(
      `Agent request contains unsupported fields: ${unexpected.join(", ")}.`,
    );
  }
  const deviceId = boundedString(input.deviceId, "deviceId", 120);
  const goal = boundedString(input.goal, "goal", 500);
  const mode = input.mode === undefined ? "dry_run" : input.mode;
  if (mode !== "dry_run" && mode !== "execute") {
    throw new GeneralAgentValidationError("mode must be dry_run or execute.");
  }
  return {
    deviceId,
    goal,
    mode,
    maxSteps: boundedInteger(input.maxSteps, "maxSteps", 1, 20, 8),
    timeoutMs: boundedInteger(input.timeoutMs, "timeoutMs", 2_000, 180_000, 45_000),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GeneralAgentValidationError(`${field} is required.`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new GeneralAgentValidationError(`${field} exceeds ${maxLength} characters.`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new GeneralAgentValidationError(
      `${field} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return result;
}
