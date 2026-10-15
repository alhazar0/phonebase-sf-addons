import { createHash } from "node:crypto";
import sharp from "sharp";

import { looksLikeIosKeyboard, visionTextSignature } from "./fast-intent";
import { iosEnglishKeyboardVisible } from "./ios-keyboard-visibility";
import type {
  ScreenElement,
  ScreenObservation,
  ScreenScene,
} from "./general-agent-contract";
import { analyzeFrameDelta, type VisualChangeRegion } from "./frame-delta";
import { SemanticSceneGraphTracker } from "./semantic-scene-graph";
import {
  detectVisualAffordances,
  type VisualAffordance,
  type VisualAffordanceDetection,
  type VisualAffordanceDetectorOptions,
} from "./visual-affordance-detector";
import {
  recognizeVisionText,
  type VisionOcrMode,
  type VisionOcrResult,
} from "./vision-ocr";

export type AgentFrame = {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  capturedAt: number;
  sequence: number;
};

export type ScreenObserverOptions = {
  stableDifferenceThreshold?: number;
  ocrMode?: VisionOcrMode | "adaptive";
  maximumCacheEntries?: number;
  incrementalOcr?: boolean;
  maximumIncrementalAreaRatio?: number;
  maximumIncrementalRegions?: number;
  minimumFullOcrMsForIncremental?: number;
  minimumFullOcrSamplesForIncremental?: number;
  sceneGraph?: SemanticSceneGraphTracker;
  recognize?: (
    dataUrl: string,
    signal?: AbortSignal,
    mode?: VisionOcrMode,
  ) => Promise<VisionOcrResult>;
  detectAffordances?: (
    imageBuffer: Buffer,
    options: VisualAffordanceDetectorOptions,
  ) => Promise<VisualAffordanceDetection>;
};

type SampledFrame = {
  pixels: Buffer;
  fingerprint: string;
  ocr: VisionOcrResult;
  width: number;
  height: number;
  keyboardVisibleFromPixels: boolean;
  visualAffordances: VisualAffordance[];
};

type VisualSceneHints = {
  insetAppCardScore: number;
  darkScreenScore: number;
};

export class ScreenObserver {
  private previous: SampledFrame | null = null;
  private readonly sequenceCache = new Map<number, ScreenObservation>();
  private readonly stableDifferenceThreshold: number;
  private readonly ocrMode: VisionOcrMode | "adaptive";
  private readonly maximumCacheEntries: number;
  private readonly incrementalOcr: boolean;
  private readonly maximumIncrementalAreaRatio: number;
  private readonly maximumIncrementalRegions: number;
  private readonly minimumFullOcrMsForIncremental: number;
  private readonly minimumFullOcrSamplesForIncremental: number;
  private readonly sceneGraph: SemanticSceneGraphTracker;
  private readonly recognize: NonNullable<ScreenObserverOptions["recognize"]>;
  private readonly detectAffordances: NonNullable<ScreenObserverOptions["detectAffordances"]>;
  private readonly fullOcrLatencies: number[] = [];
  private readonly regionOcrLatencies: number[] = [];
  private observationsSinceFullOcr = 0;

  constructor(options: ScreenObserverOptions = {}) {
    this.stableDifferenceThreshold = options.stableDifferenceThreshold ?? 0.012;
    this.ocrMode = options.ocrMode ?? "adaptive";
    this.maximumCacheEntries = options.maximumCacheEntries ?? 12;
    this.incrementalOcr = options.incrementalOcr ?? true;
    this.maximumIncrementalAreaRatio = boundedRatio(
      options.maximumIncrementalAreaRatio,
      0.42,
    );
    this.maximumIncrementalRegions = boundedInteger(
      options.maximumIncrementalRegions,
      1,
      6,
      3,
    );
    this.minimumFullOcrMsForIncremental = boundedNumber(
      options.minimumFullOcrMsForIncremental,
      0,
      10_000,
      75,
    );
    this.minimumFullOcrSamplesForIncremental = boundedInteger(
      options.minimumFullOcrSamplesForIncremental,
      1,
      10,
      3,
    );
    this.sceneGraph = options.sceneGraph ?? new SemanticSceneGraphTracker();
    this.recognize = options.recognize ?? recognizeVisionText;
    this.detectAffordances = options.detectAffordances ?? detectVisualAffordances;
  }

