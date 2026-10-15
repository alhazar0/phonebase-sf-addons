import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import sharp from "sharp";

import { SemanticSceneGraphTracker } from "./semantic-scene-graph";
import {
  detectVisualAffordances,
  type VisualAffordanceSymbol,
} from "./visual-affordance-detector";

const SYMBOLS = ["back", "close", "add", "search"] as const;
const SYMBOL_SET = new Set<string>(SYMBOLS);
const HOLDOUT_SCENARIOS = [
  "settings_navigation",
  "search",
  "scrolling",
  "forms_keyboards",
  "media_video",
  "popup_overlay",
] as const;
const PLATFORMS = ["ios", "android"] as const;
const NAVIGATION_CLASSES = [
  "ios_gesture",
  "ios_physical_home",
  "android_gesture",
  "android_three_button",
] as const;
const FRAME_POLARITIES = ["positive", "negative", "mixed"] as const;
const PRODUCTION_MINIMUM_HOLDOUT_CAPTURE_GROUPS = 6;
const PRODUCTION_MINIMUM_HOLDOUT_DEVICES = 3;
const PRODUCTION_MINIMUM_TARGET_HIT_RATE = 0.9;
const PRODUCTION_MINIMUM_CANDIDATE_PRECISION = 0.95;
const PRODUCTION_MAXIMUM_P95_MS = 100;
const PRODUCTION_MINIMUM_NEGATIVE_FRAMES_PER_DEVICE = 1;

export type RealCameraCorpusSplit = "development" | "holdout";
export type RealCameraHoldoutScenario = typeof HOLDOUT_SCENARIOS[number];
export type RealCameraPlatform = typeof PLATFORMS[number];
export type RealCameraNavigationClass = typeof NAVIGATION_CLASSES[number];

export type RealCameraGroundingTarget = {
  id: string;
  symbol: VisualAffordanceSymbol;
  hitArea: { left: number; top: number; width: number; height: number };
};

export type RealCameraCorpusEntry = {
  id: string;
  imagePath: string;
  sha256: string;
  source: "physical_camera";
  deviceId: string;
  captureGroup: string;
  split: RealCameraCorpusSplit;
  usedForTuning: boolean;
  annotationStatus: "reviewed";
  sceneKind: string;
  viewport: { width: number; height: number };
  targets: RealCameraGroundingTarget[];
  forbiddenSymbols: VisualAffordanceSymbol[];
  physicalDeviceKey: string | null;
  captureSession: string | null;
  capturedAt: string | null;
  platform: RealCameraPlatform | null;
  navigationClass: RealCameraNavigationClass | null;
  scenario: RealCameraHoldoutScenario | null;
  polarity: typeof FRAME_POLARITIES[number] | null;
  review: {
    reviewerId: string;
    reviewedAt: string;
    annotationToolVersion: string;
  } | null;
};

export type RealCameraCorpusManifest = {
  version: "2026-09-01" | "2026-09-02";
  corpusId: string;
  frozenAt: string;
  holdoutStatus: "unpopulated" | "frozen";
  partitionUnit: "capture_group";
  gate: {
    minimumHoldoutCaptureGroups: number;
    minimumHoldoutDevices: number;
    minimumTargetHitRate: number;
    minimumCandidatePrecision: number;
    maximumP95Ms: number;
    requiredHoldoutScenarios: RealCameraHoldoutScenario[];
    requiredPlatforms: RealCameraPlatform[];
    minimumNegativeFramesPerDevice: number;
    requireDeviceDisjointSplits: boolean;
  };
  entries: RealCameraCorpusEntry[];
};

export type RealCameraCorpusReport = {
  corpusId: string;
  schemaVersion: RealCameraCorpusManifest["version"];
  holdoutStatus: RealCameraCorpusManifest["holdoutStatus"];
  evaluatedSplit: RealCameraCorpusSplit;
  entryCount: number;
  developmentEntries: number;
  holdoutEntries: number;
  holdoutCaptureGroups: number;
  holdoutDevices: number;
  holdoutScenarios: RealCameraHoldoutScenario[];
  holdoutPlatforms: RealCameraPlatform[];
  holdoutNavigationClasses: RealCameraNavigationClass[];
  holdoutNegativeFrames: number;
  targetCount: number;
  targetHits: number;
  targetHitRate: number;
  candidateCount: number;
  candidateHits: number;
  candidatePrecision: number;
  latencyMs: { p50: number; p95: number; maximum: number };
  entries: Array<{
    id: string;
    split: RealCameraCorpusSplit;
    evaluated: boolean;
    checksumValid: boolean;
    dimensionsValid: boolean;
    targets: number;
    targetHits: number;
    candidates: number;
    candidateHits: number;
    forbiddenHits: VisualAffordanceSymbol[];
    elapsedMs: number;
    error: string | null;
  }>;
  gate: {
    mode: "development" | "promotion";
    passed: boolean;
    promotionEligible: boolean;
    blockers: string[];
    warnings: string[];
  };
};

