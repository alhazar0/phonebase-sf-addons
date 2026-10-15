import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  evaluateRealCameraCorpus,
  parseRealCameraCorpusManifest,
} from "./real-camera-grounding-corpus";

const scenarios = [
  "settings_navigation",
  "search",
  "scrolling",
  "forms_keyboards",
  "media_video",
  "popup_overlay",
] as const;

type RawEntry = {
  id: string;
  imagePath: string;
  sha256: string;
  source: "physical_camera";
  deviceId: string;
  captureGroup: string;
  split: "development" | "holdout";
  usedForTuning: boolean;
  annotationStatus: "reviewed";
  sceneKind: string;
  viewport: { width: number; height: number };
  targets: Array<{
    id: string;
    symbol: "search";
    hitArea: { left: number; top: number; width: number; height: number };
  }>;
  forbiddenSymbols: Array<"back" | "close" | "add" | "search">;
  physicalDeviceKey: string;
  captureSession: string;
  capturedAt: string;
  platform: "ios" | "android";
  navigationClass: "ios_gesture" | "android_gesture" | "android_three_button";
  scenario: typeof scenarios[number];
  polarity: "positive" | "negative" | "mixed";
  review: {
    reviewerId: string;
    reviewedAt: string;
    annotationToolVersion: string;
  };
};

type RawManifest = {
  version: "2026-09-02";
  corpusId: string;
  frozenAt: string;
  holdoutStatus: "frozen";
  partitionUnit: "capture_group";
  gate: {
    minimumHoldoutCaptureGroups: number;
    minimumHoldoutDevices: number;
    minimumTargetHitRate: number;
    minimumCandidatePrecision: number;
    maximumP95Ms: number;
    requiredHoldoutScenarios: Array<typeof scenarios[number]>;
    requiredPlatforms: Array<"ios" | "android">;
    minimumNegativeFramesPerDevice: number;
    requireDeviceDisjointSplits: boolean;
  };
  entries: RawEntry[];
};

test("promotes a frozen v2 corpus with six groups across three physical devices", async (context) => {
  const directory = await temporaryCorpus(context);
  const { value } = await createFixture(directory);
  const report = await evaluateRealCameraCorpus(
    parseRealCameraCorpusManifest(value),
    directory,
  );

  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.promotionEligible, true);
  assert.equal(report.schemaVersion, "2026-09-02");
  assert.equal(report.holdoutCaptureGroups, 6);
  assert.equal(report.holdoutDevices, 3);
  assert.deepEqual(new Set(report.holdoutScenarios), new Set(scenarios));
  assert.deepEqual(new Set(report.holdoutPlatforms), new Set(["ios", "android"]));
  assert.equal(report.holdoutNegativeFrames, 3);
  assert.equal(report.targetHitRate, 1);
  assert.equal(report.candidatePrecision, 1);
  assert.equal(report.entries.filter((entry) => entry.targets === 0).every(
    (entry) => entry.candidates === 0,
  ), true);
});

test("blocks capture-group and physical-device leakage across splits", async (context) => {
  const directory = await temporaryCorpus(context);
  const { value } = await createFixture(directory);
  value.entries[0].split = "development";
  value.entries[0].usedForTuning = true;
  value.entries[0].captureGroup = value.entries[1].captureGroup;
  const report = await evaluateRealCameraCorpus(
    parseRealCameraCorpusManifest(value),
    directory,
  );

  assert.equal(report.gate.passed, false);
  assert.ok(report.gate.blockers.some((blocker) => blocker.includes("capture group")));
  assert.ok(report.gate.blockers.some((blocker) => blocker.includes("physical device")));
});

test("development evaluation never opens frozen holdout images", async (context) => {
  const directory = await temporaryCorpus(context);
  const { value } = await createFixture(directory, [0]);
  value.entries[0].split = "development";
  value.entries[0].usedForTuning = true;
  value.entries[0].physicalDeviceKey = "development-phone";
  const report = await evaluateRealCameraCorpus(
    parseRealCameraCorpusManifest(value),
    directory,
    { allowDevelopmentOnly: true },
  );

  assert.equal(report.evaluatedSplit, "development");
  assert.equal(report.entries[0].evaluated, true);
  assert.equal(report.entries.slice(1).every((entry) => !entry.evaluated), true);
  assert.equal(report.entries.slice(1).every((entry) => entry.error === null), true);
});

test("fails closed when a frozen camera frame changes bytes", async (context) => {
  const directory = await temporaryCorpus(context);
  const { value } = await createFixture(directory);
  value.entries[1].sha256 = "0".repeat(64);
  const report = await evaluateRealCameraCorpus(
    parseRealCameraCorpusManifest(value),
    directory,
  );

  assert.equal(report.gate.passed, false);
  assert.match(report.entries[1].error ?? "", /SHA-256/u);
});

