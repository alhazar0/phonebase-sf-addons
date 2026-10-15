import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { ScreenObservation } from "../general-agent-contract";
import { ScreenObserver } from "../screen-observer";
import type { VisionOcrResult } from "../vision-ocr";
import type { RealtimeFrameHub } from "./frame-hub";
import { LatencyRecorder } from "./latency-recorder";
import { classifyRuntimeScreen, RealtimeScreenPerception } from "./screen-state";

test("serializes concurrent perception and recognizes one camera sequence once", async () => {
  const bytes = await sharp({
    create: {
      width: 72,
      height: 156,
      channels: 3,
      background: "white",
    },
  }).jpeg().toBuffer();
  const frame = {
    bytes,
    mimeType: "image/jpeg" as const,
    width: 720,
    height: 1_560,
    sequence: 7,
    capturedAt: 1,
  };
  const frames = {
    latestModelFrame: async () => frame,
  } as unknown as RealtimeFrameHub;
  let recognitions = 0;
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => {
      recognitions += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      return tiktokFeedOcr();
    },
  });
  const perception = new RealtimeScreenPerception(
    frames,
    new LatencyRecorder(),
    observer,
    observer,
  );
  const states = await Promise.all([
    perception.observeLatest(),
    perception.observeLatest(),
    perception.observeLatest(),
  ]);
  assert.equal(recognitions, 1);
  assert.deepEqual(states.map((state) => state.observation.sequence), [7, 7, 7]);
  assert.equal(perception.latest()?.kind, "tiktok_feed");
});

test("classifies a TikTok feed from stable navigation labels", () => {
  assert.equal(classifyRuntimeScreen(observation([
    "Following", "For You", "Home", "Friends", "Inbox", "Profile",
  ])).kind, "tiktok_feed");
});

test("full-screen TikTok edge navigation outranks a dark-video App Switcher false positive", () => {
  const fixture = observation([
    "Community", "Local", "Following", "Shop", "For You",
    "Home", "Friends", "Inbox", "Profile",
  ]);
  fixture.elements.slice(0, 5).forEach((element, index) => {
    element.center = { x: 80 + index * 110, y: 140 };
  });
  fixture.elements.slice(5).forEach((element, index) => {
    element.center = { x: 100 + index * 160, y: 1_450 };
  });
  fixture.scene = {
    kind: "app_switcher",
    confidence: 0.94,
    homeGridScore: 0.5,
    keyboardVisible: false,
  };
  assert.equal(classifyRuntimeScreen(fixture).kind, "tiktok_feed");
});

test("classifies TikTok comments and search results", () => {
  assert.equal(classifyRuntimeScreen(observation([
    "234 comments", "Add comment...", "Home", "Inbox",
  ], true)).kind, "tiktok_comments");
  assert.equal(classifyRuntimeScreen(observation([
    "Alhazar", "Top", "Videos", "Users", "Shop", "Sounds", "LIVE",
  ])).kind, "tiktok_results");
  assert.equal(classifyRuntimeScreen(observation([
    "Q Alhazar", "Ask Al", "Videos", "noisy camera text",
  ])).kind, "tiktok_results");
  const gridResults = observation(["Q Alhazar", "Ask Al", "Videos", "Users"]);
  gridResults.scene = {
    kind: "home_grid",
    confidence: 1,
    homeGridScore: 1,
    keyboardVisible: false,
  };
  assert.equal(classifyRuntimeScreen(gridResults).kind, "tiktok_results");
});

test("does not confuse an app-switcher card containing a grid with Home", () => {
  const fixture = observation(["TikTok", "Q Alhazar", "Videos", "Users"]);
  fixture.elements[0].center = { x: 250, y: 205 };
  fixture.scene = {
    kind: "home_grid",
    confidence: 1,
    homeGridScore: 1,
    keyboardVisible: false,
  };
  assert.equal(classifyRuntimeScreen(fixture).kind, "app_switcher");
});

