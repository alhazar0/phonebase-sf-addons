import { randomUUID } from "node:crypto";

import type { ScreenHandSemanticAction } from "./action-contract";
import {
  parseScreenHandCalibrationProfile,
  type ScreenHandCalibrationProfile,
} from "./calibration-profile";
import type { AgentFrame } from "./screen-observer";
import { renderModelScreenFrame } from "./rectify-frame";
import type { PublicFrameGeometry } from "./frame-geometry";

export type AgentDevice = {
  id: string;
  connected: boolean;
  status: string;
  screen: PublicFrameGeometry & {
    sequence?: number;
    capturedAt?: number;
  } | null;
  capabilities: {
    observation?: {
      screenshot?: { available: boolean; reason?: string };
      liveFrames?: { available: boolean; reason?: string };
    };
    actions: Record<string, { available: boolean; reason?: string }>;
  };
  state?: {
    grbl?: {
      connected?: boolean;
      homed?: boolean;
      state?: string;
      x?: number;
      y?: number;
      z?: number;
      /** Absolute controller-space Z. Unlike `z`, hover is not normalized to 0. */
      physicalZ?: number;
      activeOperation?: unknown;
      liveTouch?: unknown;
      tapProfile?: {
        hoverZ?: number;
        touchZ?: number;
        minimumTouchZ?: number;
        maximumTouchZ?: number;
      };
    };
  };
};

export type ActionReceipt = {
  id: string;
  status: "accepted" | "executing" | "completed" | "failed";
  error?: string | null;
  durationMs?: number;
  elapsedMs?: number;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number | null;
  result?: unknown;
};

export type AgentActionResult = {
  receipt: ActionReceipt;
  elapsedMs: number;
  response: unknown;
};

export type ExecuteActionOptions = {
  idempotencyKey?: string;
};

export interface GeneralAgentDeviceClient {
  getDevice(signal?: AbortSignal): Promise<AgentDevice>;
  getScreenshot(signal?: AbortSignal): Promise<AgentFrame>;
  waitForNewScreenshot(
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentFrame>;
  executeAction(
    action: ScreenHandSemanticAction,
    signal?: AbortSignal,
    options?: ExecuteActionOptions,
  ): Promise<AgentActionResult>;
}

export class ScreenHandGeneralAgentClient implements GeneralAgentDeviceClient {
  readonly baseUrl: URL;

  constructor(
    readonly deviceId: string,
    baseUrl = process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3013",
    private readonly receiptTimeoutMs = 30_000,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  }

  async getDevice(signal?: AbortSignal): Promise<AgentDevice> {
    const payload = record(await this.json(
      `/api/v1/devices/${encodeURIComponent(this.deviceId)}`,
      { signal },
    ));
    const device = record(payload.device) as Partial<AgentDevice>;
    if (device.id !== this.deviceId || !device.capabilities) {
      throw new ScreenHandAgentClientError(
        "DEVICE_RESPONSE_INVALID",
        "The control plane returned an invalid device response.",
      );
    }
    return device as AgentDevice;
  }

  async getScreenshot(signal?: AbortSignal): Promise<AgentFrame> {
    const device = await this.getDevice(signal);
    if (!device.screen) {
      throw new ScreenHandAgentClientError(
        "FRAME_UNAVAILABLE",
        "The device does not currently have a camera frame.",
      );
    }
    const response = await this.fetchImplementation(this.url(
      `/api/v1/devices/${encodeURIComponent(this.deviceId)}/screenshot`,
    ), { signal, cache: "no-store" });
    if (!response.ok) throw await responseError(response);
    const rawBytes = Buffer.from(await response.arrayBuffer());
    const sequence = positiveIntegerHeader(response, "x-screenhand-frame-sequence");
    const rawWidth = positiveIntegerHeader(response, "x-screenhand-frame-width");
    const rawHeight = positiveIntegerHeader(response, "x-screenhand-frame-height");
    const capturedAt = positiveIntegerHeader(response, "x-screenhand-captured-at");
    const geometry = normalizeGeometry(device.screen, rawWidth, rawHeight);
    const rendered = await renderModelScreenFrame(rawBytes, geometry, 1_024);
    const originalMimeType = normalizeImageMime(response.headers.get("content-type"));
    return {
      bytes: rendered.bytes,
      mimeType: rendered.bytes === rawBytes ? originalMimeType : "image/jpeg",
      width: rendered.logicalWidth,
      height: rendered.logicalHeight,
      capturedAt,
      sequence,
    };
  }

  async getCalibration(signal?: AbortSignal): Promise<ScreenHandCalibrationProfile | null> {
    const payload = record(await this.json(
      `/api/v1/devices/${encodeURIComponent(this.deviceId)}/calibration`,
      { signal },
    ));
    const calibration = record(payload.calibration);
    if (!calibration.active) return null;
    return parseScreenHandCalibrationProfile(calibration.active);
  }