test("legacy v1 camera evidence remains diagnostic-only and cannot promote", async (context) => {
  const directory = await temporaryCorpus(context);
  const search = await searchFrame(false, 20);
  const homeArtwork = await searchFrame(true, 21);
  await Promise.all([
    writeFile(join(directory, "legacy-search.jpg"), search),
    writeFile(join(directory, "legacy-home.jpg"), homeArtwork),
  ]);
  const report = await evaluateRealCameraCorpus(
    parseRealCameraCorpusManifest(legacyManifestValue(digest(search), digest(homeArtwork))),
    directory,
  );

  assert.equal(report.schemaVersion, "2026-09-01");
  assert.equal(report.gate.promotionEligible, false);
  assert.ok(report.gate.blockers.some((blocker) => blocker.includes("lacks promotion provenance")));
});

test("blocks exact duplicate frozen images even when entry metadata differs", async (context) => {
  const directory = await temporaryCorpus(context);
  const { value, frames } = await createFixture(directory);
  await writeFile(join(directory, value.entries[1].imagePath), frames[0]);
  value.entries[1].sha256 = value.entries[0].sha256;
  const report = await evaluateRealCameraCorpus(
    parseRealCameraCorpusManifest(value),
    directory,
  );

  assert.equal(report.gate.passed, false);
  assert.ok(report.gate.blockers.some((blocker) => blocker.includes("is duplicated by entries")));
});

test("blocks missing scenario coverage and missing per-device negative evidence", async (context) => {
  const directory = await temporaryCorpus(context);
  const { value } = await createFixture(directory);
  value.entries[0].scenario = "search";
  value.entries[0].polarity = "mixed";
  const report = await evaluateRealCameraCorpus(
    parseRealCameraCorpusManifest(value),
    directory,
  );

  assert.equal(report.gate.passed, false);
  assert.ok(report.gate.blockers.some((blocker) => blocker.includes("scenarios missing")));
  assert.ok(report.gate.blockers.some((blocker) =>
    blocker.includes("phone-a has 0 negative frames")
  ));
});

test("rejects weak v2 gates and invalid annotation provenance", () => {
  const outsideViewport = manifestValue(fakeHashes());
  outsideViewport.entries[1].targets[0].hitArea.left = 700;
  assert.throws(
    () => parseRealCameraCorpusManifest(outsideViewport),
    /leaves the viewport/u,
  );

  const afterFreeze = manifestValue(fakeHashes());
  afterFreeze.entries[0].review.reviewedAt = "2026-09-01T13:00:00Z";
  assert.throws(
    () => parseRealCameraCorpusManifest(afterFreeze),
    /reviewed after the corpus freeze/u,
  );

  const incompatibleNavigation = manifestValue(fakeHashes());
  incompatibleNavigation.entries[0].platform = "android";
  assert.throws(
    () => parseRealCameraCorpusManifest(incompatibleNavigation),
    /incompatible with android/u,
  );

  const weakGate = manifestValue(fakeHashes());
  weakGate.gate.minimumHoldoutDevices = 2;
  assert.throws(
    () => parseRealCameraCorpusManifest(weakGate),
    /production gate is too weak/u,
  );
});

