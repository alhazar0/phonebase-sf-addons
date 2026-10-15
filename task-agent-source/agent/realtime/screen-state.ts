import type { ScreenObservation } from "../general-agent-contract";
import { ScreenObserver } from "../screen-observer";
import type { LatencyRecorder } from "./latency-recorder";
import type { RealtimeFrameHub } from "./frame-hub";

export type RuntimeScreenKind =
  | "home"
  | "spotlight"
  | "app_switcher"
  | "app_library"
  | "tiktok_feed"
  | "tiktok_video"
  | "tiktok_sound"
  | "tiktok_comments"
  | "tiktok_search"
  | "tiktok_results"
  | "instagram_home"
  | "instagram_search"
  | "instagram_results"
  | "instagram_profile"
  | "instagram_reels_grid"
  | "instagram_reel"
  | "unknown";

export type RuntimeScreenState = {
  kind: RuntimeScreenKind;
  confidence: number;
  observation: ScreenObservation;
  tokens: string[];
  detectedAt: number;
};

export type RuntimeScreenStateSink = (state: RuntimeScreenState) => void;

export class RealtimeScreenPerception {
  private readonly observer: ScreenObserver;
  private readonly accurateObserver: ScreenObserver;
  private latestState: RuntimeScreenState | null = null;
  private inFlight: Promise<RuntimeScreenState> | null = null;

  constructor(
    private readonly frames: RealtimeFrameHub,
    private readonly metrics: LatencyRecorder,
    observer = new ScreenObserver({ ocrMode: "fast", maximumCacheEntries: 24 }),
    accurateObserver = new ScreenObserver({ ocrMode: "accurate", maximumCacheEntries: 24 }),
    private readonly sink?: RuntimeScreenStateSink,
  ) {
    this.observer = observer;
    this.accurateObserver = accurateObserver;
  }

