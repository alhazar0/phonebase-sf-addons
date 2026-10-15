import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { locateAppIcon } from "../general-intent";
import type { ScreenElement, ScreenObservation } from "../general-agent-contract";
import type { AgentFrame } from "../screen-observer";
import { recognizeVisionText } from "../vision-ocr";
import type { RealtimeActionScheduler } from "./action-scheduler";
import type { RealtimeFrameHub } from "./frame-hub";
import type { InstagramProfileInspectionProgram } from "./instagram-task";
import type { LatencyRecorder } from "./latency-recorder";
import { RealtimePopupGuardian } from "./popup-guardian";
import type {
  RealtimeScreenPerception,
  RuntimeScreenState,
} from "./screen-state";

export type InstagramMetric = {
  value: number;
  display: string;
};

export type InstagramProfileInspectionResult = {
  appReadyMs: number;
  profileReadyMs: number;
  completedMs: number;
  targetQuery: string;
  profileHandle: string | null;
  latestVideoViews: number | null;
  latestVideoViewsDisplay: string | null;
  latestVideoLikes: number | null;
  latestVideoLikesDisplay: string | null;
  likesVisibility: "visible" | "hidden" | "unavailable";
  taskEffect: "read_only";
  mutationsPerformed: 0;
  recoveries: number;
  finalFramePath: string;
};

export type InstagramSkillContext = {
  frames: RealtimeFrameHub;
  perception: RealtimeScreenPerception;
  actions: RealtimeActionScheduler;
  metrics: LatencyRecorder;
  signal: AbortSignal;
  emit: (phase: string, label: string, detail?: Record<string, unknown>) => void;
  artifactDirectory?: string;
};

const LAYOUT = {
  homeSearch: { x: 360 / 720, y: 1_300 / 1_560 },
  instagramBottomSearch: { x: 502 / 720, y: 1_470 / 1_560 },
  instagramSearchField: { x: 250 / 720, y: 140 / 1_560 },
  instagramSearchClear: { x: 563 / 720, y: 140 / 1_560 },
} as const;

export class InstagramProfileInspectionSkill {
  private readonly popupGuardian: RealtimePopupGuardian;

  constructor(private readonly context: InstagramSkillContext) {
    this.popupGuardian = new RealtimePopupGuardian({
      actions: context.actions,
      perception: context.perception,
      metrics: context.metrics,
      signal: context.signal,
      emit: context.emit,
      policy: {
        retryNetworkErrors: true,
        maximumAttemptsPerPopup: 1,
      },
    });
  }

  async run(program: InstagramProfileInspectionProgram): Promise<InstagramProfileInspectionResult> {
    const startedAt = performance.now();
    let state = await this.context.perception.observeLatest();
    state = await this.clearPopupIfPresent(state);
    state = await this.ensureInstagram(state);
    const appReadyMs = round(performance.now() - startedAt);
    this.context.emit("app", "instagram-ready", { appReadyMs, kind: state.kind });

    state = await this.ensureTargetProfile(state, program);
    const profileReadyMs = round(performance.now() - startedAt);
    const profileHandle = inferProfileHandle(state, program);
    this.context.emit("profile", "target-ready", {
      profileReadyMs,
      profileHandle,
      kind: state.kind,
    });

    const grid = await this.ensureReelsGrid(state);
    let views = extractLatestInstagramViews(grid);
    if (!views) {
      views = extractLatestInstagramViewsFromElements(
        await this.accurateElements(await this.context.frames.latestModelFrame()),
        grid.observation.viewport,
        profileTabsY(grid),
      );
    }
    this.context.emit("metrics", "latest-reel-views", {
      value: views?.value ?? null,
      display: views?.display ?? null,
    });

    let likes: InstagramMetric | null = null;
    let likesVisibility: InstagramProfileInspectionResult["likesVisibility"] = "unavailable";
    if (program.metrics.includes("likes")) {
      const reel = await this.openLatestReel(grid);
      let likeResult = extractInstagramLikes(reel.observation.elements, reel.observation.viewport);
      if (likeResult.visibility === "unavailable") {
        likeResult = extractInstagramLikes(
          await this.accurateElements(await this.context.frames.latestModelFrame()),
          reel.observation.viewport,
        );
      }
      likes = likeResult.metric;
      likesVisibility = likeResult.visibility;
      this.context.emit("metrics", "latest-reel-likes", {
        visibility: likesVisibility,
        value: likes?.value ?? null,
        display: likes?.display ?? null,
      });
    }

    const finalFramePath = await this.saveFinalFrame();
    return {
      appReadyMs,
      profileReadyMs,
      completedMs: round(performance.now() - startedAt),
      targetQuery: program.targetQuery,
      profileHandle,
      latestVideoViews: views?.value ?? null,
      latestVideoViewsDisplay: views?.display ?? null,
      latestVideoLikes: likes?.value ?? null,
      latestVideoLikesDisplay: likes?.display ?? null,
      likesVisibility,
      taskEffect: "read_only",
      mutationsPerformed: 0,
      recoveries: this.popupGuardian.recoveries,
      finalFramePath,
    };
  }