export function parseRealCameraCorpusManifest(value: unknown): RealCameraCorpusManifest {
  const input = record(value, "manifest");
  exactKeys(input, [
    "version", "corpusId", "frozenAt", "holdoutStatus", "partitionUnit", "gate", "entries",
  ], "manifest");
  const version = oneOf(
    input.version,
    ["2026-09-01", "2026-09-02"] as const,
    "version",
  );
  const holdoutStatus = oneOf(input.holdoutStatus, ["unpopulated", "frozen"], "holdoutStatus");
  if (input.partitionUnit !== "capture_group") {
    throw new Error("partitionUnit must be capture_group.");
  }
  const gateInput = record(input.gate, "gate");
  exactKeys(gateInput, version === "2026-09-02" ? [
    "minimumHoldoutCaptureGroups", "minimumHoldoutDevices", "minimumTargetHitRate",
    "minimumCandidatePrecision", "maximumP95Ms",
    "requiredHoldoutScenarios", "requiredPlatforms", "minimumNegativeFramesPerDevice",
    "requireDeviceDisjointSplits",
  ] : [
    "minimumHoldoutCaptureGroups", "minimumHoldoutDevices", "minimumTargetHitRate",
    "minimumCandidatePrecision", "maximumP95Ms",
  ], "gate");
  if (!Array.isArray(input.entries) || !input.entries.length) {
    throw new Error("entries must contain at least one real camera annotation.");
  }
  const entries = input.entries.map((entry, index) => parseEntry(entry, index, version));
  const ids = new Set<string>();
  const frozenAt = isoTimestamp(input.frozenAt, "frozenAt");
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate corpus entry id ${entry.id}.`);
    ids.add(entry.id);
    if (entry.split === "holdout" && entry.usedForTuning) {
      throw new Error(`Holdout entry ${entry.id} cannot be marked usedForTuning.`);
    }
    if (entry.capturedAt && Date.parse(entry.capturedAt) > Date.parse(frozenAt)) {
      throw new Error(`Entry ${entry.id} was captured after the corpus freeze time.`);
    }
    if (entry.review && entry.capturedAt) {
      if (Date.parse(entry.review.reviewedAt) < Date.parse(entry.capturedAt)) {
        throw new Error(`Entry ${entry.id} was reviewed before it was captured.`);
      }
      if (Date.parse(entry.review.reviewedAt) > Date.parse(frozenAt)) {
        throw new Error(`Entry ${entry.id} was reviewed after the corpus freeze time.`);
      }
    }
  }
  if (holdoutStatus === "frozen" && !entries.some((entry) => entry.split === "holdout")) {
    throw new Error("A frozen holdout must contain at least one holdout entry.");
  }
  const gate = {
    minimumHoldoutCaptureGroups: positiveInteger(
      gateInput.minimumHoldoutCaptureGroups,
      "minimumHoldoutCaptureGroups",
    ),
    minimumHoldoutDevices: positiveInteger(
      gateInput.minimumHoldoutDevices,
      "minimumHoldoutDevices",
    ),
    minimumTargetHitRate: ratioValue(gateInput.minimumTargetHitRate, "minimumTargetHitRate"),
    minimumCandidatePrecision: ratioValue(
      gateInput.minimumCandidatePrecision,
      "minimumCandidatePrecision",
    ),
    maximumP95Ms: positiveNumber(gateInput.maximumP95Ms, "maximumP95Ms"),
    requiredHoldoutScenarios: version === "2026-09-02"
      ? uniqueValues(
          gateInput.requiredHoldoutScenarios,
          HOLDOUT_SCENARIOS,
          "requiredHoldoutScenarios",
        )
      : [],
    requiredPlatforms: version === "2026-09-02"
      ? uniqueValues(gateInput.requiredPlatforms, PLATFORMS, "requiredPlatforms")
      : [],
    minimumNegativeFramesPerDevice: version === "2026-09-02"
      ? nonNegativeInteger(
          gateInput.minimumNegativeFramesPerDevice,
          "minimumNegativeFramesPerDevice",
        )
      : 0,
    requireDeviceDisjointSplits: version === "2026-09-02"
      ? booleanValue(
          gateInput.requireDeviceDisjointSplits,
          "requireDeviceDisjointSplits",
        )
      : false,
  };
  if (version === "2026-09-02") assertProductionGateFloor(gate);
  return {
    version,
    corpusId: boundedString(input.corpusId, "corpusId", 160),
    frozenAt,
    holdoutStatus,
    partitionUnit: "capture_group",
    gate,
    entries,
  };
}

export async function loadRealCameraCorpusManifest(path: string) {
  return parseRealCameraCorpusManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function evaluateRealCameraCorpus(
  manifest: RealCameraCorpusManifest,
  imageRoot: string,
  options: { allowDevelopmentOnly?: boolean } = {},
): Promise<RealCameraCorpusReport> {
  const blockers = partitionBlockers(manifest);
  const warnings: string[] = [];
  const evaluatedSplit: RealCameraCorpusSplit = options.allowDevelopmentOnly
    ? "development"
    : "holdout";
  const results: RealCameraCorpusReport["entries"] = [];
  let targetCount = 0;
  let targetHits = 0;
  let candidateCount = 0;
  let candidateHits = 0;
  const latencies: number[] = [];

  for (const entry of manifest.entries) {
    if (entry.split !== evaluatedSplit) {
      results.push({
        id: entry.id,
        split: entry.split,
        evaluated: false,
        checksumValid: false,
        dimensionsValid: false,
        targets: entry.targets.length,
        targetHits: 0,
        candidates: 0,
        candidateHits: 0,
        forbiddenHits: [],
        elapsedMs: 0,
        error: null,
      });
      continue;
    }
    let checksumValid = false;
    let dimensionsValid = false;
    try {
      const imagePath = resolveCorpusImage(imageRoot, entry.imagePath);
      const image = await readFile(imagePath);
      checksumValid = createHash("sha256").update(image).digest("hex") === entry.sha256;
      if (!checksumValid) throw new Error("image SHA-256 does not match the frozen manifest");
      const metadata = await sharp(image).metadata();
      dimensionsValid = metadata.width === entry.viewport.width &&
        metadata.height === entry.viewport.height;
      if (!dimensionsValid) {
        throw new Error(
          `image dimensions ${metadata.width ?? 0}x${metadata.height ?? 0} do not match ` +
          `${entry.viewport.width}x${entry.viewport.height}`,
        );
      }
      const detection = await detectVisualAffordances(image, { viewport: entry.viewport });
      const graph = new SemanticSceneGraphTracker().update({
        sequence: 1,
        fingerprint: entry.sha256.slice(0, 20),
        viewport: entry.viewport,
        scene: { kind: entry.sceneKind, keyboardVisible: false },
        elements: [],
        visualAffordances: detection.candidates,
      });
      const candidates = graph.nodes
        .filter((node) => node.interactive && SYMBOL_SET.has(node.normalizedLabel))
        .map((node) => ({
          symbol: node.normalizedLabel as VisualAffordanceSymbol,
          center: node.interactionPoint,
        }));
      const hits = entry.targets.filter((target) =>
        candidates.some((candidate) => candidateHitsTarget(candidate, target))
      ).length;
      const grounded = candidates.filter((candidate) =>
        entry.targets.some((target) => candidateHitsTarget(candidate, target))
      ).length;
      const forbiddenHits = [...new Set(candidates
        .filter((candidate) => entry.forbiddenSymbols.includes(candidate.symbol))
        .map((candidate) => candidate.symbol))];
      if (forbiddenHits.length) {
        blockers.push(`${entry.id} produced forbidden symbols: ${forbiddenHits.join(", ")}`);
      }
      targetCount += entry.targets.length;
      targetHits += hits;
      candidateCount += candidates.length;
      candidateHits += grounded;
      latencies.push(detection.elapsedMs);
      results.push({
        id: entry.id,
        split: entry.split,
        evaluated: true,
        checksumValid,
        dimensionsValid,
        targets: entry.targets.length,
        targetHits: hits,
        candidates: candidates.length,
        candidateHits: grounded,
        forbiddenHits,
        elapsedMs: detection.elapsedMs,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      blockers.push(`${entry.id}: ${message}`);
      results.push({
        id: entry.id,
        split: entry.split,
        evaluated: true,
        checksumValid,
        dimensionsValid,
        targets: entry.targets.length,
        targetHits: 0,
        candidates: 0,
        candidateHits: 0,
        forbiddenHits: [],
        elapsedMs: 0,
        error: message,
      });
    }
  }

  const targetHitRate = metricRatio(targetHits, targetCount);
  const candidatePrecision = metricRatio(candidateHits, candidateCount, 1);
  const p95 = percentile(latencies, 0.95);
  if (!targetCount) {
    blockers.push(`${evaluatedSplit} split contains no annotated positive targets`);
  } else if (targetHitRate < manifest.gate.minimumTargetHitRate) {
    blockers.push(
      `target hit rate ${targetHitRate} is below ${manifest.gate.minimumTargetHitRate}`,
    );
  }
  if (candidatePrecision < manifest.gate.minimumCandidatePrecision) {
    blockers.push(
      `candidate precision ${candidatePrecision} is below ` +
      `${manifest.gate.minimumCandidatePrecision}`,
    );
  }
  if (p95 > manifest.gate.maximumP95Ms) {
    blockers.push(`P95 ${p95} ms exceeds ${manifest.gate.maximumP95Ms} ms`);
  }

  const holdout = manifest.entries.filter((entry) => entry.split === "holdout");
  const holdoutCaptureGroups = new Set(holdout.map((entry) => entry.captureGroup)).size;
  const holdoutDevices = new Set(holdout.map((entry) =>
    entry.physicalDeviceKey ?? entry.deviceId
  )).size;
  const holdoutScenarios = [...new Set(holdout
    .map((entry) => entry.scenario)
    .filter((scenario): scenario is RealCameraHoldoutScenario => scenario !== null))];
  const holdoutPlatforms = [...new Set(holdout
    .map((entry) => entry.platform)
    .filter((platform): platform is RealCameraPlatform => platform !== null))];
  const holdoutNavigationClasses = [...new Set(holdout
    .map((entry) => entry.navigationClass)
    .filter((value): value is RealCameraNavigationClass => value !== null))];
  const holdoutNegativeFrames = holdout.filter((entry) =>
    entry.polarity === "negative"
  ).length;
  let promotionEligible = manifest.holdoutStatus === "frozen" &&
    manifest.version === "2026-09-02";
  if (manifest.version !== "2026-09-02") {
    const message = "real-camera corpus schema 2026-09-01 lacks promotion provenance";
    if (options.allowDevelopmentOnly) warnings.push(message);
    else blockers.push(message);
  }
  if (manifest.holdoutStatus !== "frozen") {
    promotionEligible = false;
    const message = "the held-out real-camera partition is not frozen";
    if (options.allowDevelopmentOnly) warnings.push(message);
    else blockers.push(message);
  }
  if (holdoutCaptureGroups < manifest.gate.minimumHoldoutCaptureGroups) {
    promotionEligible = false;
    const message = `holdout capture groups ${holdoutCaptureGroups} are below ` +
      `${manifest.gate.minimumHoldoutCaptureGroups}`;
    if (options.allowDevelopmentOnly) warnings.push(message);
    else blockers.push(message);
  }
  if (holdoutDevices < manifest.gate.minimumHoldoutDevices) {
    promotionEligible = false;
    const message = `holdout devices ${holdoutDevices} are below ` +
      `${manifest.gate.minimumHoldoutDevices}`;
    if (options.allowDevelopmentOnly) warnings.push(message);
    else blockers.push(message);
  }
  const missingScenarios = manifest.gate.requiredHoldoutScenarios.filter((scenario) =>
    !holdoutScenarios.includes(scenario)
  );
  if (missingScenarios.length) {
    promotionEligible = false;
    const message = `holdout scenarios missing: ${missingScenarios.join(", ")}`;
    if (options.allowDevelopmentOnly) warnings.push(message);
    else blockers.push(message);
  }
  const missingPlatforms = manifest.gate.requiredPlatforms.filter((platform) =>
    !holdoutPlatforms.includes(platform)
  );
  if (missingPlatforms.length) {
    promotionEligible = false;
    const message = `holdout platforms missing: ${missingPlatforms.join(", ")}`;
    if (options.allowDevelopmentOnly) warnings.push(message);
    else blockers.push(message);
  }
  const holdoutByDevice = new Map<string, RealCameraCorpusEntry[]>();
  for (const entry of holdout) {
    const key = entry.physicalDeviceKey ?? entry.deviceId;
    holdoutByDevice.set(key, [...(holdoutByDevice.get(key) ?? []), entry]);
  }
  for (const [device, entries] of holdoutByDevice) {
    const negatives = entries.filter((entry) => entry.polarity === "negative").length;
    if (negatives < manifest.gate.minimumNegativeFramesPerDevice) {
      promotionEligible = false;
      const message = `holdout device ${device} has ${negatives} negative frames; ` +
        `${manifest.gate.minimumNegativeFramesPerDevice} required`;
      if (options.allowDevelopmentOnly) warnings.push(message);
      else blockers.push(message);
    }
  }

  return {
    corpusId: manifest.corpusId,
    schemaVersion: manifest.version,
    holdoutStatus: manifest.holdoutStatus,
    evaluatedSplit,
    entryCount: manifest.entries.length,
    developmentEntries: manifest.entries.length - holdout.length,
    holdoutEntries: holdout.length,
    holdoutCaptureGroups,
    holdoutDevices,
    holdoutScenarios,
    holdoutPlatforms,
    holdoutNavigationClasses,
    holdoutNegativeFrames,
    targetCount,
    targetHits,
    targetHitRate,
    candidateCount,
    candidateHits,
    candidatePrecision,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95,
      maximum: latencies.length ? round(Math.max(...latencies)) : 0,
    },
    entries: results,
    gate: {
      mode: options.allowDevelopmentOnly ? "development" : "promotion",
      passed: blockers.length === 0,
      promotionEligible: promotionEligible && blockers.length === 0,
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
    },
  };
}

function parseEntry(
  value: unknown,
  index: number,
  version: RealCameraCorpusManifest["version"],
): RealCameraCorpusEntry {
  const input = record(value, `entries[${index}]`);
  const baseKeys = [
    "id", "imagePath", "sha256", "source", "deviceId", "captureGroup", "split",
    "usedForTuning", "annotationStatus", "sceneKind", "viewport", "targets",
    "forbiddenSymbols",
  ];
  exactKeys(input, version === "2026-09-02" ? [
    ...baseKeys,
    "physicalDeviceKey",
    "captureSession",
    "capturedAt",
    "platform",
    "navigationClass",
    "scenario",
    "polarity",
    "review",
  ] : baseKeys, `entries[${index}]`);
  if (input.source !== "physical_camera") throw new Error(`entries[${index}].source is invalid.`);
  if (input.annotationStatus !== "reviewed") {
    throw new Error(`entries[${index}].annotationStatus must be reviewed.`);
  }
  if (typeof input.usedForTuning !== "boolean") {
    throw new Error(`entries[${index}].usedForTuning must be boolean.`);
  }
  const viewport = record(input.viewport, `entries[${index}].viewport`);
  exactKeys(viewport, ["width", "height"], `entries[${index}].viewport`);
  if (!Array.isArray(input.targets) || !Array.isArray(input.forbiddenSymbols)) {
    throw new Error(`entries[${index}] targets and forbiddenSymbols must be arrays.`);
  }
  const imagePath = boundedString(input.imagePath, `entries[${index}].imagePath`, 400);
  if (isAbsolute(imagePath) || imagePath.split(/[\\/]/u).includes("..")) {
    throw new Error(`entries[${index}].imagePath must stay inside the image root.`);
  }
  const sha256 = boundedString(input.sha256, `entries[${index}].sha256`, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`entries[${index}].sha256 is invalid.`);
  const parsedViewport = {
    width: positiveInteger(viewport.width, `entries[${index}].viewport.width`),
    height: positiveInteger(viewport.height, `entries[${index}].viewport.height`),
  };
  const targets = input.targets.map((target, targetIndex) =>
    parseTarget(target, `entries[${index}].targets[${targetIndex}]`)
  );
  const targetIds = new Set<string>();
  for (const target of targets) {
    if (targetIds.has(target.id)) {
      throw new Error(`entries[${index}] contains duplicate target id ${target.id}.`);
    }
    targetIds.add(target.id);
    if (
      target.hitArea.left + target.hitArea.width > parsedViewport.width ||
      target.hitArea.top + target.hitArea.height > parsedViewport.height
    ) throw new Error(`entries[${index}] target ${target.id} leaves the viewport.`);
  }
  const forbiddenSymbols = input.forbiddenSymbols.map((symbol, symbolIndex) =>
    oneOf(symbol, SYMBOLS, `entries[${index}].forbiddenSymbols[${symbolIndex}]`)
  );
  if (new Set(forbiddenSymbols).size !== forbiddenSymbols.length) {
    throw new Error(`entries[${index}].forbiddenSymbols contains duplicates.`);
  }
  for (const target of targets) {
    if (forbiddenSymbols.includes(target.symbol)) {
      throw new Error(
        `entries[${index}] marks target symbol ${target.symbol} as forbidden.`,
      );
    }
  }
  const polarity = version === "2026-09-02"
    ? oneOf(input.polarity, FRAME_POLARITIES, `entries[${index}].polarity`)
    : null;
  if (polarity === "positive" && targets.length === 0) {
    throw new Error(`entries[${index}] positive frame must contain a target.`);
  }
  if (polarity === "negative" && targets.length !== 0) {
    throw new Error(`entries[${index}] negative frame cannot contain a target.`);
  }
  const physicalDeviceKey = version === "2026-09-02"
    ? boundedString(
        input.physicalDeviceKey,
        `entries[${index}].physicalDeviceKey`,
        160,
      )
    : null;
  const captureSession = version === "2026-09-02"
    ? boundedString(input.captureSession, `entries[${index}].captureSession`, 200)
    : null;
  const capturedAt = version === "2026-09-02"
    ? isoTimestamp(input.capturedAt, `entries[${index}].capturedAt`)
    : null;
  const platform = version === "2026-09-02"
    ? oneOf(input.platform, PLATFORMS, `entries[${index}].platform`)
    : null;
  const navigationClass = version === "2026-09-02"
    ? oneOf(
        input.navigationClass,
        NAVIGATION_CLASSES,
        `entries[${index}].navigationClass`,
      )
    : null;
  const scenario = version === "2026-09-02"
    ? oneOf(input.scenario, HOLDOUT_SCENARIOS, `entries[${index}].scenario`)
    : null;
  const review = version === "2026-09-02"
    ? parseReview(input.review, `entries[${index}].review`)
    : null;
  if (platform && navigationClass && !navigationClass.startsWith(`${platform}_`)) {
    throw new Error(
      `entries[${index}].navigationClass ${navigationClass} is incompatible with ${platform}.`,
    );
  }
  return {
    id: boundedString(input.id, `entries[${index}].id`, 160),
    imagePath,
    sha256,
    source: "physical_camera",
    deviceId: boundedString(input.deviceId, `entries[${index}].deviceId`, 160),
    captureGroup: boundedString(input.captureGroup, `entries[${index}].captureGroup`, 200),
    split: oneOf(input.split, ["development", "holdout"], `entries[${index}].split`),
    usedForTuning: input.usedForTuning,
    annotationStatus: "reviewed",
    sceneKind: boundedString(input.sceneKind, `entries[${index}].sceneKind`, 120),
    viewport: parsedViewport,
    targets,
    forbiddenSymbols,
    physicalDeviceKey,
    captureSession,
    capturedAt,
    platform,
    navigationClass,
    scenario,
    polarity,
    review,
  };
}

function parseReview(value: unknown, path: string) {
  const input = record(value, path);
  exactKeys(input, ["reviewerId", "reviewedAt", "annotationToolVersion"], path);
  return {
    reviewerId: boundedString(input.reviewerId, `${path}.reviewerId`, 160),
    reviewedAt: isoTimestamp(input.reviewedAt, `${path}.reviewedAt`),
    annotationToolVersion: boundedString(
      input.annotationToolVersion,
      `${path}.annotationToolVersion`,
      120,
    ),
  };
}

function parseTarget(value: unknown, path: string): RealCameraGroundingTarget {
  const input = record(value, path);
  exactKeys(input, ["id", "symbol", "hitArea"], path);
  const hitArea = record(input.hitArea, `${path}.hitArea`);
  exactKeys(hitArea, ["left", "top", "width", "height"], `${path}.hitArea`);
  return {
    id: boundedString(input.id, `${path}.id`, 160),
    symbol: oneOf(input.symbol, SYMBOLS, `${path}.symbol`),
    hitArea: {
      left: nonNegativeNumber(hitArea.left, `${path}.hitArea.left`),
      top: nonNegativeNumber(hitArea.top, `${path}.hitArea.top`),
      width: positiveNumber(hitArea.width, `${path}.hitArea.width`),
      height: positiveNumber(hitArea.height, `${path}.hitArea.height`),
    },
  };
}

function partitionBlockers(manifest: RealCameraCorpusManifest) {
  const blockers: string[] = [];
  const groups = new Map<string, Set<RealCameraCorpusSplit>>();
  const sessions = new Map<string, Set<RealCameraCorpusSplit>>();
  const physicalDevices = new Map<string, Set<RealCameraCorpusSplit>>();
  const groupDevices = new Map<string, Set<string>>();
  const groupSessions = new Map<string, Set<string>>();
  const sessionDevices = new Map<string, Set<string>>();
  const hashes = new Map<string, string[]>();
  for (const entry of manifest.entries) {
    const splits = groups.get(entry.captureGroup) ?? new Set<RealCameraCorpusSplit>();
    splits.add(entry.split);
    groups.set(entry.captureGroup, splits);
    if (entry.captureSession) {
      const sessionSplits = sessions.get(entry.captureSession) ??
        new Set<RealCameraCorpusSplit>();
      sessionSplits.add(entry.split);
      sessions.set(entry.captureSession, sessionSplits);
    }
    if (entry.physicalDeviceKey) {
      const deviceSplits = physicalDevices.get(entry.physicalDeviceKey) ??
        new Set<RealCameraCorpusSplit>();
      deviceSplits.add(entry.split);
      physicalDevices.set(entry.physicalDeviceKey, deviceSplits);
    }
    if (entry.physicalDeviceKey && entry.captureSession) {
      addSetValue(groupDevices, entry.captureGroup, entry.physicalDeviceKey);
      addSetValue(groupSessions, entry.captureGroup, entry.captureSession);
      addSetValue(sessionDevices, entry.captureSession, entry.physicalDeviceKey);
    }
    hashes.set(entry.sha256, [...(hashes.get(entry.sha256) ?? []), entry.id]);
  }
  blockers.push(...splitLeakMessages(groups, "capture group"));
  blockers.push(...splitLeakMessages(sessions, "capture session"));
  if (manifest.gate.requireDeviceDisjointSplits) {
    blockers.push(...splitLeakMessages(physicalDevices, "physical device"));
  }
  blockers.push(...bindingConflictMessages(groupDevices, "capture group", "physical devices"));
  blockers.push(...bindingConflictMessages(groupSessions, "capture group", "capture sessions"));
  blockers.push(...bindingConflictMessages(sessionDevices, "capture session", "physical devices"));
  for (const [sha256, ids] of hashes) {
    if (ids.length > 1) {
      blockers.push(
        `image SHA-256 ${sha256} is duplicated by entries ${ids.join(", ")}`,
      );
    }
  }
  return blockers;
}

function addSetValue(values: Map<string, Set<string>>, key: string, value: string) {
  const items = values.get(key) ?? new Set<string>();
  items.add(value);
  values.set(key, items);
}

function bindingConflictMessages(
  values: Map<string, Set<string>>,
  subject: string,
  binding: string,
) {
  return [...values.entries()]
    .filter(([, items]) => items.size > 1)
    .map(([value, items]) =>
      `${subject} ${value} is bound to multiple ${binding}: ${[...items].join(", ")}`
    );
}

function splitLeakMessages(
  values: Map<string, Set<RealCameraCorpusSplit>>,
  label: string,
) {
  return [...values.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([value]) => `${label} ${value} leaks across development and holdout`);
}

function resolveCorpusImage(imageRoot: string, imagePath: string) {
  const root = resolve(imageRoot);
  const target = resolve(root, imagePath);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error("image path escapes the configured corpus root");
  }
  return target;
}

function candidateHitsTarget(
  candidate: { symbol: VisualAffordanceSymbol; center: { x: number; y: number } },
  target: RealCameraGroundingTarget,
) {
  return candidate.symbol === target.symbol &&
    candidate.center.x >= target.hitArea.left &&
    candidate.center.x <= target.hitArea.left + target.hitArea.width &&
    candidate.center.y >= target.hitArea.top &&
    candidate.center.y <= target.hitArea.top + target.hitArea.height;
}

function record(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], name: string) {
  const expected = new Set(allowed);
  const missing = allowed.filter((key) => !(key in value));
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length || unknown.length) {
    throw new Error(
      `${name} fields are invalid` +
      `${missing.length ? `; missing ${missing.join(", ")}` : ""}` +
      `${unknown.length ? `; unknown ${unknown.join(", ")}` : ""}.`,
    );
  }
}

function boundedString(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string up to ${maximum} characters.`);
  }
  return value.trim();
}

