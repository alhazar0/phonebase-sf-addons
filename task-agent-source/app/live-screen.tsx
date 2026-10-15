"use client";

import { useEffect, useRef } from "react";

export type ScreenPoint = { x: number; y: number };

export type LiveFrame = {
  type: "frame";
  width: number;
  height: number;
  rawWidth: number;
  rawHeight: number;
  capturedAt: number;
  source: string;
  role?: "control" | "verification";
  sequence: number;
  deviceId?: string;
  rectified: boolean;
  imagePoints: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] | null;
  calibrationId: string | null;
  mimeType: string;
  byteLength: number;
};

type Matrix = [number, number, number, number, number, number, number, number, number];

function solve(rows: number[][]): number[] {
  const size = rows.length;
  const matrix = rows.map((row) => [...row]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot][column]) < 1e-10) {
      throw new Error("Invalid screen calibration");
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const scale = matrix[column][column];
    for (let item = column; item <= size; item += 1) {
      matrix[column][item] /= scale;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let item = column; item <= size; item += 1) {
        matrix[row][item] -= factor * matrix[column][item];
      }
    }
  }
  return matrix.map((row) => row[size]);
}

function homography(source: ScreenPoint[], destination: ScreenPoint[]): Matrix {
  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = destination[index];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const value = solve(rows);
  return [value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7], 1];
}

function project(matrix: Matrix, point: ScreenPoint): ScreenPoint {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function drawTriangle(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  source: [ScreenPoint, ScreenPoint, ScreenPoint],
  destination: [ScreenPoint, ScreenPoint, ScreenPoint],
) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const denominator =
    s0.x * (s1.y - s2.y) +
    s1.x * (s2.y - s0.y) +
    s2.x * (s0.y - s1.y);
  if (Math.abs(denominator) < 1e-8) return;

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator;
  const e = (
    d0.x * (s1.x * s2.y - s2.x * s1.y) +
    d1.x * (s2.x * s0.y - s0.x * s2.y) +
    d2.x * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;
  const f = (
    d0.y * (s1.x * s2.y - s2.x * s1.y) +
    d1.y * (s2.x * s0.y - s0.x * s2.y) +
    d2.y * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;

  context.save();
  context.beginPath();
  context.moveTo(d0.x, d0.y);
  context.lineTo(d1.x, d1.y);
  context.lineTo(d2.x, d2.y);
  context.closePath();
  context.clip();
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}

function drawFrame(
  canvas: HTMLCanvasElement,
  image: ImageBitmap,
  metadata: LiveFrame,
) {
  canvas.width = metadata.width;
  canvas.height = metadata.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#050608";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (!metadata.rectified || !metadata.imagePoints) {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return;
  }

  const outputCorners: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] = [
    { x: 0, y: 0 },
    { x: canvas.width, y: 0 },
    { x: canvas.width, y: canvas.height },
    { x: 0, y: canvas.height },
  ];
  const outputToCamera = homography(outputCorners, metadata.imagePoints);
  // A denser mesh reduces visible triangle seams and keeps small text sharper
  // after the camera's four-point perspective correction.
  const columns = 24;
  const rows = 40;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = (column / columns) * canvas.width;
      const right = ((column + 1) / columns) * canvas.width;
      const top = (row / rows) * canvas.height;
      const bottom = ((row + 1) / rows) * canvas.height;
      const d00 = { x: left, y: top };
      const d10 = { x: right, y: top };
      const d11 = { x: right, y: bottom };
      const d01 = { x: left, y: bottom };
      const s00 = project(outputToCamera, d00);
      const s10 = project(outputToCamera, d10);
      const s11 = project(outputToCamera, d11);
      const s01 = project(outputToCamera, d01);
      drawTriangle(context, image, [s00, s10, s11], [d00, d10, d11]);
      drawTriangle(context, image, [s00, s11, s01], [d00, d11, d01]);
    }
  }
}