  private async ensureInstagram(initial: RuntimeScreenState) {
    let state = initial;
    if (isInstagramState(state)) return state;
    if (state.kind !== "home" && state.kind !== "spotlight") {
      const before = state.observation.sequence;
      await this.context.actions.phoneKey("home", "launch:home", this.context.signal);
      state = await this.waitForState(
        (candidate) => candidate.kind === "home" || candidate.kind === "spotlight",
        5_000,
        before,
        "home-screen",
      );
    }

    if (state.kind === "home") {
      const icon = locateAppIcon("Instagram", state.observation);
      if (icon) {
        const before = state.observation.sequence;
        await this.context.actions.tap(
          normalizePoint(icon.point, state.observation.viewport),
          "launch:instagram-icon",
          70,
          this.context.signal,
        );
        return this.waitForInstagram(before, "instagram-opened-from-home");
      }
      const before = state.observation.sequence;
      await this.context.actions.tap(
        LAYOUT.homeSearch,
        "launch:open-system-search",
        70,
        this.context.signal,
      );
      state = await this.waitForState(
        (candidate) => candidate.kind === "spotlight",
        3_000,
        before,
        "system-search",
      );
    }

    let app = locateSpotlightApp("Instagram", state.observation);
    if (!app) {
      await this.context.actions.inputText(
        "instagram",
        "search:type-query:instagram-app",
        this.context.signal,
      );
      state = await this.waitForState(
        (candidate) => candidate.kind === "spotlight",
        3_000,
        state.observation.sequence,
        "instagram-system-result",
      );
      app = locateSpotlightApp("Instagram", state.observation);
    }
    if (!app) throw new Error("System search did not expose the Instagram app icon.");
    const before = state.observation.sequence;
    await this.context.actions.tap(
      normalizePoint(app.point, state.observation.viewport),
      "launch:instagram-system-result",
      70,
      this.context.signal,
    );
    return this.waitForInstagram(before, "instagram-opened-from-system-search");
  }

  private async ensureTargetProfile(
    initial: RuntimeScreenState,
    program: InstagramProfileInspectionProgram,
  ) {
    let state = initial;
    if (profileMatches(state, program)) {
      if (state.kind !== "instagram_reel") return state;
      const before = state.observation.sequence;
      await this.context.actions.phoneKey("back", "navigation:back-to-profile", this.context.signal);
      return this.waitForState(
        (candidate) => isInstagramProfileState(candidate) && profileMatches(candidate, program),
        4_000,
        before,
        "target-profile-from-reel",
      );
    }

    state = await this.reachInstagramSearch(state);
    let account = locateInstagramAccountResult(program, state.observation);
    if (!account) {
      if (!state.observation.scene.keyboardVisible) {
        const before = state.observation.sequence;
        await this.context.actions.tap(
          LAYOUT.instagramSearchField,
          "search:focus-query",
          70,
          this.context.signal,
        );
        state = await this.waitForState(
          (candidate) =>
            (candidate.kind === "instagram_search" || candidate.kind === "instagram_results") &&
            candidate.observation.scene.keyboardVisible,
          3_000,
          before,
          "instagram-search-keyboard",
        );
      }
      if (hasForeignSearchQuery(state.observation, program)) {
        const before = state.observation.sequence;
        await this.context.actions.tap(
          LAYOUT.instagramSearchClear,
          "search:clear-query",
          70,
          this.context.signal,
        );
        await this.context.metrics.measure(
          "phone_animation",
          "wait-for-instagram-search-clear",
          () => this.context.frames.waitForFrame(before, 1_500, this.context.signal),
          { afterSequence: before },
        );
      }
      await this.context.actions.inputText(
        program.searchPrefix,
        "search:type-query:profile",
        this.context.signal,
      );
      state = await this.waitForState(
        (candidate) => candidate.kind === "instagram_results",
        4_000,
        state.observation.sequence,
        "instagram-account-results",
      );
      account = locateInstagramAccountResult(program, state.observation);
    }
    if (!account) {
      throw new Error(`Instagram search did not expose an unambiguous account for ${program.targetQuery}.`);
    }
    const before = state.observation.sequence;
    await this.context.actions.tap(
      normalizePoint(account.point, state.observation.viewport),
      "search:select-account",
      70,
      this.context.signal,
    );
    return this.waitForState(
      (candidate) => isInstagramProfileState(candidate) && profileMatches(candidate, program),
      5_000,
      before,
      "target-instagram-profile",
    );
  }

