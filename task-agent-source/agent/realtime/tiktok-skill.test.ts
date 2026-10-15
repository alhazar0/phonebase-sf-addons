import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenObservation } from "../general-agent-contract";
import { classifyRuntimeScreen } from "./screen-state";
import { commentClosePoint, locateHorizontalToken } from "./tiktok-skill";

test("aligns the comments close target with a dynamically positioned sheet title", () => {
  const observation: ScreenObservation = {
    sequence: 1,
    capturedAt: Date.now(),
    viewport: { width: 720, height: 1_560 },
    fingerprint: "comments",
    changeRatio: null,
    changeKind: "first",
    ocrCacheHit: false,
    ocrElapsedMs: 10,
    observationElapsedMs: 12,
    averageTextConfidence: 1,
    textSignature: new Set(["590 comments", "Add comment"]),
    elements: [
      {
        id: "title",
        role: "text",
        text: "590 comments",
        confidence: 1,
        center: { x: 360, y: 635 },
        bounds: { left: 280, top: 620, width: 160, height: 30 },
      },
      {
        id: "composer",
        role: "text",
        text: "Add comment...",
        confidence: 1,
        center: { x: 200, y: 1_480 },
        bounds: { left: 100, top: 1_460, width: 200, height: 30 },
      },
    ],
    scene: { kind: "text_ui", confidence: 0.9, homeGridScore: 0, keyboardVisible: false },
  };
  const state = classifyRuntimeScreen(observation);
  assert.equal(state.kind, "tiktok_comments");
  assert.deepEqual(commentClosePoint(state), { x: 0.94, y: 635 / 1_560 });
});

test("targets Videos within an OCR box merged with Users", () => {
  const observation: ScreenObservation = {
    sequence: 2,
    capturedAt: Date.now(),
    viewport: { width: 720, height: 1_560 },
    fingerprint: "tabs",
    changeRatio: null,
    changeKind: "first",
    ocrCacheHit: false,
    ocrElapsedMs: 10,
    observationElapsedMs: 12,
    averageTextConfidence: 1,
    textSignature: new Set(["ideos users"]),
    elements: [{
      id: "merged-tabs",
      role: "text",
      text: "ideos Users",
      confidence: 1,
      center: { x: 211, y: 203 },
      bounds: { left: 124, top: 192, width: 173, height: 21 },
    }],
    scene: { kind: "text_ui", confidence: 0.8, homeGridScore: 0, keyboardVisible: false },
  };
  const target = locateHorizontalToken(classifyRuntimeScreen(observation), "videos");
  assert.ok(target);
  assert.ok(target.point.x >= 160 && target.point.x <= 170);
  assert.equal(target.point.y, 203);
});
