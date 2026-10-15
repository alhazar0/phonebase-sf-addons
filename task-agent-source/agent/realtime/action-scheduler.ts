import { randomUUID } from "node:crypto";

import type { ScreenHandSemanticAction } from "../action-contract";
import type {
  AgentActionResult,
  GeneralAgentDeviceClient,
} from "../general-agent-client";
import type { AgentFrame } from "../screen-observer";
import type { RealtimeFrameHub } from "./frame-hub";
import type { LatencyRecorder } from "./latency-recorder";
import {
  VisualProbe,
  type NormalizedRegion,
} from "./visual-probe";
import {
  assertRealtimePhoneKeyAllowed,
  assertRealtimeTapAllowed,
  assertRealtimeTextInputAllowed,
  type RealtimeActionPolicy,
} from "./action-safety";

export type NormalizedPoint = { x: number; y: number };

export type RealtimeActionLifecycleEvent = {
  executionId: string;
  label: string;
  action: ScreenHandSemanticAction;
  startedAt: number;
};

export type RealtimeActionLifecycle = {
  onStarted?: (event: RealtimeActionLifecycleEvent) => void;
  onCompleted?: (
    event: RealtimeActionLifecycleEvent & {
      completedAt: number;
      result: AgentActionResult;
    },
  ) => void;
  onFailed?: (
    event: RealtimeActionLifecycleEvent & {
      completedAt: number;
      error: unknown;
    },
  ) => void;
};

export class RealtimeActionScheduler {
  readonly probe = new VisualProbe();

  constructor(
    private readonly client: GeneralAgentDeviceClient,
    private readonly frames: RealtimeFrameHub,
    private readonly metrics: LatencyRecorder,
    private readonly policy?: RealtimeActionPolicy,
    private readonly lifecycle?: RealtimeActionLifecycle,
  ) {}

  latestFrame() {
    return this.frames.latestModelFrame();
  }

  async tap(point: NormalizedPoint, label: string, durationMs = 90, signal?: AbortSignal) {
    assertRealtimeTapAllowed(this.policy, point, label);
    const before = await this.frames.latestModelFrame();
    const action: ScreenHandSemanticAction = {
      type: "tap",
      point: screenPoint(point, before),
      viewport: { width: before.width, height: before.height },
      frameSequence: before.sequence,
      durationMs,
    };
    const result = await this.execute(action, label, signal);
    return { before, result };
  }

  async swipe(
    start: NormalizedPoint,
    end: NormalizedPoint,
    label: string,
    durationMs = 420,
    signal?: AbortSignal,
  ) {
    const before = await this.frames.latestModelFrame();
    const action: ScreenHandSemanticAction = {
      type: "swipe",
      start: screenPoint(start, before),
      end: screenPoint(end, before),
      viewport: { width: before.width, height: before.height },
      frameSequence: before.sequence,
      durationMs,
    };
    const result = await this.execute(action, label, signal);
    return { before, result };
  }

  inputText(text: string, label = "input-text", signal?: AbortSignal) {
    assertRealtimeTextInputAllowed(this.policy, label);
    return this.execute({ type: "input_text", text }, label, signal);
  }

  phoneKey(key: "back" | "home" | "enter", label = `phone-${key}`, signal?: AbortSignal) {
    assertRealtimePhoneKeyAllowed(this.policy, key, label);
    return this.execute({ type: "phone_key", key }, label, signal);
  }