  private async reachInstagramSearch(initial: RuntimeScreenState) {
    let state = initial;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (state.kind === "instagram_search" || state.kind === "instagram_results") return state;
      const before = state.observation.sequence;
      if (state.kind === "instagram_home") {
        await this.context.actions.tap(
          LAYOUT.instagramBottomSearch,
          "search:open-tab",
          70,
          this.context.signal,
        );
      } else if (isInstagramState(state)) {
        await this.context.actions.phoneKey(
          "back",
          `navigation:back-to-search-${attempt + 1}`,
          this.context.signal,
        );
      } else {
        throw new Error(`Cannot reach Instagram search from ${state.kind}.`);
      }
      state = await this.waitForState(
        (candidate) => isInstagramState(candidate),
        4_000,
        before,
        "instagram-navigation",
      );
    }
    throw new Error(`Instagram did not reach Search; last=${state.kind}.`);
  }

  private async ensureReelsGrid(initial: RuntimeScreenState) {
    let state = initial;
    if (state.kind === "instagram_reel") {
      const before = state.observation.sequence;
      await this.context.actions.phoneKey("back", "navigation:back-to-reels-grid", this.context.signal);
      state = await this.waitForState(
        (candidate) => isInstagramProfileState(candidate),
        4_000,
        before,
        "profile-after-reel",
      );
    }
    if (state.kind === "instagram_reels_grid" && extractLatestInstagramViews(state)) return state;
    const beforeFrame = await this.context.frames.latestModelFrame();
    await this.context.actions.tap(
      { x: 0.5, y: profileTabsY(state) },
      "profile:open-reels-tab",
      70,
      this.context.signal,
    );
    try {
      await this.context.actions.waitForChange(beforeFrame, {
        left: 0,
        top: Math.min(0.72, profileTabsY(state)),
        width: 1,
        height: 0.5,
      }, {
        threshold: 0.012,
        timeoutMs: 2_000,
        signal: this.context.signal,
      });
    } catch {
      // OCR state verification below remains authoritative if thumbnails were cached.
    }
    return this.waitForState(
      (candidate) => candidate.kind === "instagram_reels_grid" ||
        (candidate.kind === "instagram_profile" && Boolean(extractLatestInstagramViews(candidate))),
      3_500,
      state.observation.sequence,
      "instagram-reels-grid",
    );
  }

  private async openLatestReel(grid: RuntimeScreenState) {
    const before = grid.observation.sequence;
    await this.context.actions.tap(
      { x: 1 / 6, y: Math.min(0.82, profileTabsY(grid) + 0.17) },
      "profile:open-latest-reel",
      70,
      this.context.signal,
    );
    return this.waitForState(
      (candidate) => candidate.kind === "instagram_reel",
      4_000,
      before,
      "latest-instagram-reel",
    );
  }

  private waitForInstagram(afterSequence: number, label: string) {
    return this.waitForState(
      (candidate) => isInstagramState(candidate),
      7_000,
      afterSequence,
      label,
    );
  }

  private async waitForState(
    predicate: (state: RuntimeScreenState) => boolean,
    timeoutMs: number,
    afterSequence: number,
    label: string,
  ) {
    const deadline = Date.now() + timeoutMs;
    let sequence = afterSequence;
    while (Date.now() < deadline) {
      const state = await this.context.perception.waitFor(
        (candidate) => predicate(candidate) || Boolean(this.popupGuardian.detect(candidate)),
        {
          timeoutMs: Math.max(100, deadline - Date.now()),
          afterSequence: sequence,
          signal: this.context.signal,
        },
      );
      if (predicate(state)) {
        this.context.emit("verification", label, {
          kind: state.kind,
          confidence: state.confidence,
          sequence: state.observation.sequence,
          ocrMs: state.observation.ocrElapsedMs,
        });
        return state;
      }
      const recovery = await this.popupGuardian.handle(state);
      if (!recovery.handled) {
        throw new Error(recovery.error ?? "The popup guardian could not clear an interruption.");
      }
      if (predicate(recovery.state)) return recovery.state;
      sequence = recovery.state.observation.sequence;
    }
    throw new Error(`Screen state did not reach ${label} within ${timeoutMs} ms.`);
  }

  private async clearPopupIfPresent(state: RuntimeScreenState) {
    if (!this.popupGuardian.detect(state)) return state;
    const recovery = await this.popupGuardian.handle(state);
    if (!recovery.handled) {
      throw new Error(recovery.error ?? "The popup guardian could not clear an interruption.");
    }
    return recovery.state;
  }

  private accurateElements(frame: AgentFrame) {
    return this.context.metrics.measure("content", "instagram-accurate-local-ocr", async () => {
      const ocr = await recognizeVisionText(
        `data:${frame.mimeType};base64,${frame.bytes.toString("base64")}`,
        this.context.signal,
        "accurate",
      );
      const scaleX = frame.width / ocr.imageWidth;
      const scaleY = frame.height / ocr.imageHeight;
      return ocr.items
        .filter((item) => item.confidence >= 0.32 && item.text.trim())
        .map((item, index): ScreenElement => ({
          id: `accurate-${index}`,
          role: "text",
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
    }, { sequence: frame.sequence });
  }

  private async saveFinalFrame() {
    const directory = resolve(this.context.artifactDirectory ?? "build/runtime");
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, "instagram-profile-inspection-final.jpg");
    const frame = await this.context.frames.latestModelFrame();
    await writeFile(path, frame.bytes);
    return path;
  }
}

export function extractLatestInstagramViews(state: RuntimeScreenState) {
  return extractLatestInstagramViewsFromElements(
    state.observation.elements,
    state.observation.viewport,
    profileTabsY(state),
  );
}

export function extractLatestInstagramViewsFromElements(
  elements: ScreenElement[],
  viewport: { width: number; height: number },
  tabsY: number,
): InstagramMetric | null {
  const candidates = elements
    .filter((element) =>
      element.center.x <= viewport.width * 0.34 &&
      element.center.y >= viewport.height * Math.min(0.9, tabsY + 0.12) &&
      element.center.y <= viewport.height * 0.88
    )
    .map((element) => ({ element, metric: parseInstagramMetric(element.text) }))
    .filter((candidate): candidate is { element: ScreenElement; metric: InstagramMetric } =>
      candidate.metric !== null
    )
    .sort((left, right) =>
      left.element.center.y - right.element.center.y ||
      left.element.center.x - right.element.center.x
    );
  return candidates[0]?.metric ?? null;
}

export function extractInstagramLikes(
  elements: ScreenElement[],
  viewport: { width: number; height: number },
): {
  metric: InstagramMetric | null;
  visibility: "visible" | "hidden" | "unavailable";
} {
  const rightRail = elements.filter((element) =>
    element.center.x >= viewport.width * 0.78 &&
    element.center.y >= viewport.height * 0.44 &&
    element.center.y <= viewport.height * 0.66
  );
  if (rightRail.some((element) =>
    /^likes?$/i.test(element.text.replace(/[^\p{Letter}]+/gu, ""))
  )) {
    return { metric: null, visibility: "hidden" };
  }
  const metric = rightRail
    .map((element) => ({ element, metric: parseInstagramMetric(element.text) }))
    .filter((candidate): candidate is { element: ScreenElement; metric: InstagramMetric } =>
      candidate.metric !== null
    )
    .sort((left, right) => left.element.center.y - right.element.center.y)[0]?.metric ?? null;
  return metric
    ? { metric, visibility: "visible" }
    : { metric: null, visibility: "unavailable" };
}

export function parseInstagramMetric(value: string): InstagramMetric | null {
  const display = value.trim().replace(/\s+/g, "").replace(/^[^\d]+/u, "");
  const match = display.match(/^(\d+(?:[,.]\d+)?)([kmb])?$/i);
  if (!match?.[1]) return null;
  const suffix = match[2]?.toLocaleLowerCase("en-US") ?? "";
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  const numeric = suffix
    ? Number(match[1].replace(",", "."))
    : Number(match[1].replace(/[,.]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return { value: Math.round(numeric * multiplier), display };
}

export function profileTabsY(state: RuntimeScreenState) {
  const height = state.observation.viewport.height;
  const actionRow = state.observation.elements
    .filter((element) =>
      /^(?:follow|message|edit profile)$/i.test(element.text.trim()) &&
      element.center.y >= height * 0.2 &&
      element.center.y <= height * 0.45
    )
    .sort((left, right) => right.center.y - left.center.y)[0];
  return Math.min(0.52, actionRow ? actionRow.center.y / height + 0.055 : 0.405);
}

export function locateInstagramAccountResult(
  program: InstagramProfileInspectionProgram,
  observation: ScreenObservation,
) {
  const wantedHandle = normalize(program.targetHandle ?? "");
  const words = normalizeWords(program.targetQuery);
  const candidates = observation.elements
    .filter((element) =>
      element.center.y >= observation.viewport.height * 0.28 &&
      element.center.y <= observation.viewport.height * 0.72 &&
      /^[a-z0-9._]{3,40}$/i.test(element.text.trim()) &&
      !/^(?:search|cancel|follow|message)$/i.test(element.text.trim())
    )
    .map((element) => {
      const rowText = observation.elements
        .filter((other) =>
          Math.abs(other.center.y - element.center.y) <= observation.viewport.height * 0.04
        )
        .map((other) => normalize(other.text))
        .join(" ");
      const handle = normalize(element.text);
      const exactHandle = wantedHandle && handle === wantedHandle ? 100 : 0;
      const wordScore = words.filter((word) => rowText.includes(word)).length * 12;
      const compactScore = normalize(program.targetQuery) &&
        (handle.includes(normalize(program.targetQuery)) || normalize(program.targetQuery).includes(handle))
        ? 25
        : 0;
      return { element, score: exactHandle + wordScore + compactScore };
    })
    .filter((candidate) => candidate.score >= Math.max(12, words.length * 12))
    .sort((left, right) =>
      right.score - left.score || left.element.center.y - right.element.center.y
    );
  const result = candidates[0]?.element;
  return result ? {
    label: result.text,
    point: result.center,
    confidence: result.confidence,
  } : null;
}

function locateSpotlightApp(appName: string, observation: ScreenObservation) {
  const wanted = normalize(appName);
  const result = observation.elements
    .filter((element) => normalize(element.text) === wanted)
    .filter((element) =>
      element.center.y >= observation.viewport.height * 0.12 &&
      element.center.y <= observation.viewport.height * 0.55
    )
    .sort((left, right) => left.center.y - right.center.y)[0];
  if (!result) return null;
  const rowCount = observation.elements.filter((element) =>
    Math.abs(element.center.y - result.center.y) <= observation.viewport.height * 0.025 &&
    element.bounds.height <= observation.viewport.height * 0.04
  ).length;
  const gridLabel = rowCount >= 3 || observation.elements.some((element) =>
    /siri suggestions|top hit|最佳匹配/i.test(element.text)
  );
  return {
    label: result.text,
    point: {
      x: result.center.x,
      y: gridLabel
        ? Math.max(0, result.center.y - observation.viewport.height * 0.055)
        : result.center.y,
    },
  };
}

function profileMatches(state: RuntimeScreenState, program: InstagramProfileInspectionProgram) {
  if (!isInstagramProfileState(state)) return false;
  const joined = state.observation.elements.map((element) => normalize(element.text)).join(" ");
  if (program.targetHandle && joined.includes(normalize(program.targetHandle))) return true;
  const words = normalizeWords(program.targetQuery);
  return words.length > 0 && words.every((word) => joined.includes(word));
}

function inferProfileHandle(
  state: RuntimeScreenState,
  program: InstagramProfileInspectionProgram,
) {
  if (program.targetHandle) return program.targetHandle;
  const words = normalizeWords(program.targetQuery);
  return state.observation.elements
    .filter((element) => element.center.y <= state.observation.viewport.height * 0.2)
    .map((element) => element.text.trim())
    .find((text) => /^[a-z0-9._]{3,40}$/i.test(text) && words.some((word) => normalize(text).includes(word))) ??
    null;
}

function hasForeignSearchQuery(
  observation: ScreenObservation,
  program: InstagramProfileInspectionProgram,
) {
  const wanted = normalize(program.targetQuery);
  return observation.elements.some((element) => {
    if (
      element.center.y < observation.viewport.height * 0.055 ||
      element.center.y > observation.viewport.height * 0.14 ||
      element.center.x < observation.viewport.width * 0.05 ||
      element.center.x > observation.viewport.width * 0.72
    ) return false;
    const value = normalize(element.text);
    return value.length >= 2 &&
      !/^(?:search|cancel)$/.test(value) &&
      !/^\d{3,4}[a-z]?$/.test(value) &&
      !wanted.includes(value) && !value.includes(wanted);
  });
}

function isInstagramState(state: RuntimeScreenState) {
  return state.kind.startsWith("instagram_");
}

function isInstagramProfileState(state: RuntimeScreenState) {
  return state.kind === "instagram_profile" ||
    state.kind === "instagram_reels_grid" ||
    state.kind === "instagram_reel";
}

function normalizeWords(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .split(/[^\p{Letter}\p{Number}]+/gu)
    .map(normalize)
    .filter((word) => word.length >= 2);
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function normalizePoint(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
) {
  return { x: point.x / viewport.width, y: point.y / viewport.height };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
