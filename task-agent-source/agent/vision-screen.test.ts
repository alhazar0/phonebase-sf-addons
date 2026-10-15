import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  chooseScreenCandidate,
  detectLuminousScreenCandidate,
  rankScreenCandidate,
  type VisionScreenResult,
} from "./vision-screen";

const expected = [
  { x: 180, y: 70 },
  { x: 540, y: 60 },
  { x: 545, y: 1150 },
  { x: 175, y: 1155 },
] as const;

test("prefers the full phone screen over compact icon rectangles", () => {
  const result: VisionScreenResult = {
    ok: true,
    imageWidth: 720,
    imageHeight: 1280,
    elapsedMs: 12,
    candidates: [
      {
        confidence: 0.99,
        topLeft: { x: 90, y: 120 },
        topRight: { x: 180, y: 120 },
        bottomRight: { x: 180, y: 210 },
        bottomLeft: { x: 90, y: 210 },
        areaRatio: 0.009,
      },
      {
        confidence: 0.83,
        topLeft: expected[0],
        topRight: expected[1],
        bottomRight: expected[2],
        bottomLeft: expected[3],
        areaRatio: 0.43,
      },
    ],
  };
  const choice = chooseScreenCandidate({
    result,
    expectedPoints: [...expected],
    expectedScreenAspectRatio: 720 / 1560,
  });
  assert.ok(choice.selected);
  assert.deepEqual(choice.selected.points, expected);
});

test("rejects a candidate that is too small to be the phone screen", () => {
  const result: VisionScreenResult = {
    ok: true,
    imageWidth: 720,
    imageHeight: 1280,
    elapsedMs: 8,
    candidates: [{
      confidence: 0.99,
      topLeft: { x: 100, y: 100 },
      topRight: { x: 230, y: 100 },
      bottomRight: { x: 230, y: 250 },
      bottomLeft: { x: 100, y: 250 },
      areaRatio: 0.02,
    }],
  };
  assert.equal(chooseScreenCandidate({ result }).selected, null);
});

test("rejects a partial rectangle with one collapsed perspective edge", () => {
  const result: VisionScreenResult = {
    ok: true,
    imageWidth: 720,
    imageHeight: 1280,
    elapsedMs: 8,
    candidates: [{
      confidence: 1,
      topLeft: { x: 464, y: 13 },
      topRight: { x: 628, y: 16 },
      bottomRight: { x: 647, y: 1_218 },
      bottomLeft: { x: 77, y: 1_222 },
      areaRatio: 0.48,
    }],
  };
  assert.equal(chooseScreenCandidate({ result }).selected, null);
});

test("reports camera drift against the saved calibration", () => {
  const ranked = rankScreenCandidate({
    candidate: {
      confidence: 0.9,
      topLeft: { x: 186, y: 78 },
      topRight: { x: 546, y: 68 },
      bottomRight: { x: 551, y: 1158 },
      bottomLeft: { x: 181, y: 1163 },
      areaRatio: 0.43,
    },
    imageWidth: 720,
    imageHeight: 1280,
    expectedPoints: [...expected],
    expectedScreenAspectRatio: 720 / 1560,
  });
  assert.ok(ranked.meanExpectedErrorPx !== null);
  assert.ok(ranked.meanExpectedErrorPx > 8);
  assert.ok(ranked.meanExpectedErrorPx < 12);
  assert.ok(ranked.maximumExpectedErrorPx !== null);
});

test("fits a rounded lit screen when the dark status bar hides its top edge", async () => {
  const image = await sharp({
    create: {
      width: 720,
      height: 1280,
      channels: 3,
      background: { r: 1, g: 1, b: 2 },
    },
  }).composite([{
    input: Buffer.from(`
      <svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg">
        <path d="M71 12 L625 12 L641 1211 L88 1211 Z" fill="#050505"/>
        <path d="M75 280 L629 280 L641 1211 L88 1211 Z" fill="#d94357"/>
        <path d="M82 850 L636 850 L641 1211 L88 1211 Z" fill="#4285b4"/>
      </svg>
    `),
  }]).jpeg({ quality: 90 }).toBuffer();
  const detected = await detectLuminousScreenCandidate(image, 720 / 1560);
  assert.ok(detected);
  assert.ok(Math.abs(detected.topLeft.x - 71) < 8);
  assert.ok(Math.abs(detected.topLeft.y - 12) < 8);
  assert.ok(Math.abs(detected.topRight.x - 625) < 8);
  assert.ok(Math.abs(detected.bottomRight.y - 1211) < 8);
  assert.ok(detected.confidence >= 0.85);
});