  async observeLatest(
    options: { decisionEvidence?: boolean } = {},
  ): Promise<RuntimeScreenState> {
    const frame = await this.frames.latestModelFrame();
    if (this.latestState?.observation.sequence === frame.sequence) {
      return this.expose(this.latestState, options.decisionEvidence !== false);
    }
    if (this.inFlight) {
      await this.inFlight;
      const latest = await this.frames.latestModelFrame();
      if (
        this.latestState &&
        this.latestState.observation.sequence >= latest.sequence
      ) return this.expose(this.latestState, options.decisionEvidence !== false);
      return this.observeLatest(options);
    }
    const operation = this.classify(frame);
    this.inFlight = operation;
    try {
      const state = await operation;
      if (
        !this.latestState ||
        state.observation.sequence > this.latestState.observation.sequence
      ) {
        this.latestState = state;
        try {
          this.sink?.(state);
        } catch (error) {
          this.metrics.record("memory", "active-world-observation-error", 0, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return this.expose(
        this.latestState ?? state,
        options.decisionEvidence !== false,
      );
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  latest(): RuntimeScreenState | null {
    return this.latestState;
  }

  private expose(state: RuntimeScreenState, decisionEvidence: boolean) {
    if (decisionEvidence) {
      this.metrics.markDecisionEvidence("screen-state", {
        sequence: state.observation.sequence,
        screenKind: state.kind,
        confidence: state.confidence,
      });
    }
    return state;
  }

  private async classify(frame: Awaited<ReturnType<RealtimeFrameHub["latestModelFrame"]>>) {
    const state = await this.metrics.measure(
      "perception",
      "classify-screen",
      async () => {
        const fast = classifyRuntimeScreen(await this.observer.observe(frame));
        if (fast.kind !== "unknown") return fast;
        return classifyRuntimeScreen(await this.accurateObserver.observe(frame));
      },
      { sequence: frame.sequence },
    );
    this.metrics.record("ocr", "apple-vision-fast", state.observation.ocrElapsedMs, {
      sequence: state.observation.sequence,
      cacheHit: state.observation.ocrCacheHit,
      elementCount: state.observation.elements.length,
    });
    return state;
  }

  async waitFor(
    predicate: (state: RuntimeScreenState) => boolean,
    options: {
      timeoutMs: number;
      afterSequence?: number;
      signal?: AbortSignal;
    },
  ) {
    return this.metrics.measure("phone_animation", "wait-for-screen-state", async () => {
      const deadline = Date.now() + options.timeoutMs;
      let sequence = options.afterSequence ?? 0;
      let last: RuntimeScreenState | null = null;
      while (Date.now() < deadline) {
        const latest = this.frames.latest();
        if (!latest || latest.metadata.sequence <= sequence) {
          try {
            await this.frames.waitForFrame(
              sequence,
              Math.max(50, deadline - Date.now()),
              options.signal,
            );
          } catch (error) {
            if (Date.now() >= deadline) break;
            throw error;
          }
        }
        const state = await this.observeLatest();
        last = state;
        sequence = state.observation.sequence;
        const matched = this.metrics.measureSync(
          "verification",
          "screen-state-predicate",
          () => predicate(state),
          { sequence, screenKind: state.kind },
        );
        if (matched) {
          this.metrics.markDecisionEvidence("verified-screen-state", {
            sequence,
            screenKind: state.kind,
            confidence: state.confidence,
          });
          return state;
        }
      }
      throw new Error(
        `Screen state did not reach the requested condition within ${options.timeoutMs} ms; ` +
        `last=${last?.kind ?? "none"}.`,
      );
    }, {
      afterSequence: options.afterSequence ?? 0,
      timeoutMs: options.timeoutMs,
    });
  }

  reset() {
    this.observer.reset();
    this.accurateObserver.reset();
    this.latestState = null;
  }
}

export function classifyRuntimeScreen(observation: ScreenObservation): RuntimeScreenState {
  const tokens = observation.elements
    .filter((element) => element.confidence >= 0.3)
    .map((element) => normalize(element.text))
    .filter(Boolean);
  const joined = tokens.join(" ");
  const has = (...patterns: RegExp[]) => patterns.every((pattern) => pattern.test(joined));
  let kind: RuntimeScreenKind = "unknown";
  let confidence = observation.scene.confidence;
  const topAppTitle = observation.elements.some((element) =>
    element.center.y <= observation.viewport.height * 0.16 &&
    element.center.x >= observation.viewport.width * 0.18 &&
    element.center.x <= observation.viewport.width * 0.82 &&
    /(?:tiktok|telegram|instagram|safari|settings|gemini|chrome|youtube)/.test(normalize(element.text))
  );
  const fullScreenTikTokNavigation = hasFullScreenTikTokNavigation(observation);

  if (
    fullScreenTikTokNavigation
  ) {
    kind = "tiktok_feed";
    confidence = 0.97;
  } else if (
    /original sound/.test(joined) && /\bsave\b/.test(joined) &&
    /add to story|use sound/.test(joined)
  ) {
    kind = "tiktok_sound";
    confidence = 0.96;
  } else if (
    observation.scene.kind === "app_switcher" ||
    (topAppTitle && observation.scene.homeGridScore >= 0.42)
  ) {
    kind = "app_switcher";
    confidence = 0.96;
  } else if (observation.scene.kind === "app_library") {
    kind = "app_library";
    confidence = 0.98;
  } else if (
    has(/\bposts?\b/, /followers?/, /following/) &&
    countInstagramGridMetrics(observation) >= 2
  ) {
    kind = "instagram_reels_grid";
    confidence = 0.97;
  } else if (
    has(/\bposts?\b/, /followers?/, /following/) &&
    /follow|message|edit profile/.test(joined)
  ) {
    kind = "instagram_profile";
    confidence = 0.97;
  } else if (
    /\blikes?\b/.test(joined) && /add comment/.test(joined) &&
    /original audio|comment [“"']|instagram/.test(joined)
  ) {
    kind = "instagram_reel";
    confidence = 0.94;
  } else if (
    observation.scene.keyboardVisible && /cancel/.test(joined) &&
    hasInstagramAccountCandidates(observation)
  ) {
    kind = "instagram_results";
    confidence = 0.96;
  } else if (
    observation.scene.keyboardVisible && /\bsearch\b/.test(joined) && /cancel/.test(joined)
  ) {
    kind = "instagram_search";
    confidence = 0.94;
  } else if (
    !observation.scene.keyboardVisible && /\bsearch\b/.test(joined) &&
    countInstagramGridMetrics(observation) >= 2
  ) {
    kind = "instagram_search";
    confidence = 0.9;
  } else if (
    /\binstagram\b/.test(joined) && /your story|suggested for you/.test(joined)
  ) {
    kind = "instagram_home";
    confidence = 0.96;
  } else if (
    has(/\bcomments\b/) && (/add comment/.test(joined) || observation.scene.keyboardVisible)
  ) {
    kind = "tiktok_comments";
    confidence = 0.96;
  } else if (
    /add comment/.test(joined) && !observation.scene.keyboardVisible &&
    /see original|following|find related content/.test(joined)
  ) {
    kind = "tiktok_video";
    confidence = 0.94;
  } else if (
    /videos?/.test(joined) && (
      /ask a[il1]/.test(joined) ||
      (/alhazar/.test(joined) &&
      countMatches(joined, [/\btop\b/, /users?/, /shop/, /sounds?/, /live/]) >= 2
      )
    )
  ) {
    kind = "tiktok_results";
    confidence = 0.96;
  } else if (
    observation.scene.keyboardVisible && /search/.test(joined) &&
    /ask a[il1]|voice|you may like/.test(joined)
  ) {
    kind = "tiktok_search";
    confidence = 0.96;
  } else if (
    countMatches(joined, [/\btop\b/, /videos?/, /users?/, /shop/, /sounds?/, /live/]) >= 4 &&
    /search/.test(joined)
  ) {
    kind = "tiktok_search";
    confidence = 0.91;
  } else if (
    /siri suggestions|top hit|show more/.test(joined) ||
    (/search/.test(joined) && observation.scene.keyboardVisible && /telegram|instagram|tiktok/.test(joined))
  ) {
    kind = "spotlight";
    confidence = 0.94;
  } else if (
    countMatches(joined, [/for you/, /following/, /\bhome\b/, /friends/, /inbox/, /profile/]) >= 3
  ) {
    kind = "tiktok_feed";
    confidence = 0.9;
  } else if (observation.scene.kind === "home_grid" && observation.scene.homeGridScore >= 0.42) {
    kind = "home";
    confidence = observation.scene.homeGridScore;
  } else if (/telegram|instagram|tiktok/.test(joined) && /recently|search/.test(joined)) {
    kind = "app_switcher";
    confidence = 0.72;
  }

  return {
    kind,
    confidence,
    observation,
    tokens,
    detectedAt: Date.now(),
  };
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function countMatches(value: string, patterns: RegExp[]) {
  return patterns.filter((pattern) => pattern.test(value)).length;
}

function hasFullScreenTikTokNavigation(observation: ScreenObservation) {
  const top = observation.elements.filter((element) =>
    element.center.y <= observation.viewport.height * 0.22 &&
    /^(?:for you|following|community|local|shop|live)$/.test(normalize(element.text))
  ).length;
  const bottom = observation.elements.filter((element) =>
    element.center.y >= observation.viewport.height * 0.78 &&
    /^(?:home|friends|inbox|profile)$/.test(normalize(element.text))
  ).length;
  return top >= 2 && bottom >= 2;
}

function countInstagramGridMetrics(observation: ScreenObservation) {
  return observation.elements.filter((element) =>
    element.center.y >= observation.viewport.height * 0.42 &&
    /^(?:\d{1,3}(?:[,.]\d{3})+|\d+(?:[,.]\d+)?[kmb])$/i.test(
      element.text.replace(/\s+/g, "").replace(/^[^\d]+/u, ""),
    )
  ).length;
}

function hasInstagramAccountCandidates(observation: ScreenObservation) {
  return observation.elements.some((element) =>
    element.center.y >= observation.viewport.height * 0.24 &&
    element.center.y <= observation.viewport.height * 0.72 &&
    /^[a-z0-9._]{3,40}$/i.test(element.text.trim()) &&
    !/^(?:search|cancel|follow|message)$/i.test(element.text.trim())
  );
}
