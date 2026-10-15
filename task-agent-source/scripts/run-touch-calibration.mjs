#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decode } from "jpeg-js";

const CONTROL_PLANE_URL = process.env.SCREENHAND_CONTROL_PLANE_URL ??
  "http://127.0.0.1:3013";
const DEVICE_ID = process.env.SCREENHAND_DEVICE_ID ?? "black-arm-01";
const SCREEN = { width: 720, height: 1560 };
const pilot = process.argv.includes("--pilot");
const targetFractions = pilot
  ? [
      [0.5, 0.5],
      [0.2, 0.25],
      [0.8, 0.25],
      [0.8, 0.75],
      [0.2, 0.75],
    ]
  : [0.16, 0.33, 0.5, 0.67, 0.84].flatMap((x) =>
      [0.22, 0.36, 0.5, 0.64, 0.78].map((y) => [x, y])
    );

async function json(path, options = {}) {
  const response = await fetch(`${CONTROL_PLANE_URL}${path}`, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `${path} returned HTTP ${response.status}`);
  }
  return payload;
}

async function waitForReceipt(receiptId) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const payload = await json(
      `/api/v1/devices/${encodeURIComponent(DEVICE_ID)}/actions/${encodeURIComponent(receiptId)}`,
    );
    if (payload.receipt.status === "completed") return payload.receipt;
    if (payload.receipt.status === "failed") {
      throw new Error(payload.receipt.error ?? `Action ${receiptId} failed`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw new Error(`Action ${receiptId} did not complete in time`);
}

async function waitForSample(previousCount) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const payload = await json("/api/touch-calibration/samples");
    if (payload.samples.length > previousCount) return payload.samples.at(-1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error("The iPhone did not report a physical touch; calibration stopped");
}

async function markerFromDigitalFrame() {
  const response = await fetch(`${CONTROL_PLANE_URL}/api/frame`);
  if (!response.ok) throw new Error(`Unable to read digital frame: HTTP ${response.status}`);
  const frame = decode(Buffer.from(await response.arrayBuffer()), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 4,
  });
  const mask = new Uint8Array(frame.width * frame.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    const red = frame.data[offset];
    const green = frame.data[offset + 1];
    const blue = frame.data[offset + 2];
    if (red > 120 && red - green > 45 && red - blue > 25) mask[pixel] = 1;
  }
  const seen = new Uint8Array(mask.length);
  let largest = null;
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || seen[seed]) continue;
    const stack = [seed];
    seen[seed] = 1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    while (stack.length) {
      const current = stack.pop();
      const x = current % frame.width;
      const y = Math.floor(current / frame.width);
      count += 1;
      sumX += x;
      sumY += y;
      for (const dy of [-1, 0, 1]) {
        for (const dx of [-1, 0, 1]) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (
            nextX < 0 || nextX >= frame.width ||
            nextY < 0 || nextY >= frame.height
          ) continue;
          const next = nextY * frame.width + nextX;
          if (mask[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    const component = {
      count,
      x: sumX / count,
      y: sumY / count,
    };
    // Ignore the tiny red low-battery icon in the status bar. The calibration
    // crosshair is a connected component of several hundred pixels.
    if (component.y > 60 && (!largest || component.count > largest.count)) {
      largest = component;
    }
  }
  if (!largest || largest.count < 120) {
    throw new Error("The red physical-touch marker was not found in the digital frame");
  }
  return largest;
}

async function waitForNewMarker(previous) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const marker = await markerFromDigitalFrame();
    if (
      !previous ||
      Math.hypot(marker.x - previous.x, marker.y - previous.y) > 8
    ) return marker;
    await new Promise((resolveWait) => setTimeout(resolveWait, 90));
  }
  throw new Error("The digital frame did not show the new physical-touch marker");
}

await json("/api/touch-calibration/samples", { method: "DELETE" });
const measurements = [];

for (let index = 0; index < targetFractions.length; index += 1) {
  const [fractionX, fractionY] = targetFractions[index];
  const target = {
    x: Math.round(fractionX * SCREEN.width),
    y: Math.round(fractionY * SCREEN.height),
  };
  await json("/api/touch-calibration/heartbeat", { method: "POST" });
  const devices = await json("/api/v1/devices");
  const device = devices.devices.find((value) => value.id === DEVICE_ID);
  if (!device?.screen?.sequence) throw new Error("A fresh screen frame is required");
  const sampleState = await json("/api/touch-calibration/samples");
  let previousMarker = null;
  try {
    previousMarker = await markerFromDigitalFrame();
  } catch {
    // The first sample is allowed to start without an existing marker.
  }
  const action = await json(
    `/api/v1/devices/${encodeURIComponent(DEVICE_ID)}/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `precision-${Date.now().toString(36)}-${index}`,
        action: {
          type: "tap",
          point: target,
          viewport: SCREEN,
          frameSequence: device.screen.sequence,
          durationMs: 80,
        },
      }),
    },
  );
  const receiptId = action.result?.receipt?.id;
  if (!receiptId) throw new Error("The touch action did not return a receipt");
  const sample = await waitForSample(sampleState.samples.length);
  const receipt = await waitForReceipt(receiptId);
  const marker = await waitForNewMarker(previousMarker);
  const actual = { x: marker.x, y: marker.y };
  const measurement = {
    index,
    target,
    machinePoint: action.result.machinePoint,
    actual,
    error: {
      x: actual.x - target.x,
      y: actual.y - target.y,
      distance: Math.hypot(actual.x - target.x, actual.y - target.y),
    },
    iphoneSample: sample,
    digitalMarker: marker,
    elapsedMs: receipt.elapsedMs,
  };
  measurements.push(measurement);
  process.stdout.write(
    `${index + 1}/${targetFractions.length} target=(${target.x},${target.y}) ` +
    `actual=(${actual.x.toFixed(1)},${actual.y.toFixed(1)}) ` +
    `error=${measurement.error.distance.toFixed(1)}px\n`,
  );
}

const distances = measurements.map((value) => value.error.distance);
const report = {
  createdAt: new Date().toISOString(),
  deviceId: DEVICE_ID,
  mode: pilot ? "pilot" : "5x5",
  screen: SCREEN,
  measurements,
  summary: {
    samples: measurements.length,
    meanErrorPx: distances.reduce((sum, value) => sum + value, 0) / distances.length,
    maximumErrorPx: Math.max(...distances),
  },
};
const outputPath = resolve(
  `build/precision-calibration-${pilot ? "pilot" : "5x5"}.json`,
);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`Saved ${outputPath}\n`);
