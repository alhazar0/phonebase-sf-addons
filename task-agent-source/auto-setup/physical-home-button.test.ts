import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { detectPhysicalHomeButton } from "./physical-home-button";

const frame = { width: 720, height: 1280 };
const screenPoints = [
  { x: 100, y: 80 },
  { x: 620, y: 80 },
  { x: 620, y: 1050 },
  { x: 100, y: 1050 },
] as const;

async function fixture(button: "circle" | "square" | "none") {
  const shape = button === "circle"
    ? '<circle cx="360" cy="1130" r="36" fill="#20242a" stroke="#9ca3ad" stroke-width="6"/>'
    : button === "square"
      ? '<rect x="324" y="1094" width="72" height="72" rx="3" fill="#20242a"/>'
      : "";
  return sharp({
    create: {
      width: frame.width,
      height: frame.height,
      channels: 3,
      background: { r: 10, g: 13, b: 18 },
    },
  }).composite([{
    input: Buffer.from(`
      <svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg">
        <rect x="80" y="40" width="560" height="1210" rx="42" fill="#e9edf2"/>
        <rect x="100" y="80" width="520" height="970" rx="12" fill="#26384d"/>
        ${shape}
      </svg>
    `),
  }]).jpeg({ quality: 90 }).toBuffer();
}

test("detects a centered physical Home button without authorizing a press", async () => {
  const result = await detectPhysicalHomeButton({
    imageBytes: await fixture("circle"),
    frame,
    screenPoints: [...screenPoints],
    screenAspectRatio: 520 / 970,
  });
  assert.equal(result.status, "detected", JSON.stringify(result));
  assert.ok(Math.abs((result.point?.x ?? 0) - 360) < 8);
  assert.ok(Math.abs((result.point?.y ?? 0) - 1130) < 8);
  assert.equal(result.wouldMoveHardware, false);
  assert.equal(result.actionReady, false);
});

test("rejects a square control and a flat bottom bezel", async () => {
  for (const kind of ["square", "none"] as const) {
    const result = await detectPhysicalHomeButton({
      imageBytes: await fixture(kind),
      frame,
      screenPoints: [...screenPoints],
      screenAspectRatio: 520 / 970,
    });
    assert.equal(result.status, "not_detected", `${kind}: ${JSON.stringify(result)}`);
    assert.equal(result.actionReady, false);
  }
});

test("reports an unobservable Home region when the camera crops the bezel", async () => {
  const imageBytes = await fixture("none");
  const result = await detectPhysicalHomeButton({
    imageBytes,
    frame,
    screenPoints: [
      { x: 100, y: 80 },
      { x: 620, y: 80 },
      { x: 620, y: 1225 },
      { x: 100, y: 1225 },
    ],
    screenAspectRatio: 520 / 1145,
  });
  assert.equal(result.status, "unobservable");
  assert.equal(result.reason, "button-region-outside-camera");
});