  async observe(frame: AgentFrame, signal?: AbortSignal, options: {freshOcr?:boolean} = {}): Promise<ScreenObservation> {
    const startedAt = performance.now();
    const cached = this.sequenceCache.get(frame.sequence);
    if (cached && !options.freshOcr) {
      return {
        ...cached,
        ocrCacheHit: true,
        ocrElapsedMs: 0,
        observationElapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
        textSignature: new Set(cached.textSignature),
      };
    }

    const pixels = await sampleFrame(frame.bytes);
    const visualSceneHints = sceneHintsFromSample(pixels);
    const fingerprint = createHash("sha256").update(pixels).digest("hex").slice(0, 20);
    const delta = analyzeFrameDelta(
      this.previous?.pixels ?? null,
      pixels,
      { width: frame.width, height: frame.height },
      { stableDifferenceThreshold: this.stableDifferenceThreshold },
    );
    const canReuseOcr = !options.freshOcr && Boolean(this.previous && delta.changeKind === "stable");
    const recognitionMode = this.ocrMode === "adaptive" ? "fast" : this.ocrMode;
    let ocrStrategy: NonNullable<ScreenObservation["ocrStrategy"]> = "full";
    let ocrRegionCount = 1;
    let ocr: VisionOcrResult;
    if (canReuseOcr) {
      ocr = this.previous!.ocr;
      ocrStrategy = "cache";
      ocrRegionCount = 0;
    } else if (!options.freshOcr && this.canUseIncrementalOcr(frame, delta.regions, delta.changedAreaRatio)) {
      try {
        ocr = await recognizeChangedRegions(
          frame,
          this.previous!.ocr,
          delta.regions,
          this.recognize,
          recognitionMode,
          signal,
        );
        ocrStrategy = "regions";
        ocrRegionCount = delta.regions.length;
      } catch (error) {
        if (signal?.aborted) throw error;
        ocr = await this.recognize(frameDataUrl(frame), signal, recognitionMode);
      }
    } else {
      ocr = await this.recognize(frameDataUrl(frame), signal, recognitionMode);
    }
    let ocrElapsedMs = canReuseOcr ? 0 : ocr.elapsedMs;
    let elements = logicalElements(ocr, frame.width, frame.height);
    const keyboardVisibleFromPixels = looksLikeIosKeyboard(ocr)
      ? false
      : this.shouldRefreshKeyboardFingerprint(frame, delta.regions, delta.changeKind)
        ? iosEnglishKeyboardVisible(frame.bytes)
        : this.previous?.keyboardVisibleFromPixels ?? false;
    let scene = classifyScene(
      ocr,
      elements,
      frame.width,
      frame.height,
      keyboardVisibleFromPixels,
      visualSceneHints,
    );
    let visualAffordances: VisualAffordance[];
    let affordanceElapsedMs = 0;
    if (canReuseOcr) {
      visualAffordances = this.previous!.visualAffordances;
    } else if (scene.kind === "screen_off") {
      visualAffordances = [];
    } else {
      const detection = await this.detectAffordances(frame.bytes, {
        viewport: { width: frame.width, height: frame.height },
        excludeBounds: elements.map((element) => ({ ...element.bounds })),
        ...(scene.keyboardVisible ? { excludeBottomRatio: 0.56 } : {}),
      });
      visualAffordances = detection.candidates;
      affordanceElapsedMs = detection.elapsedMs;
    }
    scene = classifyScene(
      ocr,
      elements,
      frame.width,
      frame.height,
      keyboardVisibleFromPixels,
      visualSceneHints,
      visualAffordances,
    );
    if (
      !canReuseOcr && this.ocrMode === "adaptive" &&
      shouldEscalateOcr(scene, elements)
    ) {
      const accurate = await this.recognize(frameDataUrl(frame), signal, "accurate");
      ocrElapsedMs += accurate.elapsedMs;
      ocr = accurate;
      ocrStrategy = "full";
      ocrRegionCount = 1;
      elements = logicalElements(ocr, frame.width, frame.height);
      scene = classifyScene(
        ocr,
        elements,
        frame.width,
        frame.height,
        keyboardVisibleFromPixels,
        visualSceneHints,
        visualAffordances,
      );
    }
    if (!canReuseOcr) {
      if (ocrStrategy === "regions") {
        recordLatency(this.regionOcrLatencies, ocrElapsedMs);
        this.observationsSinceFullOcr += 1;
      } else {
        recordLatency(this.fullOcrLatencies, ocrElapsedMs);
        this.observationsSinceFullOcr = 0;
      }
    }
    const sceneGraph = this.sceneGraph.update({
      sequence: frame.sequence,
      fingerprint,
      viewport: { width: frame.width, height: frame.height },
      elements,
      scene,
      changedRegions: delta.regions,
      visualAffordances,
    });
    const observation: ScreenObservation = {
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
      viewport: { width: frame.width, height: frame.height },
      fingerprint,
      changeRatio: delta.changeRatio,
      changeKind: delta.changeKind,
      ocrCacheHit: canReuseOcr,
      ocrElapsedMs,
      ocrStrategy,
      ocrRegionCount,
      visualAffordances,
      affordanceCacheHit: canReuseOcr,
      affordanceElapsedMs,
      changedRegions: delta.regions,
      observationElapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      averageTextConfidence: average(elements.map((element) => element.confidence)),
      textSignature: visionTextSignature(ocr),
      elements,
      scene,
      sceneGraph,
    };
    this.previous = {
      pixels,
      fingerprint,
      ocr,
      width: frame.width,
      height: frame.height,
      keyboardVisibleFromPixels,
      visualAffordances,
    };
    this.sequenceCache.set(frame.sequence, observation);
    while (this.sequenceCache.size > this.maximumCacheEntries) {
      const oldest = this.sequenceCache.keys().next().value;
      if (oldest === undefined) break;
      this.sequenceCache.delete(oldest);
    }
    return { ...observation, textSignature: new Set(observation.textSignature) };
  }