function isoTimestamp(value: unknown, name: string) {
  const result = boundedString(value, name, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) ||
    !Number.isFinite(Date.parse(result))
  ) {
    throw new Error(`${name} must be an ISO UTC timestamp.`);
  }
  return result;
}

function uniqueValues<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number][] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${name} must be a non-empty array.`);
  }
  const result = value.map((item, index) => oneOf(item, values, `${name}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} must not contain duplicates.`);
  }
  return result;
}

function assertProductionGateFloor(gate: RealCameraCorpusManifest["gate"]) {
  const violations: string[] = [];
  if (gate.minimumHoldoutCaptureGroups < PRODUCTION_MINIMUM_HOLDOUT_CAPTURE_GROUPS) {
    violations.push(
      `minimumHoldoutCaptureGroups must be at least ` +
      `${PRODUCTION_MINIMUM_HOLDOUT_CAPTURE_GROUPS}`,
    );
  }
  if (gate.minimumHoldoutDevices < PRODUCTION_MINIMUM_HOLDOUT_DEVICES) {
    violations.push(`minimumHoldoutDevices must be at least ${PRODUCTION_MINIMUM_HOLDOUT_DEVICES}`);
  }
  if (gate.minimumTargetHitRate < PRODUCTION_MINIMUM_TARGET_HIT_RATE) {
    violations.push(`minimumTargetHitRate must be at least ${PRODUCTION_MINIMUM_TARGET_HIT_RATE}`);
  }
  if (gate.minimumCandidatePrecision < PRODUCTION_MINIMUM_CANDIDATE_PRECISION) {
    violations.push(
      `minimumCandidatePrecision must be at least ${PRODUCTION_MINIMUM_CANDIDATE_PRECISION}`,
    );
  }
  if (gate.maximumP95Ms > PRODUCTION_MAXIMUM_P95_MS) {
    violations.push(`maximumP95Ms must be at most ${PRODUCTION_MAXIMUM_P95_MS}`);
  }
  const missingScenarios = HOLDOUT_SCENARIOS.filter(
    (scenario) => !gate.requiredHoldoutScenarios.includes(scenario),
  );
  if (missingScenarios.length) {
    violations.push(`requiredHoldoutScenarios is missing ${missingScenarios.join(", ")}`);
  }
  const missingPlatforms = PLATFORMS.filter(
    (platform) => !gate.requiredPlatforms.includes(platform),
  );
  if (missingPlatforms.length) {
    violations.push(`requiredPlatforms is missing ${missingPlatforms.join(", ")}`);
  }
  if (gate.minimumNegativeFramesPerDevice < PRODUCTION_MINIMUM_NEGATIVE_FRAMES_PER_DEVICE) {
    violations.push(
      `minimumNegativeFramesPerDevice must be at least ` +
      `${PRODUCTION_MINIMUM_NEGATIVE_FRAMES_PER_DEVICE}`,
    );
  }
  if (!gate.requireDeviceDisjointSplits) {
    violations.push("requireDeviceDisjointSplits must be true");
  }
  if (violations.length) {
    throw new Error(`2026-09-02 production gate is too weak: ${violations.join("; ")}.`);
  }
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} must be one of ${values.join(", ")}.`);
  }
  return value as T[number];
}

function positiveInteger(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer.`);
  return result;
}

function nonNegativeInteger(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return result;
}

function booleanValue(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`);
  return value;
}

function positiveNumber(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be positive.`);
  return result;
}

function nonNegativeNumber(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${name} must be non-negative.`);
  return result;
}

function ratioValue(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    throw new Error(`${name} must be from 0 to 1.`);
  }
  return result;
}

function metricRatio(numerator: number, denominator: number, empty = 0) {
  return denominator ? round(numerator / denominator) : empty;
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return round(sorted[index]);
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
