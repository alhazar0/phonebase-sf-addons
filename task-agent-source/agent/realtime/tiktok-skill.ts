import { randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { locateAppIcon, locateTextInObservation } from "../general-intent";
import type { ScreenElement } from "../general-agent-contract";
import type { AgentFrame } from "../screen-observer";
import { recognizeVisionText } from "../vision-ocr";
import { iosEnglishKeyboardVisible } from "../ios-keyboard-visibility";
import type { RealtimeTaskProgram } from "./task-program";
import type { RealtimeFrameHub } from "./frame-hub";
import type { LatencyRecorder } from "./latency-recorder";
import type { RealtimeActionScheduler } from "./action-scheduler";
import { RealtimePopupGuardian } from "./popup-guardian";
import type {
  RealtimeScreenPerception,
  RuntimeScreenState,
} from "./screen-state";
import type { NormalizedRegion } from "./visual-probe";

export type RealtimeSkillEvent = {
  at: number;
  phase: string;
  label: string;
  detail?: Record<string, unknown>;
};

export type TikTokSkillResult = {
  appReadyMs: number;
  browseStartedAt: number;
  browseCompletedAt: number;
  browseElapsedMs: number;
  likesSubmitted: number;
  likesCompleted: number;
  commentsCompleted: number;
  comments: string[];
  videosVisited: number;
  searchQuery: string | null;
  findings: string[];
  finalFramePath: string;
  recoveries: number;
};

export type TikTokSkillContext = {
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
  spotlightTopResult: { x: 130 / 720, y: 250 / 1_560 },
  videoBack: { x: 28 / 720, y: 90 / 1_560 },
  like: { x: 668 / 720, y: 900 / 1_560 },
  comment: { x: 668 / 720, y: 1_015 / 1_560 },
  commentComposer: { x: 350 / 720, y: 1_480 / 1_560 },
  search: { x: 670 / 720, y: 120 / 1_560 },
  videosTab: { x: 300 / 720, y: 205 / 1_560 },
  feedSwipeStart: { x: 360 / 720, y: 1_180 / 1_560 },
  feedSwipeEnd: { x: 360 / 720, y: 360 / 1_560 },
} as const;

const LIKE_REGION: NormalizedRegion = {
  left: 0.89,
  top: 0.545,
  width: 0.085,
  height: 0.067,
};

const COMMENT_TEXTS = ["nice", "cool", "great", "love it", "so good"] as const;

export class TikTokRealtimeSkill {
  private readonly popupGuardian: RealtimePopupGuardian;

  constructor(private readonly context: TikTokSkillContext) {
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

  async run(program: RealtimeTaskProgram): Promise<TikTokSkillResult> {
    if (program.app.toLocaleLowerCase("en-US") !== "tiktok") {
      throw new Error(`The TikTok skill cannot open ${JSON.stringify(program.app)}.`);
    }
    const runStartedAt = performance.now();
    await this.ensureFeed();
    const appReadyMs = round(performance.now() - runStartedAt);
    this.context.emit("app", "tiktok-ready", { appReadyMs });

    const browsing = await this.browse(program);
    if (
      browsing.videosVisited < Math.max(1, program.browseVideoCount) ||
      browsing.likesCompleted < program.likeCount ||
      browsing.commentsCompleted < program.commentCount
    ) {
      throw new Error(
        `TikTok completion proof is incomplete: videos=${browsing.videosVisited}/` +
        `${Math.max(1, program.browseVideoCount)}, likes=${browsing.likesCompleted}/` +
        `${program.likeCount}, comments=${browsing.commentsCompleted}/${program.commentCount}.`,
      );
    }
    const search = program.searchQuery
      ? await this.search(program.searchQuery, program.inspectResultCount)
      : { findings: [] as string[] };
    if (program.returnHome) await this.returnToPhoneHome();
    const finalFramePath = await this.saveFinalFrame();

    return {
      appReadyMs,
      ...browsing,
      recoveries: browsing.recoveries + this.popupGuardian.recoveries,
      searchQuery: program.searchQuery,
      findings: search.findings,
      finalFramePath,
    };
  }

  private async ensureFeed() {
    let state = await this.context.perception.observeLatest();
    state = await this.clearPopupIfPresent(state);
    this.context.emit("perception", "initial-screen", {
      kind: state.kind,
      confidence: state.confidence,
      sequence: state.observation.sequence,
    });
    if (state.kind === "tiktok_feed") return;
    if (isTikTokSubscreen(state)) {
      await this.returnToFeed(state, "launch:existing-tiktok");
      return;
    }

    if (state.kind === "app_switcher") {
      const before = state.observation.sequence;
      await this.context.actions.tap(
        { x: 0.9, y: 0.92 },
        "launch:dismiss-app-switcher",
        80,
        this.context.signal,
      );
      state = await this.waitForState(
        (candidate) => candidate.kind === "app_library" || candidate.kind === "home" ||
          candidate.kind === "tiktok_feed" || isTikTokSubscreen(candidate),
        5_000,
        before,
        "app-switcher-dismissed",
      );
    }
    if (state.kind === "app_library") {
      const before = state.observation.sequence;
      await this.context.actions.swipe(
        { x: 0.22, y: 0.52 },
        { x: 0.78, y: 0.52 },
        "launch:leave-app-library",
        360,
        this.context.signal,
      );
      state = await this.waitForState(
        (candidate) => candidate.kind === "home",
        5_000,
        before,
        "home-from-app-library",
      );
    }
    if (state.kind !== "home") {
      const beforeSequence = state.observation.sequence;
      await this.context.actions.phoneKey("home", "launch:home", this.context.signal);
      state = await this.waitForState(
        (candidate) => candidate.kind === "home",
        7_000,
        beforeSequence,
        "home-screen",
      );
    }

    const icon = locateAppIcon("TikTok", state.observation);
    if (icon) {
      const before = state.observation.sequence;
      await this.context.actions.tap(
        normalizePoint(icon.point, state.observation.viewport),
        "launch:tiktok-icon",
        90,
        this.context.signal,
      );
      const opened = await this.waitForState(
        (candidate) => candidate.kind === "tiktok_feed" || isTikTokSubscreen(candidate),
        7_000,
        before,
        "tiktok-opened",
      );
      if (opened.kind !== "tiktok_feed") await this.returnToFeed(opened, "launch:icon-state");
      return;
    }

    this.context.emit("launch", "icon-not-visible-using-spotlight");
    await this.context.actions.tap(
      LAYOUT.homeSearch,
      "launch:open-spotlight",
      90,
      this.context.signal,
    );
    state = await this.waitForState(
      (candidate) => candidate.observation.scene.keyboardVisible,
      4_000,
      state.observation.sequence,
      "spotlight",
    );
    state = await this.waitForStableKeyboard(state, "spotlight-keyboard-stable");
    await this.context.actions.inputText("tiktok", "launch:type-tiktok", this.context.signal);
    const afterTyping = await this.context.metrics.measure(
      "phone_animation",
      "wait-for-spotlight-results",
      () => this.context.frames.waitForModelFrame(
        state.observation.sequence,
        3_000,
        this.context.signal,
      ),
      { afterSequence: state.observation.sequence },
    );
    await this.context.actions.tap(
      LAYOUT.spotlightTopResult,
      "launch:tiktok-top-hit",
      90,
      this.context.signal,
    );
    const opened = await this.waitForState(
      (candidate) => candidate.kind === "tiktok_feed" || isTikTokSubscreen(candidate),
      8_000,
      afterTyping.sequence,
      "tiktok-opened",
    );
    if (opened.kind !== "tiktok_feed") await this.returnToFeed(opened, "launch:spotlight-state");
  }

  private async returnToFeed(initial: RuntimeScreenState, label: string) {
    let state = initial;
    if (state.kind === "tiktok_sound") {
      const before = await this.context.frames.latestModelFrame();
      await this.context.actions.swipe(
        { x: 0.5, y: 0.29 },
        { x: 0.5, y: 0.9 },
        `${label}:dismiss-bottom-sheet`,
        420,
        this.context.signal,
      );
      const changed = await this.context.actions.waitForChange(before, FULL_SCREEN, {
        threshold: 0.02,
        timeoutMs: 4_000,
        signal: this.context.signal,
      });
      state = await this.context.perception.waitFor(
        (candidate) => candidate.kind === "tiktok_feed" || isTikTokSubscreen(candidate),
        {
          timeoutMs: 3_000,
          afterSequence: Math.max(before.sequence, changed.frame.sequence - 1),
          signal: this.context.signal,
        },
      );
      this.context.emit("verification", "tiktok-bottom-sheet-dismissed", {
        kind: state.kind,
        confidence: state.confidence,
        sequence: state.observation.sequence,
      });
      if (state.kind === "tiktok_feed") return state;
    }
    if (state.kind === "tiktok_comments") {
      const before = await this.context.frames.latestModelFrame();
      await this.context.actions.tap(
        commentClosePoint(state),
        `${label}:close-comments`,
        80,
        this.context.signal,
      );
      const changed = await this.context.actions.waitForChange(before, FULL_SCREEN, {
        threshold: 0.02,
        timeoutMs: 4_000,
        signal: this.context.signal,
      });
      state = await this.context.perception.waitFor(
        (candidate) => candidate.kind === "tiktok_feed" || isTikTokSubscreen(candidate),
        {
          timeoutMs: 3_000,
          afterSequence: Math.max(before.sequence, changed.frame.sequence - 1),
          signal: this.context.signal,
        },
      );
      this.context.emit("verification", "comments-closed", {
        kind: state.kind,
        confidence: state.confidence,
        sequence: state.observation.sequence,
      });
      if (state.kind === "tiktok_feed") return state;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (state.kind === "tiktok_feed") return state;
      const before = await this.context.frames.latestModelFrame();
      if (state.kind === "tiktok_video") {
        await this.context.actions.tap(
          LAYOUT.videoBack,
          `${label}:video-back-${attempt}`,
          80,
          this.context.signal,
        );
      } else {
        await this.context.actions.phoneKey(
          "back",
          `${label}:back-${attempt}`,
          this.context.signal,
        );
      }
      const changed = await this.context.actions.waitForChange(before, FULL_SCREEN, {
        threshold: 0.02,
        timeoutMs: 4_000,
        signal: this.context.signal,
      });
      state = await this.context.perception.waitFor(
        (candidate) => candidate.kind === "tiktok_feed" || isTikTokSubscreen(candidate),
        {
          timeoutMs: 3_000,
          afterSequence: Math.max(before.sequence, changed.frame.sequence - 1),
          signal: this.context.signal,
        },
      );
      this.context.emit("verification", "tiktok-feed-navigation", {
        kind: state.kind,
        confidence: state.confidence,
        sequence: state.observation.sequence,
        attempt,
      });
    }
    if (state.kind === "tiktok_feed") return state;
    throw new Error(`TikTok remained on ${state.kind} after three Back gestures.`);
  }

  private async browse(program: RealtimeTaskProgram) {
    const browseStartedAt = Date.now();
    const deadline = browseStartedAt + program.browseDurationMs;
    const videoTarget = Math.max(1, program.browseVideoCount);
    let likesCompleted = 0;
    let likesSubmitted = 0;
    let commentsCompleted = 0;
    let videosVisited = 1;
    let recoveries = 0;
    const comments: string[] = [];
    const usedComments = new Set<string>();
    const boundedCountTask = program.browseVideoCount > 0 && program.browseDurationMs === 0;
    const nextDwellMs = () => boundedCountTask ? 0 : 7_000 + randomInt(0, 2_001);
    let nextSwipeAt = Date.now() + nextDwellMs();

    this.context.emit("browse", "started", {
      durationMs: program.browseDurationMs,
      videoTarget: program.browseVideoCount,
      likeTarget: program.likeCount,
      commentTarget: program.commentCount,
    });

    while (Date.now() < deadline || videosVisited < videoTarget ||
      likesSubmitted < program.likeCount || commentsCompleted < program.commentCount) {
      throwIfAborted(this.context.signal);
      await this.clearPopupIfPresent(await this.context.perception.observeLatest());
      const needLike = likesSubmitted < program.likeCount;
      if (needLike) {
        const before = await this.context.frames.latestModelFrame();
        const beforeRed = await this.context.actions.probe.redFraction(before, LIKE_REGION);
        if (beforeRed < 0.085) {
          await this.context.actions.tap(
            LAYOUT.like,
            `browse:like-${likesSubmitted + 1}`,
            80,
            this.context.signal,
          );
          likesSubmitted += 1;
          try {
            const verified = await this.context.actions.waitForStableRedIncrease(
              LIKE_REGION,
              beforeRed,
              {
                minimumFraction: 0.02,
                minimumIncrease: 0.008,
                consecutiveFrames: 2,
                timeoutMs: 2_000,
                afterSequence: before.sequence,
                signal: this.context.signal,
              },
            );
            likesCompleted += 1;
            this.context.emit("browse", "like-verified", {
              likesCompleted,
              likesSubmitted,
              video: videosVisited,
              beforeRed: round(beforeRed),
              afterRed: round(verified.fraction),
            });
          } catch (error) {
            const afterRed = await this.context.actions.latestRedFraction(LIKE_REGION);
            if (afterRed >= 0.02 && afterRed >= beforeRed + 0.008) {
              likesCompleted += 1;
              this.context.emit("browse", "like-verified-late", {
                likesCompleted,
                likesSubmitted,
                video: videosVisited,
                beforeRed: round(beforeRed),
                afterRed: round(afterRed),
              });
            } else {
              recoveries += 1;
              this.context.emit("recover", "like-submitted-not-confirmed", {
                video: videosVisited,
                likesSubmitted,
                error: errorMessage(error),
              });
            }
          }
        } else {
          this.context.emit("browse", "already-liked-skip", {
            video: videosVisited,
            redFraction: round(beforeRed),
          });
        }
      }

      const shouldComment = commentsCompleted < program.commentCount &&
        likesSubmitted >= commentMilestone(commentsCompleted, program.likeCount, program.commentCount);
      if (shouldComment) {
        const text = chooseComment(usedComments);
        try {
          const outcome = await this.postComment(text, commentsCompleted + 1);
          usedComments.add(text);
          comments.push(text);
          commentsCompleted += 1;
          this.context.emit("browse", "comment-verified", {
            commentsCompleted,
            video: videosVisited,
            text,
            visuallyVerified: outcome.visuallyVerified,
          });
        } catch (error) {
          recoveries += 1;
          this.context.emit("recover", "comment-failed", {
            video: videosVisited,
            error: errorMessage(error),
          });
          await this.recoverToFeed();
        }
      }

      const unfinished = videosVisited < videoTarget ||
        likesSubmitted < program.likeCount || commentsCompleted < program.commentCount;
      if (Date.now() >= deadline && !unfinished) break;
      if (Date.now() < nextSwipeAt && !unfinished) {
        const dwellMs = Math.min(
          nextSwipeAt - Date.now(),
          Math.max(0, deadline - Date.now()),
        );
        await this.context.metrics.measure(
          "intentional_wait",
          "requested-content-dwell",
          () => wait(dwellMs, this.context.signal),
          { dwellMs },
        );
      } else if (Date.now() < nextSwipeAt) {
        const dwellMs = Math.min(1_200, nextSwipeAt - Date.now());
        await this.context.metrics.measure(
          "intentional_wait",
          "bounded-content-dwell",
          () => wait(dwellMs, this.context.signal),
          { dwellMs },
        );
      }
      if (Date.now() >= deadline && !unfinished) break;

      const before = await this.context.frames.latestModelFrame();
      await this.context.actions.swipe(
        LAYOUT.feedSwipeStart,
        LAYOUT.feedSwipeEnd,
        `browse:next-video-${videosVisited + 1}`,
        420,
        this.context.signal,
      );
      try {
        await this.context.actions.waitForChange(before, VIDEO_REGION, {
          threshold: 0.045,
          timeoutMs: 3_000,
          signal: this.context.signal,
        });
      } catch (error) {
        recoveries += 1;
        this.context.emit("recover", "video-change-not-confirmed", {
          video: videosVisited,
          error: errorMessage(error),
        });
      }
      videosVisited += 1;
      nextSwipeAt = Date.now() + nextDwellMs();
    }

    const browseCompletedAt = Date.now();
    this.context.emit("browse", "completed", {
      elapsedMs: browseCompletedAt - browseStartedAt,
      likesCompleted,
      likesSubmitted,
      commentsCompleted,
      videosVisited,
    });
    return {
      browseStartedAt,
      browseCompletedAt,
      browseElapsedMs: browseCompletedAt - browseStartedAt,
      likesCompleted,
      likesSubmitted,
      commentsCompleted,
      comments,
      videosVisited,
      recoveries,
    };
  }

  private async returnToPhoneHome() {
    const state = await this.context.perception.observeLatest();
    if (state.kind === "home") {
      this.context.emit("verification", "phone-home", {
        kind: state.kind,
        confidence: state.confidence,
        sequence: state.observation.sequence,
        alreadyHome: true,
      });
      return;
    }
    const beforeSequence = state.observation.sequence;
    await this.context.actions.phoneKey(
      "home",
      "finish:return-phone-home",
      this.context.signal,
    );
    await this.waitForState(
      (candidate) => candidate.kind === "home",
      7_000,
      beforeSequence,
      "phone-home",
    );
  }

  private async postComment(text: string, ordinal: number) {
    const feed = await this.context.frames.latestModelFrame();
    await this.context.actions.tap(
      LAYOUT.comment,
      `comment:${ordinal}:open`,
      80,
      this.context.signal,
    );
    const comments = await this.waitForState(
      (state) => state.kind === "tiktok_comments",
      5_000,
      feed.sequence,
      "comment-sheet",
    );
    await this.context.actions.tap(
      LAYOUT.commentComposer,
      `comment:${ordinal}:focus`,
      80,
      this.context.signal,
    );
    let keyboard = await this.waitForState(
      (state) => state.kind === "tiktok_comments" && state.observation.scene.keyboardVisible,
      4_000,
      comments.observation.sequence,
      "comment-keyboard",
    );
    keyboard = await this.waitForStableKeyboard(keyboard, "comment-keyboard-stable");
    await this.context.actions.inputText(text, `comment:${ordinal}:type`, this.context.signal);
    await this.context.actions.phoneKey("enter", `comment:${ordinal}:submit`, this.context.signal);
    let visuallyVerified = false;
    try {
      await this.waitForState(
        (state) => state.kind === "tiktok_comments" && !state.observation.scene.keyboardVisible,
        5_000,
        keyboard.observation.sequence,
        "comment-posted",
      );
      visuallyVerified = true;
    } catch (error) {
      this.context.emit("verification", "comment-submitted-unconfirmed", {
        ordinal,
        error: errorMessage(error),
      });
    }

    try {
      const beforeClose = (await this.context.frames.latestModelFrame()).sequence;
      await this.context.actions.tap(
        commentClosePoint(comments),
        `comment:${ordinal}:close`,
        80,
        this.context.signal,
      );
      await this.waitForState(
        (state) => state.kind === "tiktok_feed",
        6_000,
        beforeClose,
        "return-to-feed",
      );
    } catch (error) {
      this.context.emit("recover", "comment-close-failed", {
        ordinal,
        error: errorMessage(error),
      });
      await this.recoverToFeed();
    }
    return { submitted: true as const, visuallyVerified };
  }

  private async recoverToFeed() {
    try {
      const before = (await this.context.frames.latestModelFrame()).sequence;
      await this.context.actions.phoneKey("back", "recover:back-to-feed", this.context.signal);
      await this.waitForState(
        (state) => state.kind === "tiktok_feed",
        5_000,
        before,
        "recovered-feed",
      );
    } catch {
      // The next state observation retains fail-closed behavior if Back did not recover.
    }
  }

  private async search(query: string, inspectResultCount: number) {
    const before = await this.context.frames.latestModelFrame();
    await this.context.actions.tap(
      LAYOUT.search,
      "search:open",
      80,
      this.context.signal,
    );
    let search = await this.waitForState(
      (state) => state.kind === "tiktok_search" && state.observation.scene.keyboardVisible,
      5_000,
      before.sequence,
      "tiktok-search",
    );
    search = await this.waitForStableKeyboard(search, "search-keyboard-stable");
    await this.context.actions.inputText(query, "search:type-query", this.context.signal);
    await this.context.actions.phoneKey("enter", "search:submit", this.context.signal);
    let results = await this.waitForState(
      (state) => state.kind === "tiktok_results",
      8_000,
      search.observation.sequence,
      "search-results",
    );
    const videosTarget = locateHorizontalToken(results, "videos") ??
      locateTextInObservation("Videos", results.observation);
    const beforeTab = await this.context.frames.latestModelFrame();
    await this.context.actions.tap(
      videosTarget
        ? normalizePoint(videosTarget.point, results.observation.viewport)
        : LAYOUT.videosTab,
      "search:videos-tab",
      80,
      this.context.signal,
    );
    await this.context.actions.waitForChange(beforeTab, SEARCH_HEADER_REGION, {
      threshold: 0.012,
      timeoutMs: 4_000,
      signal: this.context.signal,
    });
    results = await this.waitForState(
      (state) => state.kind === "tiktok_results",
      5_000,
      results.observation.sequence,
      "video-results",
    );
    const accurateGridText = await this.accurateText(await this.context.frames.latestModelFrame());
    const findings = summarizeText(accurateGridText, inspectResultCount);
    const inspected = await this.inspectTopVideos(results);
    findings.push(...inspected.filter((finding) => !findings.includes(finding)));
    const finalFramePath = await this.saveFinalFrame();
    this.context.emit("search", "completed", {
      query,
      findings: findings.length,
      finalFramePath,
    });
    return { findings, finalFramePath };
  }

  private async inspectTopVideos(initialResults: RuntimeScreenState) {
    const targets = [
      { x: 180 / 720, y: 480 / 1_560 },
      { x: 540 / 720, y: 480 / 1_560 },
    ];
    const findings: string[] = [];
    let results = initialResults;
    for (let index = 0; index < targets.length; index += 1) {
      const before = await this.context.frames.latestModelFrame();
      await this.context.actions.tap(
        targets[index],
        `inspect:video-${index + 1}`,
        80,
        this.context.signal,
      );
      await this.context.perception.waitFor(
        (state) => state.kind === "tiktok_video" || state.kind === "tiktok_feed",
        {
          timeoutMs: 6_000,
          afterSequence: before.sequence,
          signal: this.context.signal,
        },
      );
      const opened = await this.context.frames.latestModelFrame();
      const text = summarizeText(await this.accurateText(opened), 4);
      if (text.length) findings.push(`Video ${index + 1}: ${text.join(" · ")}`);
      this.context.emit("inspect", `video-${index + 1}`, { text });
      await this.context.actions.tap(
        LAYOUT.videoBack,
        `inspect:video-${index + 1}:back`,
        80,
        this.context.signal,
      );
      results = await this.waitForState(
        (state) => state.kind === "tiktok_results",
        6_000,
        results.observation.sequence,
        "return-to-results",
      );
    }
    return findings;
  }

  private accurateText(frame: AgentFrame) {
    return this.context.metrics.measure("content", "accurate-local-ocr", async () => {
      const ocr = await recognizeVisionText(
        `data:${frame.mimeType};base64,${frame.bytes.toString("base64")}`,
        this.context.signal,
        "accurate",
      );
      return ocr.items
        .filter((item) => item.confidence >= 0.38)
        .map((item) => item.text);
    }, { sequence: frame.sequence });
  }

  private async saveFinalFrame() {
    const directory = resolve(this.context.artifactDirectory ?? "build/runtime");
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, "realtime-agent-final.jpg");
    const frame = await this.context.frames.latestModelFrame();
    await writeFile(path, frame.bytes);
    return path;
  }

  private waitForStableKeyboard(initial: RuntimeScreenState, label: string) {
    return this.context.metrics.measure(
      "phone_animation",
      label,
      () => this.waitForStableKeyboardFrames(initial, label),
      { afterSequence: initial.observation.sequence },
    );
  }

  private async waitForStableKeyboardFrames(initial: RuntimeScreenState, label: string) {
    let state = initial;
    const currentFrame = await this.context.frames.latestModelFrame();
    if (
      state.observation.scene.keyboardVisible &&
      iosEnglishKeyboardVisible(currentFrame.bytes)
    ) {
      this.context.emit("verification", label, {
        sequence: currentFrame.sequence,
        deterministicPixelMatch: true,
        consecutiveFrames: 1,
      });
      return state;
    }
    let consecutive = state.observation.scene.keyboardVisible ? 1 : 0;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const frame = await this.context.frames.waitForModelFrame(
        state.observation.sequence,
        Math.max(100, deadline - Date.now()),
        this.context.signal,
      );
      state = await this.context.perception.observeLatest();
      if (this.popupGuardian.detect(state)) {
        const recovery = await this.popupGuardian.handle(state);
        if (!recovery.handled) {
          throw new Error(recovery.error ?? "The popup guardian could not clear an interruption.");
        }
        state = recovery.state;
        consecutive = 0;
        continue;
      }
      consecutive = state.observation.scene.keyboardVisible ? consecutive + 1 : 0;
      if (consecutive >= 2) {
        this.context.emit("verification", label, {
          sequence: frame.sequence,
          consecutiveFrames: consecutive,
          ocrMs: state.observation.ocrElapsedMs,
        });
        return state;
      }
    }
    throw new Error("The iOS keyboard did not remain visible for three consecutive frames.");
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
      if (predicate(recovery.state)) {
        this.context.emit("verification", label, {
          kind: recovery.state.kind,
          confidence: recovery.state.confidence,
          sequence: recovery.state.observation.sequence,
          ocrMs: recovery.state.observation.ocrElapsedMs,
          resumedAfterPopup: true,
        });
        return recovery.state;
      }
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
}

const VIDEO_REGION: NormalizedRegion = { left: 0.04, top: 0.12, width: 0.78, height: 0.72 };
const FULL_SCREEN: NormalizedRegion = { left: 0, top: 0, width: 1, height: 1 };
const SEARCH_HEADER_REGION: NormalizedRegion = { left: 0.02, top: 0.1, width: 0.96, height: 0.2 };

function normalizePoint(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
) {
  return { x: point.x / viewport.width, y: point.y / viewport.height };
}

function isTikTokSubscreen(state: RuntimeScreenState) {
  return state.kind === "tiktok_results" ||
    state.kind === "tiktok_search" ||
    state.kind === "tiktok_comments" ||
    state.kind === "tiktok_sound" ||
    state.kind === "tiktok_video";
}

export function commentClosePoint(state: RuntimeScreenState) {
  const title = state.observation.elements
    .filter((element) => /comments?/i.test(element.text))
    .filter((element) =>
      element.center.y >= state.observation.viewport.height * 0.2 &&
      element.center.y <= state.observation.viewport.height * 0.65
    )
    .sort((left, right) => right.confidence - left.confidence)[0];
  return {
    x: 0.94,
    y: title
      ? title.center.y / state.observation.viewport.height
      : 0.405,
  };
}

export function locateHorizontalToken(
  state: RuntimeScreenState,
  target: "videos",
) {
  const viewport = state.observation.viewport;
  const candidates = state.observation.elements
    .filter((element) =>
      element.center.y >= viewport.height * 0.08 &&
      element.center.y <= viewport.height * 0.2
    )
    .map((element) => {
      const value = element.text.toLocaleLowerCase("en-US");
      const exactIndex = value.indexOf(target);
      const clipped = target === "videos" ? "ideos" : target;
      const index = exactIndex >= 0 ? exactIndex : value.indexOf(clipped);
      return { element, value, index, length: exactIndex >= 0 ? target.length : clipped.length };
    })
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => right.element.confidence - left.element.confidence);
  const selected = candidates[0];
  if (!selected) return null;
  const characterCenter = selected.index + selected.length / 2;
  return {
    label: target,
    confidence: selected.element.confidence,
    point: {
      x: selected.element.bounds.left +
        selected.element.bounds.width * characterCenter / Math.max(1, selected.value.length),
      y: selected.element.center.y,
    },
  };
}

