import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenObservation } from "../general-agent-contract";
import { SemanticSceneGraphTracker } from "../semantic-scene-graph";
import type { VisualAffordance } from "../visual-affordance-detector";
import { classifyRuntimeScreen } from "./screen-state";
import { planPopupAction } from "./popup-guardian";

test("dismisses an iOS notification permission prompt without operator input", () => {
  const state = classifyRuntimeScreen(observation([
    ["TikTok Would Like to Send You Notifications", 360, 570],
    ["Notifications may include alerts, sounds and icon badges.", 360, 660],
    ["Don't Allow", 240, 820],
    ["Allow", 480, 820],
  ]));
  const decision = planPopupAction(state);
  assert.ok(decision);
  assert.equal(decision.category, "notifications");
  assert.equal(decision.operation, "tap");
  assert.equal(decision.label, "don't allow");
  assert.deepEqual(decision.target, { x: 240 / 720, y: 820 / 1_560 });
});

test("allows only a capability explicitly required by the task", () => {
  const state = classifyRuntimeScreen(observation([
    ["Allow TikTok to access your photos?", 360, 570],
    ["Don't Allow", 240, 820],
    ["Allow Full Access", 480, 820],
  ]));
  const decision = planPopupAction(state, {
    allowCapabilities: new Set(["photos"]),
  });
  assert.ok(decision);
  assert.equal(decision.category, "permission");
  assert.equal(decision.label, "allow");
  assert.deepEqual(decision.target, { x: 480 / 720, y: 820 / 1_560 });
});

test("retries a network interruption and backs out of a security challenge", () => {
  const network = planPopupAction(classifyRuntimeScreen(observation([
    ["Network error", 360, 600],
    ["Try Again", 360, 790],
  ])));
  assert.ok(network);
  assert.equal(network.category, "network_error");
  assert.equal(network.label, "retry");

  const challenge = planPopupAction(classifyRuntimeScreen(observation([
    ["Security Check", 360, 520],
    ["Enter verification code", 360, 630],
  ])));
  assert.ok(challenge);
  assert.equal(challenge.category, "authentication");
  assert.equal(challenge.operation, "back");
});

test("does not mistake normal TikTok navigation for a popup", () => {
  const state = classifyRuntimeScreen(observation([
    ["Following", 180, 100],
    ["For You", 360, 100],
    ["Home", 80, 1_510],
    ["Friends", 220, 1_510],
    ["Inbox", 500, 1_510],
    ["Profile", 650, 1_510],
  ]));
  assert.equal(planPopupAction(state), null);
});

test("does not mistake ordinary notification or permission settings for a popup", () => {
  const notificationSettings = classifyRuntimeScreen(observation([
    ["Notifications", 180, 140],
    ["Allow Notifications", 250, 300],
    ["Sounds", 180, 420],
    ["Badges", 180, 520],
  ]));
  const permissionSettings = classifyRuntimeScreen(observation([
    ["Permissions", 180, 140],
    ["Camera", 180, 300],
    ["Microphone", 180, 420],
    ["Photos", 180, 540],
  ]));
  assert.equal(planPopupAction(notificationSettings), null);
  assert.equal(planPopupAction(permissionSettings), null);
});

test("uses one unambiguous local close symbol when popup text has no button label", () => {
  const visual = observationWithAffordances([
    ["New version available", 360, 560],
    ["Install the latest update for new features", 360, 650],
  ], [visualAffordance("close", 650, 135, 0.91)]);
  const decision = planPopupAction(classifyRuntimeScreen(visual));
  assert.ok(decision);
  assert.equal(decision.category, "update");
  assert.equal(decision.operation, "tap");
  assert.equal(decision.label, "close-symbol");
  assert.deepEqual(decision.target, { x: 650 / 720, y: 135 / 1_560 });
});

test("rejects ambiguous visual close symbols and keeps the bounded Back fallback", () => {
  const visual = observationWithAffordances([
    ["Network error", 360, 560],
    ["Unable to load", 360, 650],
  ], [
    visualAffordance("close", 70, 135, 0.9),
    visualAffordance("close", 650, 135, 0.89),
  ]);
  const decision = planPopupAction(classifyRuntimeScreen(visual), {
    retryNetworkErrors: false,
  });
  assert.ok(decision);
  assert.equal(decision.operation, "back");
  assert.equal(decision.label, "dismiss-with-back");
});

function observation(labels: Array<[string, number, number]>): ScreenObservation {
  return {
    sequence: 1,
    capturedAt: Date.now(),
    viewport: { width: 720, height: 1_560 },
    fingerprint: labels.map(([text]) => text).join("-"),
    changeRatio: null,
    changeKind: "first",
    ocrCacheHit: false,
    ocrElapsedMs: 10,
    observationElapsedMs: 12,
    averageTextConfidence: 0.96,
    textSignature: new Set(labels.map(([text]) => text)),
    elements: labels.map(([text, x, y], index) => ({
      id: String(index),
      role: "text",
      text,
      confidence: 0.96,
      center: { x, y },
      bounds: { left: x - 140, top: y - 18, width: 280, height: 36 },
    })),
    scene: {
      kind: "text_ui",
      confidence: 0.9,
      homeGridScore: 0,
      keyboardVisible: false,
    },
  };
}

function observationWithAffordances(
  labels: Array<[string, number, number]>,
  affordances: VisualAffordance[],
) {
  const result = observation(labels);
  result.sceneGraph = new SemanticSceneGraphTracker().update({
    sequence: result.sequence,
    fingerprint: result.fingerprint,
    viewport: result.viewport,
    scene: result.scene,
    elements: result.elements,
    visualAffordances: affordances,
  });
  return result;
}

function visualAffordance(
  symbol: "close",
  x: number,
  y: number,
  confidence: number,
): VisualAffordance {
  return {
    role: "navigation",
    label: symbol,
    confidence,
    center: { x, y },
    bounds: { left: x - 30, top: y - 30, width: 60, height: 60 },
    source: "local_edges",
    edgeDensity: 0.3,
    localContrast: 70,
    symbol,
    symbolConfidence: confidence,
  };
}
