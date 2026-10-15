import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  detectProjectiveScreenCandidate,
  isSingleEdgeLuminousInset,
} from "./projective-screen-detector";

async function fixture(kind: "occluded" | "two-panels" | "bright-background") {
  const background = kind === "bright-background" ? "#d8dbe0" : "#030406";
  const screen = kind === "two-panels"
    ? `
      <rect x="90" y="120" width="210" height="330" fill="#edf1f6"/>
      <rect x="390" y="700" width="220" height="360" fill="#edf1f6"/>
    `
    : `
      <path d="M322 150 L560 186 L562 1045 L235 1010 Z" fill="#edf1f6"/>
      <path d="M315 300 L557 334" stroke="#c9ced6" stroke-width="16"/>
      <path d="M255 820 L560 855" stroke="#d8dde3" stroke-width="22"/>
      <path d="M145 520 L650 790 L620 900 L115 630 Z" fill="#090b0f"/>
    `;
  return sharp({
    create: {
      width: 720,
      height: 1280,
      channels: 3,
      background: { r: 3, g: 4, b: 6 },
    },
  }).composite([{
    input: Buffer.from(`
      <svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg">
        <rect width="720" height="1280" fill="${background}"/>
        ${screen}
      </svg>
    `),
  }]).jpeg({ quality: 88 }).toBuffer();
}

test("recovers a projective screen divided by a dark robot arm", async () => {
  const result = await detectProjectiveScreenCandidate(await fixture("occluded"));
  assert.ok(result);
  assert.ok(Math.abs(result.topLeft.x - 322) < 16, JSON.stringify(result));
  assert.ok(Math.abs(result.topLeft.y - 150) < 16, JSON.stringify(result));
  assert.ok(Math.abs(result.topRight.x - 560) < 16, JSON.stringify(result));
  assert.ok(Math.abs(result.bottomRight.y - 1_045) < 18, JSON.stringify(result));
  assert.ok(Math.abs(result.bottomLeft.x - 235) < 18, JSON.stringify(result));
  assert.ok(result.confidence >= 0.9, JSON.stringify(result));
});

test("does not bridge unrelated bright panels into a phone", async () => {
  assert.equal(
    await detectProjectiveScreenCandidate(await fixture("two-panels")),
    null,
  );
});

test("requires a dark fixture border", async () => {
  assert.equal(
    await detectProjectiveScreenCandidate(await fixture("bright-background")),
    null,
  );
});

test("allows only one aligned dark-bar inset inside a registered screen", () => {
  const registered = [
    { x: 70, y: 12 },
    { x: 625, y: 12 },
    { x: 641, y: 1_211 },
    { x: 88, y: 1_211 },
  ] as const;
  assert.equal(isSingleEdgeLuminousInset([
    { x: 72, y: 66 },
    { x: 621, y: 57 },
    { x: 640, y: 1_208 },
    { x: 85, y: 1_212 },
  ], [...registered]), true);
  assert.equal(isSingleEdgeLuminousInset([
    { x: 329, y: 154 },
    { x: 584, y: 195 },
    { x: 589, y: 1_046 },
    { x: 228, y: 1_018 },
  ], [...registered]), false);
  assert.equal(isSingleEdgeLuminousInset([
    { x: 125, y: 66 },
    { x: 570, y: 57 },
    { x: 585, y: 1_150 },
    { x: 140, y: 1_150 },
  ], [...registered]), false);
});
