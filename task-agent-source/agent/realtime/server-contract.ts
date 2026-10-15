import type { AgentDevice } from "../general-agent-client";

export type RealtimeRunApiRequest = {
  goal: string;
  deviceId: string;
  mode: "dry_run" | "execute";
  accessMode: "full_access" | "read_only";
  timeoutMs: number;
};

export class RealtimeRunApiValidationError extends Error {}

export type RealtimeUpstreamReadiness = {
  deviceId: string;
  reachable: boolean;
  connected: boolean;
  homed: boolean;
  screenshotAvailable: boolean;
  tapAvailable: boolean;
  readyForPreview: boolean;
  readyForExecute: boolean;
  blockReason: string | null;
};

export function summarizeRealtimeUpstream(
  deviceId: string,
  device: AgentDevice | null,
  unreachableReason = "The physical control plane is unavailable.",
): RealtimeUpstreamReadiness {
  if (!device || device.id !== deviceId) {
    return {
      deviceId,
      reachable: false,
      connected: false,
      homed: false,
      screenshotAvailable: false,
      tapAvailable: false,
      readyForPreview: false,
      readyForExecute: false,
      blockReason: unreachableReason,
    };
  }
  const connected = device.connected === true;
  const homed = device.state?.grbl?.homed === true;
  const screenshot = device.capabilities.observation?.screenshot;
  const screenshotAvailable = screenshot?.available === true || Boolean(device.screen);
  const tap = device.capabilities.actions.tap;
  const tapAvailable = tap?.available === true;
  const readyForPreview = screenshotAvailable;
  const readyForExecute = connected && homed && screenshotAvailable && tapAvailable;
  const blockReason = !connected
    ? "The physical controller is offline."
    : !homed
      ? "The robotic arm must be homed before execution."
      : !screenshotAvailable
        ? screenshot?.reason ?? "A fresh camera frame is required."
        : !tapAvailable
          ? tap?.reason ?? "Physical touch is safety locked."
          : null;
  return {
    deviceId,
    reachable: true,
    connected,
    homed,
    screenshotAvailable,
    tapAvailable,
    readyForPreview,
    readyForExecute,
    blockReason,
  };
}

export function parseRealtimeRunApiRequest(value: unknown): RealtimeRunApiRequest {
  const input = record(value);
  const allowed = new Set(["goal", "deviceId", "mode", "accessMode", "timeoutMs"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new RealtimeRunApiValidationError(`Unsupported fields: ${unknown.join(", ")}.`);
  }
  const goal = boundedString(input.goal, "goal", 500);
  const deviceId = input.deviceId === undefined
    ? "black-arm-01"
    : boundedString(input.deviceId, "deviceId", 120);
  const mode = input.mode === undefined ? "dry_run" : input.mode;
  if (mode !== "dry_run" && mode !== "execute") {
    throw new RealtimeRunApiValidationError("mode must be dry_run or execute.");
  }
  const accessMode = input.accessMode === undefined ? "full_access" : input.accessMode;
  if (accessMode !== "full_access" && accessMode !== "read_only") {
    throw new RealtimeRunApiValidationError("accessMode must be full_access or read_only.");
  }
  const timeoutMs = input.timeoutMs === undefined ? 300_000 : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2_000 || timeoutMs > 900_000) {
    throw new RealtimeRunApiValidationError("timeoutMs must be an integer from 2000 to 900000.");
  }
  return { goal, deviceId, mode, accessMode, timeoutMs };
}

export function selectRuntimeEngine(
  goal: string,
): "universal_task_ir" {
  void goal;
  // Every request enters the same Task IR compiler and generic executor.
  // Learned or deterministic accelerators may optimize a verified transition
  // later, but an application-specific route is never required for correctness.
  return "universal_task_ir";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RealtimeRunApiValidationError(`${name} is required.`);
  }
  const result = value.trim();
  if (result.length > maximum) {
    throw new RealtimeRunApiValidationError(`${name} exceeds ${maximum} characters.`);
  }
  return result;
}
