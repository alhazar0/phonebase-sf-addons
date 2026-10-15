import WebSocket from "ws";

import type { PublicFrameGeometry } from "../frame-geometry";
import { renderModelScreenFrame } from "../rectify-frame";
import type { AgentFrame } from "../screen-observer";

export type LiveFrameMetadata = PublicFrameGeometry & {
  type: "frame";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  capturedAt: number;
  source: string;
  role: "control" | "verification";
  sequence: number;
  deviceId?: string;
};

export type RealtimeFramePacket = {
  metadata: LiveFrameMetadata;
  bytes: Buffer;
  receivedAt: number;
  transportLatencyMs: number;
};

export type RealtimeFrameHubOptions = {
  deviceId: string;
  controlPlaneUrl?: string;
  socketUrl?: string;
  connectTimeoutMs?: number;
  modelLongEdge?: number;
  onFrame?: (packet: RealtimeFramePacket) => void;
};

type FrameWaiter = {
  afterSequence: number;
  resolve: (packet: RealtimeFramePacket) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
};

export class RealtimeFrameHub {
  private socket: WebSocket | null = null;
  private pendingMetadata: LiveFrameMetadata | null = null;
  private current: RealtimeFramePacket | null = null;
  private readonly waiters = new Set<FrameWaiter>();
  private rendered:
    | { sequence: number; maximumLongEdge: number; promise: Promise<AgentFrame> }
    | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: RealtimeFrameHubOptions) {}

  async start(signal?: AbortSignal) {
    if (this.started) {
      if (this.current) return this.current;
      return this.waitForFrame(0, this.options.connectTimeoutMs ?? 5_000, signal);
    }
    this.started = true;
    const url = this.options.socketUrl ?? liveSocketUrl(
      this.options.controlPlaneUrl ?? "http://127.0.0.1:3013",
      this.options.deviceId,
    );
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    socket.once("close", (code, reason) => {
      if (this.closed) return;
      this.closed = true;
      this.rejectWaiters(new Error(
        `Realtime camera stream closed (${code}): ${reason.toString() || "no reason"}`,
      ));
    });
    socket.once("error", (error) => {
      if (this.current) return;
      this.rejectWaiters(new Error(`Realtime camera stream failed: ${error.message}`, {
        cause: error,
      }));
    });
    return this.waitForFrame(0, this.options.connectTimeoutMs ?? 5_000, signal);
  }

  latest() {
    return this.current;
  }

  async latestModelFrame(maximumLongEdge = this.options.modelLongEdge ?? 1_024) {
    const packet = this.requireLatest();
    if (
      this.rendered?.sequence === packet.metadata.sequence &&
      this.rendered.maximumLongEdge === maximumLongEdge
    ) {
      return this.rendered.promise;
    }
    const promise = renderPacket(packet, maximumLongEdge);
    this.rendered = {
      sequence: packet.metadata.sequence,
      maximumLongEdge,
      promise,
    };
    return promise;
  }

  async waitForModelFrame(
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
    maximumLongEdge = this.options.modelLongEdge ?? 1_024,
  ) {
    await this.waitForFrame(afterSequence, timeoutMs, signal);
    return this.latestModelFrame(maximumLongEdge);
  }

  waitForFrame(afterSequence: number, timeoutMs: number, signal?: AbortSignal) {
    if (this.current && this.current.metadata.sequence > afterSequence) {
      return Promise.resolve(this.current);
    }
    if (this.closed) {
      return Promise.reject(new Error("Realtime camera stream is closed."));
    }
    return new Promise<RealtimeFramePacket>((resolveWaiter, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        reject(abortError(signal));
      };
      const waiter: FrameWaiter = {
        afterSequence,
        resolve: resolveWaiter,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          waiter.removeAbortListener();
          reject(new Error(
            `No camera frame newer than ${afterSequence} arrived within ${timeoutMs} ms.`,
          ));
        }, timeoutMs),
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close(1000, "realtime runtime stopped");
    this.rejectWaiters(new Error("Realtime camera stream stopped."));
  }

  private requireLatest() {
    if (!this.current) throw new Error("Realtime camera stream has not produced a frame yet.");
    return this.current;
  }

  private handleMessage(data: WebSocket.RawData, isBinary: boolean) {
    if (!isBinary) {
      try {
        const metadata = JSON.parse(data.toString()) as Partial<LiveFrameMetadata>;
        if (validMetadata(metadata, this.options.deviceId)) {
          this.pendingMetadata = metadata;
        }
      } catch {
        this.pendingMetadata = null;
      }
      return;
    }
    const metadata = this.pendingMetadata;
    this.pendingMetadata = null;
    if (!metadata) return;
    const bytes = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as ArrayBuffer);
    if (bytes.length !== metadata.byteLength) return;
    if (this.current && metadata.sequence <= this.current.metadata.sequence) return;
    const receivedAt = Date.now();
    this.current = {
      metadata,
      bytes,
      receivedAt,
      transportLatencyMs: Math.max(0, receivedAt - metadata.capturedAt),
    };
    try {
      this.options.onFrame?.(this.current);
    } catch {
      // Telemetry must never interrupt the camera hot path.
    }
    this.rendered = null;
    for (const waiter of [...this.waiters]) {
      if (metadata.sequence <= waiter.afterSequence) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.removeAbortListener();
      waiter.resolve(this.current);
    }
  }

  private rejectWaiters(error: Error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.removeAbortListener();
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

async function renderPacket(packet: RealtimeFramePacket, maximumLongEdge: number) {
  const metadata = packet.metadata;
  const rendered = await renderModelScreenFrame(packet.bytes, {
    width: metadata.width,
    height: metadata.height,
    rawWidth: metadata.rawWidth,
    rawHeight: metadata.rawHeight,
    rectified: metadata.rectified,
    imagePoints: metadata.imagePoints,
    calibrationId: metadata.calibrationId,
  }, maximumLongEdge);
  return {
    bytes: rendered.bytes,
    mimeType: "image/jpeg" as const,
    width: rendered.logicalWidth,
    height: rendered.logicalHeight,
    sequence: metadata.sequence,
    capturedAt: metadata.capturedAt,
  };
}

function liveSocketUrl(controlPlaneUrl: string, deviceId: string) {
  const url = new URL(controlPlaneUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/live/socket";
  url.search = new URLSearchParams({ deviceId }).toString();
  return url.href;
}

function validMetadata(
  value: Partial<LiveFrameMetadata>,
  expectedDeviceId: string,
): value is LiveFrameMetadata {
  return value.type === "frame" &&
    Number.isInteger(value.sequence) && Number(value.sequence) > 0 &&
    Number.isInteger(value.byteLength) && Number(value.byteLength) > 0 &&
    Number.isFinite(value.capturedAt) &&
    Number.isFinite(value.width) && Number.isFinite(value.height) &&
    Number.isFinite(value.rawWidth) && Number.isFinite(value.rawHeight) &&
    ["image/jpeg", "image/png", "image/webp"].includes(String(value.mimeType)) &&
    (!value.deviceId || value.deviceId === expectedDeviceId);
}

function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The frame wait was aborted.", "AbortError");
}