function commentMilestone(index: number, likeCount: number, commentCount: number) {
  if (!commentCount) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil((index + 1) * likeCount / commentCount));
}

function chooseComment(used: Set<string>) {
  const choices = COMMENT_TEXTS.filter((comment) => !used.has(comment));
  return choices[randomInt(0, choices.length || COMMENT_TEXTS.length)] ?? COMMENT_TEXTS[0];
}

function summarizeResults(elements: ScreenElement[], maximum: number) {
  const ignored = /^(?:\d{1,2}:\d{2}.*|q\s+alhazar|ask a[il1]|top|videos?|users?|shop|sounds?|live|search|home|friends|inbox|profile|all|unwatched|watched|recently uploaded|view all.*|follow)$/i;
  const seen = new Set<string>();
  return elements
    .filter((element) => element.confidence >= 0.38)
    .map((element) => element.text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= 4 && !ignored.test(text))
    .filter((text) => {
      const key = text.toLocaleLowerCase("en-US");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maximum);
}

function summarizeText(values: string[], maximum: number) {
  return summarizeResults(values.map((text, index) => ({
    id: String(index),
    role: "text",
    text,
    confidence: 1,
    center: { x: 0, y: 0 },
    bounds: { left: 0, top: 0, width: 0, height: 0 },
  })), maximum);
}

function wait(ms: number, signal: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The TikTok skill was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The TikTok skill was aborted.", "AbortError");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
