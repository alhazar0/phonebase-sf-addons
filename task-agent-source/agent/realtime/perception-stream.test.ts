import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenObservation } from "../general-agent-contract";
import { LatencyRecorder } from "./latency-recorder";
import {
  RealtimePerceptionStream,
  type RealtimeFrameCursorSource,
} from "./perception-stream";

type FixtureWaiter = {
  after: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

test("continuous perception drops stale camera frames and catches the latest state", async () => {
  const frames = new FixtureFrames();
  const observed: number[] = [];
  const stream = new RealtimePerceptionStream(
    frames,
    {
      observeLatest: async () => {
        await delay(18);
        const sequence = frames.latest()?.metadata.sequence ?? 0;
        observed.push(sequence);
        return state(sequence);
      },
    },
    new LatencyRecorder(),
    { minimumIntervalMs: 5, frameWaitTimeoutMs: 50 },
  );
  stream.start();
  try {
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      frames.push(sequence);
      await delay(2);
    }
    await waitFor(() => stream.summary().lastObservedSequence === 20, 1_000);
    const summary = await stream.stop();
    assert.equal(summary.error, undefined);
    assert.equal(summary.lastSeenSequence, 20);
    assert.equal(summary.lastObservedSequence, 20);
    assert.ok(summary.skippedFrames > 0);
    assert.ok(summary.observations < 10, `observed obsolete backlog: ${observed.join(",")}`);
    assert.equal(summary.running, false);
  } finally {
    if (stream.summary().running) await stream.stop();
  }
});

test("continuous perception treats idle frame timeouts as normal", async () => {
  const frames = new FixtureFrames();
  const stream = new RealtimePerceptionStream(
    frames,
    { observeLatest: async () => state(0) },
    new LatencyRecorder(),
    { frameWaitTimeoutMs: 50 },
  );
  stream.start();
  await waitFor(() => stream.summary().waitTimeouts >= 1, 500);
  const summary = await stream.stop();
  assert.ok(summary.waitTimeouts >= 1);
  assert.equal(summary.error, undefined);
});

class FixtureFrames implements RealtimeFrameCursorSource {
  private sequence = 0;
  private readonly waiters = new Set<FixtureWaiter>();

  latest() {
    return this.sequence > 0 ? { metadata: { sequence: this.sequence } } : null;
  }

  push(sequence: number) {
    this.sequence = sequence;
    for (const waiter of [...this.waiters]) {
      if (sequence <= waiter.after) continue;
      this.finish(waiter);
      waiter.resolve();
    }
  }

  waitForFrame(after: number, timeoutMs: number, signal?: AbortSignal) {
    if (this.sequence > after) return Promise.resolve({});
    return new Promise<unknown>((resolve, reject) => {
      const waiter = {
        after,
        resolve: () => resolve({}),
        reject,
        timer: setTimeout(() => {
          this.finish(waiter);
          reject(new Error(`No camera frame newer than ${after} arrived within ${timeoutMs} ms.`));
        }, timeoutMs),
        signal,
        abort: undefined as (() => void) | undefined,
      };
      waiter.abort = () => {
        this.finish(waiter);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.add(waiter);
    });
  }

  private finish(waiter: FixtureWaiter) {
    this.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  }
}

function state(sequence: number) {
  return {
    kind: "unknown" as const,
    confidence: 0.25,
    observation: observation(sequence),
    tokens: [],
    detectedAt: Date.now(),
  };
}

function observation(sequence: number): ScreenObservation {
  return {
    sequence,
    capturedAt: Date.now(),
    viewport: { width: 720, height: 1_560 },
    fingerprint: `frame-${sequence}`,
    changeRatio: 0.1,
    changeKind: "major",
    ocrCacheHit: false,
    ocrElapsedMs: 1,
    observationElapsedMs: 2,
    averageTextConfidence: 0,
    textSignature: new Set(),
    elements: [],
    scene: {
      kind: "unknown",
      confidence: 0.25,
      homeGridScore: 0,
      keyboardVisible: false,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("condition timed out");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