  reset() {
    this.previous = null;
    this.sequenceCache.clear();
    this.sceneGraph.reset();
    this.fullOcrLatencies.length = 0;
    this.regionOcrLatencies.length = 0;
    this.observationsSinceFullOcr = 0;
  }

  private canUseIncrementalOcr(
    frame: AgentFrame,
    regions: VisualChangeRegion[],
    changedAreaRatio: number,
  ) {
    const fullOcrLatencyMs = median(this.fullOcrLatencies);
    const regionOcrLatencyMs = median(this.regionOcrLatencies);
    return Boolean(
      this.incrementalOcr &&
      this.previous &&
      this.previous.width === frame.width &&
      this.previous.height === frame.height &&
      regions.length >= 1 &&
      regions.length <= this.maximumIncrementalRegions &&
      changedAreaRatio > 0 &&
      changedAreaRatio <= this.maximumIncrementalAreaRatio &&
      this.fullOcrLatencies.length >= this.minimumFullOcrSamplesForIncremental &&
      this.observationsSinceFullOcr < 20 &&
      fullOcrLatencyMs !== null &&
      fullOcrLatencyMs >= this.minimumFullOcrMsForIncremental &&
      (
        regionOcrLatencyMs === null ||
        regionOcrLatencyMs < fullOcrLatencyMs * 0.9
      )
    );
  }

  private shouldRefreshKeyboardFingerprint(
    frame: AgentFrame,
    regions: VisualChangeRegion[],
    changeKind: ScreenObservation["changeKind"],
  ) {
    if (!iosKeyboardFingerprintGeometryMatches(frame)) return false;
    if (!this.previous || changeKind === "first" || changeKind === "major") return true;
    if (changeKind === "stable") return false;
    const keyboardTop = frame.height * 0.56;
    return regions.some((region) => region.top + region.height >= keyboardTop);
  }
}

