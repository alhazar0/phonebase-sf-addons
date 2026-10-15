import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { WebSocketServer } from "ws";

import { RealtimeFrameHub } from "./frame-hub";

test("realtime frame hub pairs metadata with bytes and advances without polling", async () => {
  const observedSequences: number[] = [];
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const firstBytes = await sharp({
    create: { width: 40, height: 80, channels: 3, background: "white" },
  }).jpeg().toBuffer();
  const secondBytes = await sharp({
    create: { width: 40, height: 80, channels: 3, background: "red" },
  }).jpeg().toBuffer();
  server.on("connection", (socket) => {
    sendFrame(socket, 1, firstBytes);
    setTimeout(() => sendFrame(socket, 2, secondBytes), 20);
  });
  const hub = new RealtimeFrameHub({
    deviceId: "fixture",
    socketUrl: `ws://127.0.0.1:${address.port}`,
    onFrame: (packet) => observedSequences.push(packet.metadata.sequence),
  });
  try {
    const first = await hub.start();
    assert.equal(first.metadata.sequence, 1);
    assert.deepEqual(first.bytes, firstBytes);
    const second = await hub.waitForFrame(1, 1_000);
    assert.equal(second.metadata.sequence, 2);
    assert.deepEqual(hub.latest()?.bytes, secondBytes);
    const modelFrame = await hub.latestModelFrame(1_024);
    assert.equal(modelFrame.sequence, 2);
    assert.equal(modelFrame.width, 40);
    assert.equal(modelFrame.height, 80);
    assert.deepEqual(observedSequences, [1, 2]);
  } finally {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function sendFrame(
  socket: import("ws").WebSocket,
  sequence: number,
  bytes: Buffer,
) {
  socket.send(JSON.stringify({
    type: "frame",
    mimeType: "image/jpeg",
    byteLength: bytes.length,
    width: 40,
    height: 80,
    rawWidth: 40,
    rawHeight: 80,
    rectified: false,
    imagePoints: null,
    calibrationId: null,
    capturedAt: Date.now(),
    source: "fixture",
    role: "control",
    sequence,
    deviceId: "fixture",
  }));
  socket.send(bytes);
}