  async waitForChange(
    before: AgentFrame,
    region: NormalizedRegion,
    options: { threshold?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const threshold = options.threshold ?? 0.035;
    const timeoutMs = options.timeoutMs ?? 2_500;
    return this.metrics.measure("phone_animation", "wait-for-roi-change", async () => {
      const deadline = Date.now() + timeoutMs;
      let sequence = before.sequence;
      while (Date.now() < deadline) {
        const current = this.frames.latest();
        if (!current || current.metadata.sequence <= sequence) {
          try {
            await this.frames.waitForFrame(
              sequence,
              Math.max(50, deadline - Date.now()),
              options.signal,
            );
          } catch (error) {
            if (Date.now() >= deadline) break;
            throw error;
          }
        }
        const after = await this.frames.latestModelFrame();
        sequence = after.sequence;
        const difference = await this.metrics.measure(
          "verification",
          "roi-difference",
          () => this.probe.difference(before, after, region),
          { sequence: after.sequence, threshold },
        );
        if (difference >= threshold) {
          this.metrics.markDecisionEvidence("verified-roi-change", {
            sequence: after.sequence,
            difference,
            threshold,
          });
          return { frame: after, difference };
        }
      }
      throw new Error(`Visual region did not change by ${threshold} within ${timeoutMs} ms.`);
    }, { beforeSequence: before.sequence, threshold, timeoutMs });
  }

  async waitForRedState(
    expectedRed: boolean,
    region: NormalizedRegion,
    options: { threshold?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const threshold = options.threshold ?? 0.018;
    return this.waitForRedFraction(
      region,
      (fraction) => expectedRed ? fraction >= threshold : fraction < threshold,
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        detail: { expectedRed, threshold },
      },
    );
  }

  async latestRedFraction(region: NormalizedRegion) {
    const frame = await this.frames.latestModelFrame();
    return this.metrics.measure(
      "verification",
      "roi-red-fraction",
      () => this.probe.redFraction(frame, region),
      { sequence: frame.sequence },
    );
  }

  async waitForRedFraction(
    region: NormalizedRegion,
    predicate: (fraction: number) => boolean,
    options: {
      timeoutMs?: number;
      afterSequence?: number;
      signal?: AbortSignal;
      detail?: Record<string, unknown>;
    } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 2_500;
    return this.metrics.measure("phone_animation", "wait-for-roi-red-state", async () => {
      const deadline = Date.now() + timeoutMs;
      let sequence = options.afterSequence ?? 0;
      while (Date.now() < deadline) {
        const latest = this.frames.latest();
        if (!latest || latest.metadata.sequence <= sequence) {
          try {
            await this.frames.waitForFrame(
              sequence,
              Math.max(50, deadline - Date.now()),
              options.signal,
            );
          } catch (error) {
            if (Date.now() >= deadline) break;
            throw error;
          }
        }
        const frame = await this.frames.latestModelFrame();
        sequence = frame.sequence;
        const fraction = await this.metrics.measure(
          "verification",
          "roi-red-fraction",
          () => this.probe.redFraction(frame, region),
          { sequence, ...options.detail },
        );
        const matched = this.metrics.measureSync(
          "verification",
          "roi-red-predicate",
          () => predicate(fraction),
          { sequence, fraction, ...options.detail },
        );
        if (matched) {
          this.metrics.markDecisionEvidence("verified-roi-red-state", {
            sequence,
            fraction,
            ...options.detail,
          });
          return { frame, fraction };
        }
      }
      throw new Error(`Red visual state did not reach the requested condition within ${timeoutMs} ms.`);
    }, { afterSequence: options.afterSequence ?? 0, timeoutMs, ...options.detail });
  }

  async waitForStableRedIncrease(
    region: NormalizedRegion,
    beforeFraction: number,
    options: {
      minimumFraction?: number;
      minimumIncrease?: number;
      consecutiveFrames?: number;
      timeoutMs?: number;
      afterSequence?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const minimumFraction = options.minimumFraction ?? 0.02;
    const minimumIncrease = options.minimumIncrease ?? 0.008;
    const consecutiveFrames = options.consecutiveFrames ?? 2;
    const timeoutMs = options.timeoutMs ?? 2_000;
    return this.metrics.measure("phone_animation", "wait-for-stable-red-increase", async () => {
      const deadline = Date.now() + timeoutMs;
      let sequence = options.afterSequence ?? 0;
      let consecutive = 0;
      let bestFraction = 0;
      while (Date.now() < deadline) {
        const latest = this.frames.latest();
        if (!latest || latest.metadata.sequence <= sequence) {
          try {
            await this.frames.waitForFrame(
              sequence,
              Math.max(50, deadline - Date.now()),
              options.signal,
            );
          } catch (error) {
            if (Date.now() >= deadline) break;
            throw error;
          }
        }
        const frame = await this.frames.latestModelFrame();
        sequence = frame.sequence;
        const fraction = await this.metrics.measure(
          "verification",
          "roi-red-fraction",
          () => this.probe.redFraction(frame, region),
          { sequence },
        );
        bestFraction = Math.max(bestFraction, fraction);
        if (
          fraction >= minimumFraction &&
          fraction >= beforeFraction + minimumIncrease
        ) {
          consecutive += 1;
          if (consecutive >= consecutiveFrames) {
            this.metrics.markDecisionEvidence("verified-stable-red-increase", {
              sequence,
              fraction,
              beforeFraction,
              minimumFraction,
              minimumIncrease,
              consecutiveFrames,
            });
            return { frame, fraction, bestFraction };
          }
        } else {
          consecutive = 0;
        }
      }
      throw new Error(
        `Red visual state did not remain active for ${consecutiveFrames} frames within ` +
        `${timeoutMs} ms (before=${beforeFraction.toFixed(4)}, best=${bestFraction.toFixed(4)}).`,
      );
    }, {
      afterSequence: options.afterSequence ?? 0,
      timeoutMs,
      beforeFraction,
      minimumFraction,
      minimumIncrease,
      consecutiveFrames,
    });
  }

  private execute(action: ScreenHandSemanticAction, label: string, signal?: AbortSignal) {
    this.metrics.recordDecision(`decision:${label}`, { actionType: action.type });
    const lifecycleEvent: RealtimeActionLifecycleEvent = {
      executionId: `action-${randomUUID()}`,
      label,
      action,
      startedAt: Date.now(),
    };
    this.notifyLifecycle("onStarted", lifecycleEvent);
    return this.metrics.measure("action", label, async () => {
      try {
        const result = await this.client.executeAction(action, signal, {
          idempotencyKey: lifecycleEvent.executionId,
        });
        if (result.receipt.status !== "completed") {
          throw new Error(`Action ${label} finished as ${result.receipt.status}.`);
        }
        this.metrics.recordSample(
          "physical_motion",
          label,
          receiptMotionMs(result),
          {
            executionId: lifecycleEvent.executionId,
            receiptId: result.receipt.id,
            actionType: action.type,
            clientElapsedMs: result.elapsedMs,
          },
        );
        this.notifyLifecycle("onCompleted", {
          ...lifecycleEvent,
          completedAt: Date.now(),
          result,
        });
        return result;
      } catch (error) {
        this.notifyLifecycle("onFailed", {
          ...lifecycleEvent,
          completedAt: Date.now(),
          error,
        });
        throw error;
      }
    }, { executionId: lifecycleEvent.executionId, actionType: action.type, action });
  }

  private notifyLifecycle(
    name: keyof RealtimeActionLifecycle,
    event: RealtimeActionLifecycleEvent & {
      completedAt?: number;
      result?: AgentActionResult;
      error?: unknown;
    },
  ) {
    try {
      const callback = this.lifecycle?.[name] as ((value: typeof event) => void) | undefined;
      callback?.(event);
    } catch (error) {
      this.metrics.record("memory", "active-world-lifecycle-error", 0, {
        hook: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function screenPoint(point: NormalizedPoint, frame: AgentFrame) {
  return {
    x: Math.round(point.x * frame.width * 10) / 10,
    y: Math.round(point.y * frame.height * 10) / 10,
  };
}

function receiptMotionMs(result: AgentActionResult) {
  const receipt = result.receipt;
  const elapsed = Number(receipt.elapsedMs ?? receipt.durationMs);
  if (Number.isFinite(elapsed) && elapsed >= 0) return elapsed;
  if (
    Number.isFinite(receipt.createdAt) &&
    Number.isFinite(receipt.completedAt) &&
    Number(receipt.completedAt) >= Number(receipt.createdAt)
  ) {
    return Number(receipt.completedAt) - Number(receipt.createdAt);
  }
  return result.elapsedMs;
}