function shouldEscalateOcr(scene: ScreenScene, elements: ScreenElement[]) {
  if (["screen_off", "keyboard", "app_switcher", "app_library"].includes(scene.kind)) {
    return false;
  }
  if (scene.kind === "home_grid") return scene.homeGridScore < 0.75;
  if (elements.length < 14) return true;
  return average(elements.map((element) => element.confidence)) < 0.58;
}

function logicalElements(
  ocr: VisionOcrResult,
  logicalWidth: number,
  logicalHeight: number,
): ScreenElement[] {
  const scaleX = logicalWidth / ocr.imageWidth;
  const scaleY = logicalHeight / ocr.imageHeight;
  return ocr.items
    .filter((item) => item.confidence >= 0.25 && item.text.trim())
    .map((item, index) => ({
      id: `text-${index}-${normalize(item.text).slice(0, 24)}`,
      role: "text" as const,
      text: item.text.trim(),
      confidence: item.confidence,
      center: { x: item.centerX * scaleX, y: item.centerY * scaleY },
      bounds: {
        left: item.left * scaleX,
        top: item.top * scaleY,
        width: item.width * scaleX,
        height: item.height * scaleY,
      },
    }));
}

async function recognizeChangedRegions(
  frame: AgentFrame,
  previous: VisionOcrResult,
  regions: VisualChangeRegion[],
  recognize: NonNullable<ScreenObserverOptions["recognize"]>,
  mode: VisionOcrMode,
  signal?: AbortSignal,
): Promise<VisionOcrResult> {
  const startedAt = performance.now();
  const metadata = await sharp(frame.bytes, { failOn: "error" }).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (sourceWidth < 2 || sourceHeight < 2) throw new Error("Incremental OCR requires image dimensions.");
  const recognized = await Promise.all(regions.map(async (region) => {
    const sourceBounds = logicalRegionToSource(region, frame, sourceWidth, sourceHeight);
    const bytes = await sharp(frame.bytes, { failOn: "error" })
      .extract(sourceBounds)
      .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const result = await recognize(
      `data:image/jpeg;base64,${bytes.toString("base64")}`,
      signal,
      mode,
    );
    const scaleX = region.width / Math.max(1, result.imageWidth);
    const scaleY = region.height / Math.max(1, result.imageHeight);
    return result.items.map((item) => ({
      ...item,
      left: region.left + item.left * scaleX,
      top: region.top + item.top * scaleY,
      width: item.width * scaleX,
      height: item.height * scaleY,
      centerX: region.left + item.centerX * scaleX,
      centerY: region.top + item.centerY * scaleY,
    }));
  }));
  const retained = logicalOcrItems(previous, frame.width, frame.height)
    .filter((item) => !regions.some((region) => boundsIntersectRegion(item, region)));
  const items = deduplicateOcrItems([...recognized.flat(), ...retained])
    .sort((left, right) => left.top - right.top || left.left - right.left);
  return {
    ok: true,
    imageWidth: frame.width,
    imageHeight: frame.height,
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    items,
  };
}

function logicalRegionToSource(
  region: VisualChangeRegion,
  frame: AgentFrame,
  sourceWidth: number,
  sourceHeight: number,
) {
  const left = Math.max(0, Math.min(sourceWidth - 1, Math.floor(region.left / frame.width * sourceWidth)));
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.floor(region.top / frame.height * sourceHeight)));
  const right = Math.max(left + 1, Math.min(
    sourceWidth,
    Math.ceil((region.left + region.width) / frame.width * sourceWidth),
  ));
  const bottom = Math.max(top + 1, Math.min(
    sourceHeight,
    Math.ceil((region.top + region.height) / frame.height * sourceHeight),
  ));
  return { left, top, width: right - left, height: bottom - top };
}

function logicalOcrItems(ocr: VisionOcrResult, width: number, height: number) {
  const scaleX = width / Math.max(1, ocr.imageWidth);
  const scaleY = height / Math.max(1, ocr.imageHeight);
  return ocr.items.map((item) => ({
    ...item,
    left: item.left * scaleX,
    top: item.top * scaleY,
    width: item.width * scaleX,
    height: item.height * scaleY,
    centerX: item.centerX * scaleX,
    centerY: item.centerY * scaleY,
  }));
}

