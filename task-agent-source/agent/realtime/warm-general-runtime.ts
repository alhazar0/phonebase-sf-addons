import { ScreenObserver, type AgentFrame } from "../screen-observer";
import { RealtimeFrameHub } from "./frame-hub";

export type WarmGeneralRuntimeOptions = {
  minimumObservationIntervalMs?: number;
  frameWaitTimeoutMs?: number;
  observer?: SerializedScreenObserver;
  onError?: (error: Error) => void;
};

/** Serializes shared observer access so background and task-time perception
 * can reuse one exact sequence without starting duplicate OCR work. */
export class SerializedScreenObserver extends ScreenObserver {
  private tail: Promise<void> = Promise.resolve();

  override observe(frame: AgentFrame, signal?: AbortSignal) {
    const result = this.tail.then(() => super.observe(frame, signal));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * Keeps one camera stream and one generic screen model warm between tasks.
 * It deliberately drops intermediate video frames: the only useful state for
 * a newly arriving command is the newest stable phone frame.
 */
export class WarmGeneralDeviceRuntime {
  readonly observer: SerializedScreenObserver;
  private readonly controller = new AbortController();
  private readonly minimumObservationIntervalMs: number;
  private readonly frameWaitTimeoutMs: number;
  private readonly onError?: (error: Error) => void;
  private loopPromise: Promise<void> | null = null;
  private started = false;
  private lastObservedSequence = 0;

  constructor(
    readonly frames: RealtimeFrameHub,
    options: WarmGeneralRuntimeOptions = {},
  ) {
    this.observer = options.observer ?? new SerializedScreenObserver({
      ocrMode: "adaptive",
      maximumCacheEntries: 32,
    });
    this.minimumObservationIntervalMs = boundedInteger(
      options.minimumObservationIntervalMs,
      50,
      5_000,
      250,
    );
    this.frameWaitTimeoutMs = boundedInteger(
      options.frameWaitTimeoutMs,
      100,
      30_000,
      1_000,
    );
    this.onError = options.onError;
  }

  async start(connectTimeoutMs = 5_000) {
    if (this.started) return;
    this.started = true;
    await this.frames.start(AbortSignal.timeout(connectTimeoutMs));
    const initial = await this.frames.latestModelFrame();
    await this.observer.observe(initial, this.controller.signal);
    this.lastObservedSequence = initial.sequence;
    this.loopPromise = this.run(this.controller.signal).catch((error) => {
      if (!this.controller.signal.aborted) this.onError?.(asError(error));
    });
  }

  summary() {
    return {
      started: this.started,
      running: this.loopPromise !== null && !this.controller.signal.aborted,
      lastObservedSequence: this.lastObservedSequence,
    };
  }

  async stop() {
    this.controller.abort(new Error("Warm generic perception stopped."));
    this.frames.close();
    await this.loopPromise;
  }

  private async run(signal: AbortSignal) {
    let lastObservationAt = performance.now();
    let cursor = this.lastObservedSequence;
    while (!signal.aborted) {
      try {
        await this.frames.waitForFrame(cursor, this.frameWaitTimeoutMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (isFrameTimeout(error)) continue;
        throw error;
      }
      cursor = Math.max(cursor, this.frames.latest()?.metadata.sequence ?? cursor);
      const remaining = Math.max(
        0,
        this.minimumObservationIntervalMs - (performance.now() - lastObservationAt),
      );
      if (remaining > 0 && !await delay(remaining, signal)) return;

      const frame = await this.frames.latestModelFrame();
      cursor = Math.max(cursor, frame.sequence);
      await this.observer.observe(frame, signal);
      this.lastObservedSequence = frame.sequence;
      lastObservationAt = performance.now();
    }
  }
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

function isFrameTimeout(error: unknown) {
  return error instanceof Error && /No camera frame newer than .* arrived within/u.test(
    error.message,
  );
}

function delay(ms: number, signal: AbortSignal) {
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

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
