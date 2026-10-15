import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { AgentFrame } from "../screen-observer";
import { SerializedScreenObserver } from "./warm-general-runtime";

test("background and task-time observation share one OCR pass per sequence", async () => {
  const bytes = await sharp({
    create: {
      width: 72,
      height: 156,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
    },
  }).jpeg().toBuffer();
  let calls = 0;
  const observer = new SerializedScreenObserver({
    ocrMode: "fast",
    recognize: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        ok: true,
        imageWidth: 720,
        imageHeight: 1_560,
        elapsedMs: 15,
        items: [],
      };
    },
  });
  const frame: AgentFrame = {
    bytes,
    mimeType: "image/jpeg",
    width: 720,
    height: 1_560,
    capturedAt: Date.now(),
    sequence: 42,
  };
  const [background, task] = await Promise.all([
    observer.observe(frame),
    observer.observe(frame),
  ]);
  assert.equal(calls, 1);
  assert.equal(background.ocrCacheHit, false);
  assert.equal(task.ocrCacheHit, true);
  assert.equal(task.ocrElapsedMs, 0);
  assert.ok(task.observationElapsedMs < 5);
});