  async waitForNewScreenshot(
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentFrame> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError(signal);
      try {
        const frame = await this.getScreenshot(signal);
        if (frame.sequence > afterSequence) return frame;
      } catch (error) {
        lastError = error;
      }
      await sleep(90, signal);
    }
    throw new ScreenHandAgentClientError(
      "FRAME_WAIT_TIMEOUT",
      `No camera frame newer than ${afterSequence} arrived within ${timeoutMs} ms.`,
      lastError,
    );
  }

  async executeAction(
    action: ScreenHandSemanticAction,
    signal?: AbortSignal,
    options: ExecuteActionOptions = {},
  ): Promise<AgentActionResult> {
    const startedAt = performance.now();
    const response = await this.json(
      `/api/v1/devices/${encodeURIComponent(this.deviceId)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: options.idempotencyKey ?? `general-agent-${randomUUID()}`,
          action,
        }),
        signal,
      },
    );
    const result = record(record(response).result);
    let receipt = normalizeReceipt(result.receipt);
    const deadline = Date.now() + this.receiptTimeoutMs;
    while (!isFinalReceipt(receipt) && Date.now() < deadline) {
      const waitMs = Math.min(1_000, Math.max(1, deadline - Date.now()));
      const payload = await this.json(
        `/api/v1/devices/${encodeURIComponent(this.deviceId)}/actions/` +
          `${encodeURIComponent(receipt.id)}?waitMs=${waitMs}`,
        { signal },
      );
      receipt = normalizeReceipt(record(payload).receipt);
    }
    if (!isFinalReceipt(receipt)) {
      throw new ScreenHandAgentClientError(
        "ACTION_RECEIPT_TIMEOUT",
        `Action ${receipt.id} did not finish within ${this.receiptTimeoutMs} ms.`,
      );
    }
    if (receipt.status === "failed") {
      throw new ScreenHandAgentClientError(
        "ACTION_FAILED",
        receipt.error || `Physical action ${receipt.id} failed.`,
      );
    }
    return {
      receipt,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      response,
    };
  }

  private async json(path: string, init: RequestInit = {}) {
    const response = await this.fetchImplementation(
      this.url(path),
      { ...init, cache: "no-store" },
    );
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<unknown>;
  }

  private url(path: string) {
    return new URL(path.replace(/^\//, ""), this.baseUrl);
  }
}

export class ScreenHandAgentClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

function normalizeGeometry(
  screen: AgentDevice["screen"] & {},
  rawWidth: number,
  rawHeight: number,
): PublicFrameGeometry {
  const imagePoints = Array.isArray(screen.imagePoints) && screen.imagePoints.length === 4
    ? screen.imagePoints
    : null;
  return {
    width: positiveNumber(screen.width, rawWidth),
    height: positiveNumber(screen.height, rawHeight),
    rawWidth,
    rawHeight,
    rectified: screen.rectified === true && imagePoints !== null,
    imagePoints,
    calibrationId: typeof screen.calibrationId === "string" ? screen.calibrationId : null,
  };
}

function normalizeReceipt(value: unknown): ActionReceipt {
  const receipt = record(value);
  const status = String(receipt.status ?? "");
  if (
    typeof receipt.id !== "string" || !receipt.id ||
    !["accepted", "executing", "completed", "failed"].includes(status)
  ) {
    throw new ScreenHandAgentClientError(
      "ACTION_RECEIPT_INVALID",
      "The control plane returned an invalid action receipt.",
    );
  }
  return receipt as ActionReceipt;
}

function isFinalReceipt(receipt: ActionReceipt) {
  return receipt.status === "completed" || receipt.status === "failed";
}

async function responseError(response: Response) {
  let payload: Record<string, unknown> = {};
  try {
    payload = record(await response.json());
  } catch {
    // A non-JSON reverse proxy error still becomes a bounded client error.
  }
  return new ScreenHandAgentClientError(
    typeof payload.code === "string" ? payload.code : `HTTP_${response.status}`,
    typeof payload.error === "string"
      ? payload.error
      : `ScreenHand API request failed with HTTP ${response.status}.`,
  );
}

function positiveIntegerHeader(response: Response, name: string) {
  const legacyName = name.replace("x-screenhand-", "x-phonebase-");
  const value = Number(
    response.headers.get(name) ?? response.headers.get(legacyName),
  );
  if (!Number.isInteger(value) || value < 1) {
    throw new ScreenHandAgentClientError(
      "FRAME_METADATA_INVALID",
      `Screenshot response is missing a valid ${name} header.`,
    );
  }
  return value;
}

function normalizeImageMime(value: string | null): AgentFrame["mimeType"] {
  const mime = value?.split(";")[0].trim().toLocaleLowerCase("en-US");
  if (mime === "image/png" || mime === "image/webp") return mime;
  return "image/jpeg";
}

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The general agent run was aborted.");
}
