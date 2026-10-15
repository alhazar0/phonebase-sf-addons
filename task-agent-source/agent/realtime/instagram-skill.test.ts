import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenElement, ScreenObservation } from "../general-agent-contract";
import {
  extractInstagramLikes,
  extractLatestInstagramViews,
  locateInstagramAccountResult,
  parseInstagramMetric,
  profileTabsY,
} from "./instagram-skill";
import type { InstagramProfileInspectionProgram } from "./instagram-task";
import type { RuntimeScreenState } from "./screen-state";

const program: InstagramProfileInspectionProgram = {
  app: "Instagram",
  kind: "instagram_profile_inspection",
  targetQuery: "Nonna Sofia",
  targetHandle: null,
  searchPrefix: "nonnasofi",
  latestVideo: true,
  metrics: ["views", "likes"],
  taskEffect: "read_only",
};

test("locates the matching Instagram account below search suggestions", () => {
  const observation = fixture([
    element("Search", 120, 130),
    element("Cancel", 650, 130),
    element("nonna sofia", 150, 250),
    element("nonnasofiahealth", 205, 520),
    element("Nonna.Sofia", 205, 560),
    element("nonnasofiaischa", 205, 650),
    element("Nonna Sofia Ischia", 205, 690),
  ], true);
  const result = locateInstagramAccountResult(program, observation);
  assert.equal(result?.label, "nonnasofiahealth");
  assert.deepEqual(result?.point, { x: 205, y: 520 });
});

test("extracts the top-left latest Reel view count from the logical viewport", () => {
  const state = runtimeState([
    element("nonnasofiahealth", 220, 110),
    element("277 posts", 220, 250),
    element("63.3K followers", 380, 250),
    element("5 following", 560, 250),
    element("Follow", 170, 545),
    element("Message", 450, 545),
    element("€ 7,068", 65, 1_080),
    element("° 8,966", 305, 1_080),
    element("© 3,809", 550, 1_080),
  ], "instagram_reels_grid");
  assert.ok(Math.abs(profileTabsY(state) - 0.40436) < 0.00001);
  assert.deepEqual(extractLatestInstagramViews(state), { value: 7068, display: "7,068" });
});

test("reports hidden likes without probing the Instagram engagement rail", () => {
  const hidden = extractInstagramLikes([
    element("'Likes", 665, 890),
    element("132", 665, 1_010),
  ], { width: 720, height: 1_560 });
  assert.deepEqual(hidden, { metric: null, visibility: "hidden" });

  const visible = extractInstagramLikes([
    element("2.4K", 665, 875),
    element("132", 665, 1_010),
  ], { width: 720, height: 1_560 });
  assert.deepEqual(visible, {
    metric: { value: 2400, display: "2.4K" },
    visibility: "visible",
  });
});

test("parses localized compact Instagram metrics", () => {
  assert.deepEqual(parseInstagramMetric("7,068"), { value: 7068, display: "7,068" });
  assert.deepEqual(parseInstagramMetric("€ 7,068"), { value: 7068, display: "7,068" });
  assert.deepEqual(parseInstagramMetric("63.3K"), { value: 63300, display: "63.3K" });
  assert.deepEqual(parseInstagramMetric("1,2M"), { value: 1200000, display: "1,2M" });
  assert.equal(parseInstagramMetric("Likes"), null);
});

function runtimeState(elements: ScreenElement[], kind: RuntimeScreenState["kind"]): RuntimeScreenState {
  return {
    kind,
    confidence: 0.95,
    observation: fixture(elements),
    tokens: elements.map((item) => item.text.toLocaleLowerCase("en-US")),
    detectedAt: Date.now(),
  };
}

function fixture(elements: ScreenElement[], keyboardVisible = false): ScreenObservation {
  return {
    sequence: 1,
    capturedAt: Date.now(),
    viewport: { width: 720, height: 1_560 },
    fingerprint: "instagram-fixture",
    changeRatio: 0.2,
    changeKind: "major",
    ocrCacheHit: false,
    ocrElapsedMs: 120,
    observationElapsedMs: 140,
    averageTextConfidence: 0.95,
    textSignature: new Set(elements.map((item) => item.text)),
    elements,
    scene: {
      kind: keyboardVisible ? "keyboard" : "text_ui",
      confidence: 0.9,
      homeGridScore: 0,
      keyboardVisible,
    },
  };
}

function element(text: string, x: number, y: number): ScreenElement {
  return {
    id: `${text}-${x}-${y}`,
    role: "text",
    text,
    confidence: 0.95,
    center: { x, y },
    bounds: { left: x - 45, top: y - 12, width: 90, height: 24 },
  };
}