async function temporaryCorpus(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-real-corpus-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createFixture(directory: string, writeIndices = [0, 1, 2, 3, 4, 5]) {
  const frames = await Promise.all(definitions.map((definition, index) =>
    searchFrame(definition.negative, index)
  ));
  await Promise.all(writeIndices.map((index) =>
    writeFile(join(directory, `frame-${index}.jpg`), frames[index])
  ));
  return { frames, value: manifestValue(frames.map(digest)) };
}

const definitions = [
  { device: "phone-a", platform: "ios", navigationClass: "ios_gesture", negative: true },
  { device: "phone-a", platform: "ios", navigationClass: "ios_gesture", negative: false },
  {
    device: "phone-b",
    platform: "android",
    navigationClass: "android_gesture",
    negative: true,
  },
  {
    device: "phone-b",
    platform: "android",
    navigationClass: "android_gesture",
    negative: false,
  },
  {
    device: "phone-c",
    platform: "android",
    navigationClass: "android_three_button",
    negative: true,
  },
  {
    device: "phone-c",
    platform: "android",
    navigationClass: "android_three_button",
    negative: false,
  },
] as const;

function manifestValue(hashes: string[]): RawManifest {
  assert.equal(hashes.length, definitions.length);
  return {
    version: "2026-09-02",
    corpusId: "synthetic-unit-real-camera-corpus",
    frozenAt: "2026-09-01T12:00:00Z",
    holdoutStatus: "frozen",
    partitionUnit: "capture_group",
    gate: {
      minimumHoldoutCaptureGroups: 6,
      minimumHoldoutDevices: 3,
      minimumTargetHitRate: 0.9,
      minimumCandidatePrecision: 0.95,
      maximumP95Ms: 100,
      requiredHoldoutScenarios: [...scenarios],
      requiredPlatforms: ["ios", "android"],
      minimumNegativeFramesPerDevice: 1,
      requireDeviceDisjointSplits: true,
    },
    entries: definitions.map((definition, index): RawEntry => ({
      id: `fixture-${index}`,
      imagePath: `frame-${index}.jpg`,
      sha256: hashes[index],
      source: "physical_camera",
      deviceId: "fixture-camera-station",
      captureGroup: `heldout-group-${index}`,
      split: "holdout",
      usedForTuning: false,
      annotationStatus: "reviewed",
      sceneKind: definition.negative ? "home_grid" : "text_ui",
      viewport: { width: 720, height: 1_560 },
      targets: definition.negative ? [] : [{
        id: `search-${index}`,
        symbol: "search",
        hitArea: { left: 590, top: 65, width: 120, height: 120 },
      }],
      forbiddenSymbols: definition.negative
        ? ["back", "close", "add", "search"]
        : ["back", "close", "add"],
      physicalDeviceKey: definition.device,
      captureSession: `heldout-session-${index}`,
      capturedAt: `2026-09-01T10:0${index}:00Z`,
      platform: definition.platform,
      navigationClass: definition.navigationClass,
      scenario: scenarios[index],
      polarity: definition.negative ? "negative" : "positive",
      review: {
        reviewerId: "fixture-reviewer",
        reviewedAt: `2026-09-01T11:0${index}:00Z`,
        annotationToolVersion: "unit-fixture-1",
      },
    })),
  };
}

function legacyManifestValue(searchSha256: string, homeSha256: string) {
  return {
    version: "2026-09-01",
    corpusId: "legacy-unit-real-camera-corpus",
    frozenAt: "2026-09-01T12:00:00Z",
    holdoutStatus: "frozen",
    partitionUnit: "capture_group",
    gate: {
      minimumHoldoutCaptureGroups: 1,
      minimumHoldoutDevices: 1,
      minimumTargetHitRate: 1,
      minimumCandidatePrecision: 1,
      maximumP95Ms: 300,
    },
    entries: [
      {
        id: "legacy-home",
        imagePath: "legacy-home.jpg",
        sha256: homeSha256,
        source: "physical_camera",
        deviceId: "legacy-device",
        captureGroup: "legacy-home-group",
        split: "holdout",
        usedForTuning: false,
        annotationStatus: "reviewed",
        sceneKind: "home_grid",
        viewport: { width: 720, height: 1_560 },
        targets: [],
        forbiddenSymbols: ["back", "close", "add", "search"],
      },
      {
        id: "legacy-search",
        imagePath: "legacy-search.jpg",
        sha256: searchSha256,
        source: "physical_camera",
        deviceId: "legacy-device",
        captureGroup: "legacy-search-group",
        split: "holdout",
        usedForTuning: false,
        annotationStatus: "reviewed",
        sceneKind: "text_ui",
        viewport: { width: 720, height: 1_560 },
        targets: [{
          id: "search",
          symbol: "search",
          hitArea: { left: 590, top: 65, width: 120, height: 120 },
        }],
        forbiddenSymbols: ["back", "close", "add"],
      },
    ],
  };
}

function searchFrame(homeArtwork: boolean, variant: number) {
  const background = homeArtwork ? `rgb(${150 + variant}, 45, 28)` : "#111827";
  const surround = homeArtwork
    ? '<rect x="570" y="62" width="140" height="140" rx="30" fill="#f1f1ed"/>'
    : "";
  const svg = `
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1560" fill="${background}"/>
      <rect x="${20 + variant}" y="1510" width="12" height="12" fill="rgb(${variant}, 80, 120)"/>
      ${surround}
      <circle cx="650" cy="115" r="24" fill="none" stroke="#f8fafc" stroke-width="7"/>
      <path d="M667 132 L693 158" fill="none" stroke="#f8fafc" stroke-width="7" stroke-linecap="round"/>
    </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

function fakeHashes() {
  return definitions.map((_, index) => digest(Buffer.from(`fixture-${index}`)));
}

function digest(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