function boundsIntersectRegion(
  item: VisionOcrResult["items"][number],
  region: VisualChangeRegion,
) {
  return item.left < region.left + region.width &&
    item.left + item.width > region.left &&
    item.top < region.top + region.height &&
    item.top + item.height > region.top;
}

function deduplicateOcrItems(items: VisionOcrResult["items"]) {
  const result: VisionOcrResult["items"] = [];
  for (const item of items) {
    const label = normalize(item.text);
    const duplicate = result.some((existing) =>
      normalize(existing.text) === label &&
      Math.hypot(existing.centerX - item.centerX, existing.centerY - item.centerY) <=
        Math.max(12, Math.min(item.width, item.height) * 0.8)
    );
    if (!duplicate) result.push(item);
  }
  return result;
}

function frameDataUrl(frame: AgentFrame) {
  return `data:${frame.mimeType};base64,${frame.bytes.toString("base64")}`;
}

function iosKeyboardFingerprintGeometryMatches(frame: AgentFrame) {
  const scaleX = frame.width / 720;
  const scaleY = frame.height / 1_560;
  return frame.width >= 320 && frame.height >= 690 && Math.abs(scaleX - scaleY) <= 0.035;
}

function classifyScene(
  ocr: VisionOcrResult,
  elements: ScreenElement[],
  width: number,
  height: number,
  keyboardVisibleFromPixels = false,
  visualHints: VisualSceneHints = { insetAppCardScore: 0, darkScreenScore: 0 },
  visualAffordances: VisualAffordance[] = [],
): ScreenScene {
  const keyboardVisible = keyboardVisibleFromPixels || looksLikeIosKeyboard(ocr);
  const homeGridScore = Math.max(
    homeGridLikelihood(elements, width, height),
    visualHomeGridLikelihood(elements, visualAffordances, width, height),
  );
  if (elements.length === 0 && visualHints.darkScreenScore >= 0.98) {
    return {
      kind: "screen_off",
      confidence: visualHints.darkScreenScore,
      homeGridScore: 0,
      keyboardVisible: false,
    };
  }
  if (looksLikeAppLibrary(elements)) {
    return {
      kind: "app_library",
      confidence: 0.98,
      homeGridScore,
      keyboardVisible,
    };
  }
  if (looksLikeAppSwitcher(
    elements,
    width,
    height,
    keyboardVisible,
    visualHints.insetAppCardScore,
  )) {
    return {
      kind: "app_switcher",
      confidence: 0.94,
      homeGridScore,
      keyboardVisible,
    };
  }
  if (keyboardVisible) {
    return { kind: "keyboard", confidence: 0.9, homeGridScore, keyboardVisible };
  }
  if (homeGridScore >= 0.42) {
    return {
      kind: "home_grid",
      confidence: homeGridScore,
      homeGridScore,
      keyboardVisible,
    };
  }
  if (elements.length >= 2) {
    return {
      kind: "text_ui",
      confidence: Math.min(0.9, 0.45 + elements.length * 0.025),
      homeGridScore,
      keyboardVisible,
    };
  }
  return { kind: "unknown", confidence: 0.25, homeGridScore, keyboardVisible };
}

function looksLikeAppLibrary(elements: ScreenElement[]) {
  const joined = elements.map((element) => normalizeText(element.text)).join(" ");
  return /(?:app library|app 资源库|资源库)/.test(joined) &&
    countPatterns(joined, [
      /suggestions|建议/,
      /recently added|最近添加/,
      /social|社交/,
      /utilities|工具/,
      /creativity|创意/,
      /entertainment|娱乐/,
    ]) >= 2;
}

