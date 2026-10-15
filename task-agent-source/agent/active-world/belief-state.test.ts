import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenObservation } from "../general-agent-contract";
import { ActiveWorldBeliefState } from "./belief-state";

test("belief state preserves element identity and resists a one-frame kind change", () => {
  const belief = new ActiveWorldBeliefState({ kindSwitchFrames: 2 });
  const first = belief.observe({
    screenKind: "home",
    screenConfidence: 0.94,
    observation: fixture(10, "home-a", [
      { text: "Telegram", x: 120, y: 320 },
      { text: "Instagram", x: 360, y: 320 },
    ]),
    observedAt: 1_000,
  });
  const telegramId = first.belief.elements.find((element) =>
    element.normalizedText === "telegram"
  )?.id;
  assert.ok(telegramId);

  const second = belief.observe({
    screenKind: "home",
    screenConfidence: 0.96,
    observation: fixture(11, "home-b", [
      { text: "Telegram", x: 123, y: 323 },
      { text: "Instagram", x: 362, y: 322 },
    ], "minor"),
    observedAt: 1_100,
  });
  const telegram = second.belief.elements.find((element) => element.id === telegramId);
  assert.equal(telegram?.seenCount, 2);
  assert.equal(second.belief.screen?.kind, "home");

  const transient = belief.observe({
    screenKind: "unknown",
    screenConfidence: 0.3,
    observation: fixture(12, "noise", [], "major"),
    observedAt: 1_200,
  });
  assert.equal(transient.belief.screen?.kind, "home");
  assert.equal(transient.belief.screen?.candidateKind, "unknown");

  const confirmed = belief.observe({
    screenKind: "unknown",
    screenConfidence: 0.35,
    observation: fixture(13, "noise-2", [], "stable"),
    observedAt: 1_300,
  });
  assert.equal(confirmed.belief.screen?.kind, "unknown");
  assert.ok(confirmed.belief.uncertainty > second.belief.uncertainty);
});

test("belief state tracks the latest physical action without changing screen belief", () => {
  const belief = new ActiveWorldBeliefState();
  belief.observe({
    screenKind: "text_ui",
    screenConfidence: 0.8,
    observation: fixture(1, "screen", [{ text: "Search", x: 100, y: 100 }]),
  });
  belief.actionStarted("action-1", "open-search", "tap", 2_000);
  assert.deepEqual(belief.snapshot().lastAction, {
    executionId: "action-1",
    label: "open-search",
    type: "tap",
    status: "executing",
    startedAt: 2_000,
  });
  belief.actionFinished("action-1", "completed", 2_120);
  assert.equal(belief.snapshot().lastAction?.status, "completed");
  assert.equal(belief.snapshot().screen?.kind, "text_ui");
});

function fixture(
  sequence: number,
  fingerprint: string,
  labels: Array<{ text: string; x: number; y: number }>,
  changeKind: ScreenObservation["changeKind"] = "stable",
): ScreenObservation {
  return {
    sequence,
    capturedAt: 900 + sequence,
    viewport: { width: 720, height: 1_560 },
    fingerprint,
    changeRatio: changeKind === "stable" ? 0.001 : changeKind === "minor" ? 0.03 : 0.3,
    changeKind,
    ocrCacheHit: false,
    ocrElapsedMs: 25,
    observationElapsedMs: 30,
    averageTextConfidence: labels.length ? 0.9 : 0,
    textSignature: new Set(labels.map(({ text }) => text)),
    elements: labels.map(({ text, x, y }, index) => ({
      id: `ocr-${index}`,
      role: "text",
      text,
      confidence: 0.9,
      center: { x, y },
      bounds: { left: x - 50, top: y - 10, width: 100, height: 20 },
    })),
    scene: {
      kind: "text_ui",
      confidence: 0.85,
      homeGridScore: 0,
      keyboardVisible: false,
    },
  };
}
