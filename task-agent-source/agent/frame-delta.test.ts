import assert from "node:assert/strict";
import test from "node:test";

import { analyzeFrameDelta } from "./frame-delta";

const viewport = { width: 720, height: 1_560 };

test("routes a localized visual change to a bounded logical ROI", () => {
  const previous = Buffer.alloc(48 * 80, 120);
  const current = Buffer.from(previous);
  for (let y = 48; y < 64; y += 1) {
    for (let x = 32; x < 40; x += 1) current[y * 48 + x] = 245;
  }
  const delta = analyzeFrameDelta(previous, current, viewport);
  assert.equal(delta.changeKind, "minor");
  assert.equal(delta.regions.length, 1);
  assert.ok(delta.changedAreaRatio > 0);
  assert.ok(delta.changedAreaRatio < 0.45);
  assert.ok(delta.regions[0].left >= viewport.width * 0.45);
  assert.ok(delta.regions[0].top >= viewport.height * 0.4);
});

test("returns no OCR region for a stable frame", () => {
  const frame = Buffer.alloc(48 * 80, 80);
  const delta = analyzeFrameDelta(frame, Buffer.from(frame), viewport);
  assert.equal(delta.changeKind, "stable");
  assert.equal(delta.regions.length, 0);
  assert.equal(delta.changedAreaRatio, 0);
});

test("fails safely to the whole viewport when change is spatially broad", () => {
  const previous = Buffer.alloc(48 * 80, 0);
  const current = Buffer.alloc(48 * 80, 255);
  const delta = analyzeFrameDelta(previous, current, viewport);
  assert.equal(delta.changeKind, "major");
  assert.equal(delta.changedAreaRatio, 1);
  assert.deepEqual(delta.regions[0], {
    left: 0,
    top: 0,
    width: 720,
    height: 1_560,
    score: 1,
  });
});