export function LiveScreen({
  controlPlaneUrl,
  accessToken = "",
  deviceId,
  raw = false,
  onFrame,
  onConnection,
}: {
  controlPlaneUrl: string;
  accessToken?: string;
  deviceId: string;
  raw?: boolean;
  onFrame: (frame: LiveFrame) => void;
  onConnection: (connected: boolean, detail?: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onFrameRef = useRef(onFrame);
  const onConnectionRef = useRef(onConnection);

  useEffect(() => {
    onFrameRef.current = onFrame;
    onConnectionRef.current = onConnection;
  }, [onFrame, onConnection]);

  useEffect(() => {
    if (!deviceId) return;
    let closed = false;
    let pendingMetadata: LiveFrame | null = null;
    let drawnSequence = 0;
    let decodeActive = false;
    let queuedFrame: { metadata: LiveFrame; bytes: ArrayBuffer } | null = null;
    let lastReportedAt = 0;
    let lastMessageAt = Date.now();
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    const socketUrl = new URL(controlPlaneUrl);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.pathname = "/api/live/socket";
    socketUrl.search = new URLSearchParams({
      deviceId,
      ...(raw ? { raw: "1" } : {}),
      ...(accessToken ? { access_token: accessToken } : {}),
    }).toString();
    const drawLatest = async () => {
      if (decodeActive) return;
      decodeActive = true;
      try {
        while (queuedFrame && !closed) {
          const next = queuedFrame;
          queuedFrame = null;
          if (
            next.metadata.sequence <= drawnSequence ||
            !canvasRef.current
          ) continue;
          const bitmap = await createImageBitmap(
            new Blob([next.bytes], { type: next.metadata.mimeType }),
          );
          if (
            closed ||
            next.metadata.sequence <= drawnSequence ||
            !canvasRef.current
          ) {
            bitmap.close();
            continue;
          }
          drawFrame(canvasRef.current, bitmap, next.metadata);
          bitmap.close();
          drawnSequence = next.metadata.sequence;
          const now = performance.now();
          if (now - lastReportedAt >= 180) {
            lastReportedAt = now;
            onFrameRef.current(next.metadata);
          }
        }
      } catch {
        onConnectionRef.current(false, "Unable to decode camera frame");
      } finally {
        decodeActive = false;
        if (queuedFrame && !closed) void drawLatest();
      }
    };
    const handleMessage = (event: MessageEvent) => {
      lastMessageAt = Date.now();
      if (typeof event.data === "string") {
        try {
          const metadata = JSON.parse(event.data) as LiveFrame;
          if (metadata.type === "frame") pendingMetadata = metadata;
        } catch {
          onConnectionRef.current(false, "Invalid live frame metadata");
        }
        return;
      }
      const metadata = pendingMetadata;
      pendingMetadata = null;
      if (!metadata || metadata.sequence <= drawnSequence || !canvasRef.current) return;
      queuedFrame = { metadata, bytes: event.data as ArrayBuffer };
      void drawLatest();
    };

    const connect = () => {
      if (closed) return;
      pendingMetadata = null;
      lastMessageAt = Date.now();
      socket = new WebSocket(socketUrl);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        lastMessageAt = Date.now();
        onConnectionRef.current(true);
      };
      socket.onerror = () => onConnectionRef.current(false, "Live frame socket failed");
      socket.onmessage = handleMessage;
      socket.onclose = () => {
        if (closed) return;
        onConnectionRef.current(false, "Live frame socket reconnecting");
        reconnectTimer = setTimeout(connect, 900);
      };
    };
    connect();
    watchdogTimer = setInterval(() => {
      if (
        !closed &&
        socket?.readyState === WebSocket.OPEN &&
        Date.now() - lastMessageAt > 4_000
      ) {
        onConnectionRef.current(false, "Live frame socket reconnecting");
        socket.close(4000, "live frame timeout");
      }
    }, 1_000);

    return () => {
      closed = true;
      queuedFrame = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      socket?.close(1000, "screen changed");
    };
  }, [accessToken, controlPlaneUrl, deviceId, raw]);

  return <canvas ref={canvasRef} aria-label="Live calibrated physical phone" />;
}
