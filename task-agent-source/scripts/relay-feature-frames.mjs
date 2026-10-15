#!/usr/bin/env node

import WebSocket from "ws";

const sourceUrl = process.env.SCREENHAND_FRAME_RELAY_SOURCE ??
  "http://127.0.0.1:3013/api/frame?raw=1&deviceId=black-arm-01";
const targetUrl = process.env.SCREENHAND_FRAME_RELAY_TARGET ??
  "http://127.0.0.1:3023/api/frame/jpeg";
const deviceId = process.env.SCREENHAND_FRAME_RELAY_DEVICE_ID ?? "black-arm-01";
const width = positiveInteger(process.env.SCREENHAND_FRAME_RELAY_WIDTH, 720);
const height = positiveInteger(process.env.SCREENHAND_FRAME_RELAY_HEIGHT, 1280);
const reconnectMs = positiveInteger(process.env.SCREENHAND_FRAME_RELAY_RECONNECT_MS, 250);
const sourceSocketUrl = process.env.SCREENHAND_FRAME_RELAY_SOCKET ?? socketUrl(sourceUrl);

let stopped = false;
let lastSourceFrameKey = "";
let lastError = "";
let relayed = 0;
let activeSocket = null;
let pendingFrame = null;
let uploadActive = false;
let uploadPromise = Promise.resolve();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socketUrl(frameUrl) {
  const url = new URL(frameUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/live/socket";
  url.search = "";
  url.searchParams.set("raw", "1");
  url.searchParams.set("deviceId", deviceId);
  return url.toString();
}

async function postFrame(frame) {
  const sourceFrameKey = `${frame.sequence}:${frame.capturedAt}`;
  if (sourceFrameKey === lastSourceFrameKey) return;
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": frame.mimeType,
      "X-ScreenHand-Frame-Width": String(frame.width),
      "X-ScreenHand-Frame-Height": String(frame.height),
      "X-ScreenHand-Captured-At": String(frame.capturedAt),
      "X-ScreenHand-Device-Id": deviceId,
      "X-ScreenHand-Frame-Source": "feature-frame-relay",
      "X-ScreenHand-Frame-Role": "verification",
    },
    body: frame.bytes,
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`target HTTP ${response.status}`);

  lastSourceFrameKey = sourceFrameKey;
  relayed += 1;
  if (relayed === 1 || relayed % 100 === 0) {
    const relayLagMs = Math.max(0, Date.now() - frame.capturedAt);
    process.stdout.write(
      `Relayed ${relayed} pushed frame(s); source ${sourceFrameKey}; age ${relayLagMs}ms\n`,
    );
  }
}

async function uploadLatestFrames() {
  if (uploadActive) return;
  uploadActive = true;
  try {
    while (pendingFrame && !stopped) {
      const frame = pendingFrame;
      pendingFrame = null;
      try {
        await postFrame(frame);
        lastError = "";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) process.stderr.write(`Frame relay: ${message}\n`);
        lastError = message;
      }
    }
  } finally {
    uploadActive = false;
    if (pendingFrame && !stopped) {
      uploadPromise = uploadLatestFrames();
    }
  }
}

function enqueueFrame(metadata, bytes) {
  pendingFrame = {
    sequence: metadata.sequence,
    capturedAt: metadata.capturedAt,
    width: positiveInteger(metadata.width, width),
    height: positiveInteger(metadata.height, height),
    mimeType: typeof metadata.mimeType === "string" ? metadata.mimeType : "image/jpeg",
    bytes,
  };
  if (!uploadActive) uploadPromise = uploadLatestFrames();
}

function relaySocketSession() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(sourceSocketUrl, { handshakeTimeout: 1_500 });
    activeSocket = socket;
    let opened = false;
    let metadata = null;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (activeSocket === socket) activeSocket = null;
      if (error) reject(error);
      else resolve();
    };

    socket.once("open", () => {
      opened = true;
      lastError = "";
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const candidate = JSON.parse(data.toString());
          metadata = candidate?.type === "frame" &&
              Number.isInteger(candidate.sequence) &&
              Number.isFinite(candidate.capturedAt)
            ? candidate
            : null;
        } catch {
          metadata = null;
        }
        return;
      }
      if (!metadata) return;
      const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data);
      enqueueFrame(metadata, bytes);
      metadata = null;
    });
    socket.once("error", (error) => {
      if (!opened) finish(error);
    });
    socket.once("close", () => finish());
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    activeSocket?.close(1000, "relay stopping");
  });
}

process.stdout.write(`Relaying pushed camera frames from ${sourceSocketUrl} to ${targetUrl}\n`);
while (!stopped) {
  try {
    await relaySocketSession();
    lastError = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) process.stderr.write(`Frame relay: ${message}\n`);
    lastError = message;
  }
  if (!stopped) await wait(reconnectMs);
}

await Promise.race([uploadPromise, wait(2_000)]);
process.stdout.write("Frame relay stopped.\n");
