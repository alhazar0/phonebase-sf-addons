import type { RuntimeScreenState } from "./screen-state";
import type { LatencyRecorder } from "./latency-recorder";

export type RealtimeFrameCursorSource = {
  latest(): { metadata: { sequence: number } } | null;
  waitForFrame(
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

export type RealtimePerceptionSource = {
  observeLatest(options?: { decisionEvidence?: boolean }): Promise<RuntimeScreenState>;
};

export type RealtimePerceptionStreamOptions = {
  minimumIntervalMs?: number;
  frameWaitTimeoutMs?: number;
};

export type RealtimePerceptionStreamSummary = {
  observations: number;
  skippedFrames: number;
  lastSeenSequence: number;
  lastObservedSequence: number;
  waitTimeouts: number;
  running: boolean;
  error?: string;
};

/**
 * Keeps perception warm while the motor or phone animation is running.
 *
 * The loop deliberately consumes the latest frame instead of queueing every
 * camera frame. A slow OCR pass therefore drops obsolete intermediate frames
 * and catches up to the newest state, which bounds latency and memory usage.
 */
export class RealtimePerceptionStream {
  private readonly minimumIntervalMs: number;
  private readonly frameWaitTimeoutMs: number;
  private controller: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private removeParentAbort: (() => void) | null = null;
  private observations = 0;
  private skippedFrames = 0;
  private lastSeenSequence = 0;
  private lastObservedSequence = 0;
  private waitTimeouts = 0;
  private lastError: string | undefined;

  constructor(
    private readonly frames: RealtimeFrameCursorSource,
    private readonly perception: RealtimePerceptionSource,
    private readonly metrics: LatencyRecorder,
    options: RealtimePerceptionStreamOptions = {},
  ) {
    this.minimumIntervalMs = boundedInteger(
      options.minimumIntervalMs,
      0,
      5_000,
      400,
    );
    this.frameWaitTimeoutMs = boundedInteger(
      options.frameWaitTimeoutMs,
      50,
      30_000,
      1_000,
    );
  }

  start(parentSignal?: AbortSignal) {
    if (this.runPromise) return;
    const controller = new AbortController();
    this.controller = controller;
    if (parentSignal) {
      const onAbort = () => controller.abort(parentSignal.reason);
      if (parentSignal.aborted) onAbort();
      else parentSignal.addEventListener("abort", onAbort, { once: true });
      this.removeParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
    }
    this.runPromise = this.run(controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        this.lastError = errorMessage(error);
        this.metrics.record("perception_stream", "continuous-error", 0, {
          error: this.lastError,
        });
      }
    });
  }

  async stop() {
    this.controller?.abort(new Error("Continuous perception stopped."));
    await this.runPromise;
    this.removeParentAbort?.();
    this.removeParentAbort = null;
    this.controller = null;
    this.runPromise = null;
    return this.summary();
  }

  summary(): RealtimePerceptionStreamSummary {
    return {
      observations: this.observations,
      skippedFrames: this.skippedFrames,
      lastSeenSequence: this.lastSeenSequence,
      lastObservedSequence: this.lastObservedSequence,
      waitTimeouts: this.waitTimeouts,
      running: this.runPromise !== null && this.controller?.signal.aborted !== true,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private async run(signal: AbortSignal) {
    this.lastSeenSequence = this.frames.latest()?.metadata.sequence ?? 0;
    let lastObservationAt = Number.NEGATIVE_INFINITY;
    while (!signal.aborted) {
      try {
        await this.frames.waitForFrame(
          this.lastSeenSequence,
          this.frameWaitTimeoutMs,
          signal,
        );
      } catch (error) {
        if (signal.aborted) return;
        if (isFrameWaitTimeout(error)) {
          this.waitTimeouts += 1;
          continue;
        }
        throw error;
      }
      const latestSequence = this.frames.latest()?.metadata.sequence ?? this.lastSeenSequence;
      if (latestSequence <= this.lastSeenSequence) continue;
      this.skippedFrames += Math.max(0, latestSequence - this.lastSeenSequence - 1);
      this.lastSeenSequence = latestSequence;

      const remainingIntervalMs = Math.max(
        0,
        this.minimumIntervalMs - (performance.now() - lastObservationAt),
      );
      if (
        remainingIntervalMs > 0 &&
        !await abortableDelay(remainingIntervalMs, signal)
      ) return;

      // Frames can continue to arrive while the throttle is waiting. Consume
      // only the newest one, but do not lose the final frame in a burst.
      const postThrottleSequence = this.frames.latest()?.metadata.sequence
        ?? this.lastSeenSequence;
      if (postThrottleSequence > this.lastSeenSequence) {
        this.skippedFrames += postThrottleSequence - this.lastSeenSequence;
        this.lastSeenSequence = postThrottleSequence;
      }

      const startedAt = performance.now();
      const state = await this.perception.observeLatest({ decisionEvidence: false });
      const durationMs = performance.now() - startedAt;
      lastObservationAt = performance.now();
      this.observations += 1;
      if (state.observation.sequence > this.lastSeenSequence) {
        this.skippedFrames += state.observation.sequence - this.lastSeenSequence;
        this.lastSeenSequence = state.observation.sequence;
      }
      this.lastObservedSequence = Math.max(
        this.lastObservedSequence,
        state.observation.sequence,
      );
      this.metrics.record("perception_stream", "continuous-observe", durationMs, {
        sequence: state.observation.sequence,
        screenKind: state.kind,
      });
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isFrameWaitTimeout(error: unknown) {
  return error instanceof Error && /No camera frame newer than .* arrived within/u.test(
    error.message,
  );
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