function looksLikeAppSwitcher(
  elements: ScreenElement[],
  width: number,
  height: number,
  keyboardVisible: boolean,
  insetAppCardScore: number,
) {
  if (keyboardVisible || elements.length < 2) return false;
  const titleCandidates = elements.filter((element) => {
    const text = element.text.replace(/[^\p{Letter}\p{Number}]+/gu, "");
    return text.length >= 2 && text.length <= 24 &&
      element.center.x >= width * 0.1 && element.center.x <= width * 0.9 &&
      element.center.y >= height * 0.045 && element.center.y <= height * 0.16 &&
      element.bounds.height <= height * 0.055;
  });
  if (!titleCandidates.length) return false;
  const knownAppTitles = titleCandidates.filter((element) =>
    /^(?:tiktok|telegram|instagram|safari|settings|gemini|chrome|google|youtube)$/i.test(
      element.text.replace(/[^\p{Letter}\p{Number}]+/gu, ""),
    )
  );
  // OCR often fragments an arbitrary app name in the switcher title. The
  // phone-wide pixel sample supplies the platform-neutral evidence in that
  // case: a large inset card has persistent side gutters and a lower edge,
  // while a normal full-screen toolbar does not. Requiring both independent
  // signals avoids maintaining an app-name catalogue.
  if (titleCandidates.length >= 1 && insetAppCardScore >= 0.75) return true;
  if (elements.length < 6) return false;
  // A normal application toolbar commonly contains two labels on the same
  // row. Treating that geometry alone as App Switcher caused search pages to
  // be dismissed as scaled cards. Two distinct app titles are strong evidence
  // of the horizontal switcher, while a single card also needs evidence that
  // its bottom navigation is inset well above the physical screen edge.
  if (knownAppTitles.some((left, index) =>
    knownAppTitles.slice(index + 1).some((right) =>
      Math.abs(left.center.y - right.center.y) <= height * 0.035 &&
      Math.abs(left.center.x - right.center.x) >= width * 0.12
    )
  )) return true;
  if (knownAppTitles.length !== 1) return false;
  const insetControls = elements.filter((element) =>
    element.center.y >= height * 0.62 && element.center.y <= height * 0.86 &&
    /^(?:home|friends|inbox|profile|chats|calls|contacts|settings|search)$/i.test(
      element.text.trim(),
    )
  );
  const edgeControls = elements.filter((element) =>
    element.center.y >= height * 0.9 &&
    /^(?:home|friends|inbox|profile|chats|calls|contacts|settings|search)$/i.test(
      element.text.trim(),
    )
  );
  return insetControls.length >= 2 && edgeControls.length === 0;
}

export function homeGridLikelihood(
  elements: ScreenElement[],
  width: number,
  height: number,
) {
  const labels = homeGridTextLabels(elements, width, height);
  if (labels.length < 4) return 0;
  const tolerance = height * 0.035;
  const rows: ScreenElement[][] = [];
  for (const label of labels.sort((left, right) => left.center.y - right.center.y)) {
    const row = rows.find((candidate) =>
      Math.abs(average(candidate.map((item) => item.center.y)) - label.center.y) <= tolerance
    );
    if (row) row.push(label);
    else rows.push([label]);
  }
  const gridRows = rows.filter((row) => {
    if (row.length < 3) return false;
    const xs = row.map((item) => item.center.x).sort((left, right) => left - right);
    if (xs[xs.length - 1] - xs[0] < width * 0.42) return false;
    const gaps = xs.slice(1).map((value, index) => value - xs[index]);
    const minimumGap = Math.min(...gaps);
    const maximumGap = Math.max(...gaps);
    return minimumGap >= width * 0.11 && maximumGap / minimumGap <= 2.2;
  });
  if (gridRows.length < 2) return 0;
  const alignedLabels = gridRows.reduce((sum, row) => sum + row.length, 0);
  // A small in-app launcher (for example TikTok Minis) can contain two rows
  // of three icons. Require at least one full four-column row plus most of a
  // second row before system navigation may be considered complete.
  if (alignedLabels < 7) return 0;
  const rowScore = Math.min(1, gridRows.length / 2);
  const countScore = Math.min(1, alignedLabels / 8);
  return Math.round((0.4 * rowScore + 0.6 * countScore) * 1_000) / 1_000;
}

