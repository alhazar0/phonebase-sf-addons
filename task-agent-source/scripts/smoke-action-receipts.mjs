import { readFile } from "node:fs/promises";

const baseUrl = process.env.SCREENHAND_SMOKE_CONTROL_PLANE_URL ?? "http://127.0.0.1:3024";
const deviceId = process.env.SCREENHAND_SMOKE_DEVICE_ID ?? "black-arm-simulator";
const jpegPath = process.env.SCREENHAND_SMOKE_JPEG ?? "/tmp/screenhand-sim-frame.jpg";

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status}: ${payload.error ?? "request failed"}`);
  }
  return payload;
}

const jpeg = await readFile(jpegPath);
const frame = (await json("/api/frame/jpeg", {
  method: "POST",
  headers: {
    "content-type": "image/jpeg",
    "x-screenhand-frame-width": "960",
    "x-screenhand-frame-height": "1280",
    "x-screenhand-captured-at": String(Date.now()),
    "x-screenhand-device-id": deviceId
  },
  body: jpeg
})).frame;

const viewport = { width: frame.width, height: frame.height };
const actions = [
  {
    idempotencyKey: "receipt-smoke-tap",
    action: {
      type: "tap",
      point: { x: 360, y: 640 },
      viewport,
      frameSequence: frame.sequence,
      durationMs: 80
    }
  },
  {
    idempotencyKey: "receipt-smoke-long-press",
    action: {
      type: "long_press",
      point: { x: 420, y: 520 },
      viewport,
      frameSequence: frame.sequence,
      durationMs: 800
    }
  },
  {
    idempotencyKey: "receipt-smoke-swipe",
    action: {
      type: "swipe",
      start: { x: 360, y: 960 },
      end: { x: 360, y: 320 },
      viewport,
      frameSequence: frame.sequence,
      durationMs: 500
    }
  },
  {
    idempotencyKey: "receipt-smoke-hold",
    action: { type: "hold" }
  }
];

const completed = [];
for (const envelope of actions) {
  const submitted = await json(`/api/v1/devices/${deviceId}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope)
  });
  const receiptId = submitted.result?.receipt?.id;
  if (!receiptId) throw new Error("The action response did not include a receipt");
  let receipt = submitted.result.receipt;
  const deadline = Date.now() + 5_000;
  while (
    receipt.status !== "completed" &&
    receipt.status !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    receipt = (await json(
      `/api/v1/devices/${deviceId}/actions/${encodeURIComponent(receiptId)}`,
    )).receipt;
  }
  if (receipt.status !== "completed") {
    throw new Error(`${envelope.action.type} ended as ${receipt.status}: ${receipt.error}`);
  }
  const replay = await json(`/api/v1/devices/${deviceId}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope)
  });
  if (
    replay.result?.replayed !== true ||
    replay.result?.receipt?.id !== receiptId ||
    replay.result?.receipt?.status !== "completed"
  ) {
    throw new Error("Idempotent action replay did not return the final receipt");
  }
  completed.push({
    type: envelope.action.type,
    receiptId,
    status: receipt.status,
    elapsedMs: receipt.elapsedMs,
    replayed: replay.result.replayed
  });
}

process.stdout.write(`${JSON.stringify({ frame, completed }, null, 2)}\n`);