test("preserves generic App Library and App Switcher scene classifications", () => {
  const library = observation(["App Library", "Suggestions", "Recently Added", "Social"]);
  library.scene = {
    kind: "app_library",
    confidence: 0.98,
    homeGridScore: 0.4,
    keyboardVisible: false,
  };
  assert.equal(classifyRuntimeScreen(library).kind, "app_library");

  const switcher = observation(["unknown app card"]);
  switcher.scene = {
    kind: "app_switcher",
    confidence: 0.94,
    homeGridScore: 0.5,
    keyboardVisible: false,
  };
  assert.equal(classifyRuntimeScreen(switcher).kind, "app_switcher");
});

test("classifies TikTok search history with the keyboard open", () => {
  assert.equal(classifyRuntimeScreen(observation([
    "Search", "You may like", "Voice", "Ask AI", "Q W E R T", "A S D F G H",
  ], true)).kind, "tiktok_search");
});

test("classifies a search-result video without Feed bottom navigation", () => {
  assert.equal(classifyRuntimeScreen(observation([
    "Find related content", "See original", "Add comment...", "181", "35",
  ])).kind, "tiktok_video");
});

test("classifies TikTok sound details before the rounded panel resembles App Switcher", () => {
  const fixture = observation([
    "Original Sound", "ldneek", "1 post", "Save", "Add to Story", "Use sound",
  ]);
  fixture.scene = {
    kind: "app_switcher",
    confidence: 0.94,
    homeGridScore: 0.5,
    keyboardVisible: false,
  };
  assert.equal(classifyRuntimeScreen(fixture).kind, "tiktok_sound");
});

test("classifies Instagram home, search results, profile and reel states", () => {
  assert.equal(classifyRuntimeScreen(observation([
    "Instagram", "Your story", "Suggested for you", "Follow",
  ])).kind, "instagram_home");

  const results = observation([
    "Q Nonna Sofia", "Cancel", "nonnasofiahealth", "Nonna.Sofia", "nonnasofiaischa",
  ], true);
  results.elements.slice(2).forEach((element, index) => {
    element.center = { x: 180, y: 500 + index * 70 };
  });
  assert.equal(classifyRuntimeScreen(results).kind, "instagram_results");

  assert.equal(classifyRuntimeScreen(observation([
    "nonnasofiahealth", "277 posts", "63.3K followers", "5 following", "Follow", "Message",
  ])).kind, "instagram_profile");

  assert.equal(classifyRuntimeScreen(observation([
    "nonnasofiahealth", "Original audio", "Likes", "132", "Add comment...", "Comment “Fast” if ready",
  ])).kind, "instagram_reel");
});

test("classifies an Instagram Reels grid when view metrics are below the profile header", () => {
  const fixture = observation([
    "nonnasofiahealth", "277 posts", "63.3K followers", "5 following", "Follow", "Message",
    "€ 7,068", "° 8,966", "© 3,809",
  ]);
  fixture.elements.slice(-3).forEach((element, index) => {
    element.center = { x: 80 + index * 240, y: 1_050 };
  });
  assert.equal(classifyRuntimeScreen(fixture).kind, "instagram_reels_grid");
});

function observation(labels: string[], keyboardVisible = false): ScreenObservation {
  return {
    sequence: 1,
    capturedAt: Date.now(),
    viewport: { width: 720, height: 1_560 },
    fingerprint: "fixture",
    changeRatio: null,
    changeKind: "first",
    ocrCacheHit: false,
    ocrElapsedMs: 10,
    observationElapsedMs: 12,
    averageTextConfidence: 0.9,
    textSignature: new Set(labels),
    elements: labels.map((text, index) => ({
      id: String(index),
      role: "text",
      text,
      confidence: 0.9,
      center: { x: 100, y: 100 + index * 40 },
      bounds: { left: 50, top: 80 + index * 40, width: 100, height: 20 },
    })),
    scene: {
      kind: keyboardVisible ? "keyboard" : "text_ui",
      confidence: 0.9,
      homeGridScore: 0,
      keyboardVisible,
    },
  };
}

function tiktokFeedOcr(): VisionOcrResult {
  const labels = ["Following", "For You", "Home", "Friends", "Inbox", "Profile"];
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 5,
    items: labels.map((text, index) => ({
      text,
      confidence: 0.96,
      left: 80 + index * 80,
      top: 1_400,
      width: 70,
      height: 30,
      centerX: 115 + index * 80,
      centerY: 1_415,
    })),
  };
}