type HomeGridAnchor = {
  x: number;
  y: number;
  sources: Set<"text" | "visual">;
};

/**
 * Recovers a Home grid when fast OCR sees only fragments of the app labels.
 * A positive result requires independent text and compact-outline evidence
 * across at least three rows, plus either a dock row or a fourth body row.
 * That keeps ordinary bottom navigation and small in-app launchers negative.
 */
function visualHomeGridLikelihood(
  elements: ScreenElement[],
  affordances: VisualAffordance[],
  width: number,
  height: number,
) {
  if (!affordances.length) return 0;
  const anchors: HomeGridAnchor[] = [];
  for (const label of homeGridTextLabels(elements, width, height)) {
    const iconOffset = Math.max(
      height * 0.042,
      Math.min(height * 0.075, label.bounds.height * 3.6),
    );
    addHomeGridAnchor(anchors, {
      x: label.center.x,
      y: label.center.y - iconOffset,
      source: "text",
    }, width, height);
  }
  for (const affordance of affordances) {
    const aspect = affordance.bounds.width / Math.max(1, affordance.bounds.height);
    if (
      affordance.confidence < 0.5 ||
      affordance.bounds.width < width * 0.07 ||
      affordance.bounds.width > width * 0.24 ||
      affordance.bounds.height < height * 0.045 ||
      affordance.bounds.height > height * 0.15 ||
      aspect < 0.5 || aspect > 1.65
    ) continue;
    addHomeGridAnchor(anchors, {
      x: affordance.center.x,
      y: affordance.center.y,
      source: "visual",
    }, width, height);
  }
  const bodyAnchors = anchors.filter((anchor) =>
    anchor.y >= height * 0.07 && anchor.y <= height * 0.87
  );
  const bodyRows = alignedHomeGridRows(bodyAnchors, width, height);
  const alignedAnchors = bodyRows.flat();
  const visualCount = alignedAnchors.filter((anchor) =>
    anchor.sources.has("visual")
  ).length;
  const textCount = alignedAnchors.filter((anchor) => anchor.sources.has("text")).length;
  const corroboratedCount = alignedAnchors.filter((anchor) =>
    anchor.sources.size === 2
  ).length;
  const dockRows = alignedHomeGridRows(anchors.filter((anchor) =>
    anchor.y > height * 0.87 && anchor.y <= height * 0.985
  ), width, height);
  const dockCount = Math.max(0, ...dockRows.map((row) => row.length));
  if (
    bodyRows.length < 3 ||
    alignedAnchors.length < 9 ||
    visualCount < 4 ||
    textCount < 6 ||
    corroboratedCount < 2 ||
    (bodyRows.length < 4 && dockCount < 3)
  ) return 0;
  const rowScore = Math.min(1, bodyRows.length / 4);
  const countScore = Math.min(1, alignedAnchors.length / 12);
  const corroborationScore = Math.min(1, corroboratedCount / 4);
  const dockScore = dockCount >= 3 ? 1 : 0;
  return Math.round((
    0.3 * rowScore +
    0.25 * countScore +
    0.3 * corroborationScore +
    0.15 * dockScore
  ) * 1_000) / 1_000;
}

function homeGridTextLabels(
  elements: ScreenElement[],
  width: number,
  height: number,
) {
  return elements.filter((element) => {
    const compact = normalize(element.text);
    return compact.length >= 1 && compact.length <= 20 &&
      element.confidence >= 0.3 &&
      element.center.y >= height * 0.1 && element.center.y <= height * 0.88 &&
      element.bounds.height <= height * 0.04 &&
      element.bounds.width <= width * 0.32;
  });
}

function addHomeGridAnchor(
  anchors: HomeGridAnchor[],
  candidate: { x: number; y: number; source: "text" | "visual" },
  width: number,
  height: number,
) {
  const match = anchors.find((anchor) =>
    Math.abs(anchor.x - candidate.x) <= width * 0.065 &&
    Math.abs(anchor.y - candidate.y) <= height * 0.055
  );
  if (!match) {
    anchors.push({
      x: candidate.x,
      y: candidate.y,
      sources: new Set([candidate.source]),
    });
    return;
  }
  match.sources.add(candidate.source);
  if (candidate.source === "visual") {
    match.x = candidate.x;
    match.y = candidate.y;
  }
}

function alignedHomeGridRows(
  anchors: HomeGridAnchor[],
  width: number,
  height: number,
) {
  const rows: HomeGridAnchor[][] = [];
  for (const anchor of [...anchors].sort((left, right) => left.y - right.y)) {
    const row = rows.find((candidate) =>
      Math.abs(average(candidate.map((item) => item.y)) - anchor.y) <= height * 0.05
    );
    if (row) row.push(anchor);
    else rows.push([anchor]);
  }
  return rows.filter((row) => {
    if (row.length < 3) return false;
    const xs = row.map((item) => item.x).sort((left, right) => left - right);
    if (xs[xs.length - 1] - xs[0] < width * 0.42) return false;
    const gaps = xs.slice(1).map((value, index) => value - xs[index]);
    const minimumGap = Math.min(...gaps);
    const maximumGap = Math.max(...gaps);
    return minimumGap >= width * 0.105 && maximumGap / minimumGap <= 2.4;
  });
}

async function sampleFrame(bytes: Buffer) {
  return sharp(bytes, { failOn: "error" })
    .resize({ width: 48, height: 80, fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
}

function sceneHintsFromSample(pixels: Buffer): VisualSceneHints {
  const width = 48;
  const height = 80;
  if (pixels.length !== width * height) {
    return { insetAppCardScore: 0, darkScreenScore: 0 };
  }
  const interior = sampleMean(pixels, width, height, 0.22, 0.78, 0.22, 0.7);
  const side = (
    sampleMean(pixels, width, height, 0, 0.08, 0.22, 0.7) +
    sampleMean(pixels, width, height, 0.92, 1, 0.22, 0.7)
  ) / 2;
  const lowerInterior = sampleMean(pixels, width, height, 0.22, 0.78, 0.7, 0.82);
  const bottom = sampleMean(pixels, width, height, 0.22, 0.78, 0.88, 0.98);
  const top = sampleMean(pixels, width, height, 0.22, 0.78, 0.01, 0.07);
  const score =
    0.4 * contrastScore(interior, side, 18, 58) +
    0.2 * contrastScore(interior, bottom, 20, 72) +
    0.1 * contrastScore(interior, top, 20, 72) +
    0.3 * contrastScore(lowerInterior, bottom, 18, 62);
  let total = 0;
  let darkPixels = 0;
  for (const value of pixels) {
    total += value;
    if (value <= 8) darkPixels += 1;
  }
  const meanLuminance = total / pixels.length;
  const darkRatio = darkPixels / pixels.length;
  const darkScreenScore = meanLuminance <= 4 && darkRatio >= 0.995 ? 0.99 : 0;
  return {
    insetAppCardScore: Math.round(score * 1_000) / 1_000,
    darkScreenScore,
  };
}

function sampleMean(
  pixels: Buffer,
  width: number,
  height: number,
  leftRatio: number,
  rightRatio: number,
  topRatio: number,
  bottomRatio: number,
) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(leftRatio * width)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(rightRatio * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(topRatio * height)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(bottomRatio * height)));
  let total = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      total += pixels[y * width + x];
      count += 1;
    }
  }
  return count ? total / count : 0;
}

function contrastScore(left: number, right: number, floor: number, full: number) {
  return Math.max(0, Math.min(1, (Math.abs(left - right) - floor) / (full - floor)));
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function normalizeText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countPatterns(value: string, patterns: RegExp[]) {
  return patterns.filter((pattern) => pattern.test(value)).length;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
    ? Number(value)
    : fallback;
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isFinite(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function recordLatency(target: number[], value: number) {
  if (!Number.isFinite(value) || value < 0) return;
  target.push(value);
  if (target.length > 9) target.shift();
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[center]
    : (sorted[center - 1] + sorted[center]) / 2;
}
