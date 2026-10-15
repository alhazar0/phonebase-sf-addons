import assert from "node:assert/strict";
import test from "node:test";
import type { ScreenObservation } from "../general-agent-contract";
import { LocalPageTracker } from "./state";

type Entry = [string, number, number];
function observation(entries: Entry[], sequence = 1, overrides: Partial<ScreenObservation> = {}): ScreenObservation {
  return {
    sequence, capturedAt: 10_000 + sequence * 200, viewport: { width: 720, height: 1280 },
    fingerprint: String(sequence), changeRatio: 0.1, changeKind: "minor", ocrCacheHit: false,
    ocrElapsedMs: 50, observationElapsedMs: 60, averageTextConfidence: 0.9, textSignature: new Set(entries.map(x => x[0])),
    elements: entries.map(([text, x, y], i) => ({ id: String(i), text, role: "text", confidence: 0.9, center: { x, y }, bounds: { left: x - 30, top: y - 10, width: 60, height: 20 } })),
    scene: { kind: "text_ui", confidence: 0.7, homeGridScore: 0, keyboardVisible: false },
    ...overrides,
  };
}
const clock: Entry[] = [["World Clock", 200, 200], ["3:25PM", 560, 400], ["6:25PM", 560, 650]];
const feed: Entry[] = [["For You", 430, 120], ["Following", 240, 120], ["123", 650, 430], ["456", 650, 580], ["789", 650, 740], ["Home", 90, 1200], ["Profile", 630, 1200]];
const comments: Entry[] = [["Comments", 340, 500], ["Reply", 140, 700], ["Reply", 140, 850], ["Add comment...", 250, 1200]];

test("clock needs two different frames, not duplicate polling of one frame", () => {
  const tracker = new LocalPageTracker();
  assert.equal(tracker.observe(observation(clock)).page, "unknown");
  assert.equal(tracker.observe(observation(clock)).page, "unknown");
  assert.equal(tracker.observe(observation(clock, 2)).page, "clock");
});
test("like and comment words alone do not prove a feed", () => {
  const tracker = new LocalPageTracker();
  const words: Entry[] = [["TikTok", 250, 180], ["Likes", 100, 450], ["Comments", 100, 600], ["Shares", 100, 800]];
  tracker.observe(observation(words));
  assert.equal(tracker.observe(observation(words, 2)).page, "unknown");
});
test("feed combines top tabs, right-side controls and bottom navigation", () => {
  const tracker = new LocalPageTracker();
  tracker.observe(observation(feed));
  const result = tracker.observe(observation(feed, 2));
  assert.equal(result.page, "content_feed");
  assert.equal(result.scoreIsProbability, false);
  assert.ok(result.evidence.length >= 3);
});
test("text in video content cannot substitute for top navigation", () => {
  const tracker = new LocalPageTracker();
  const inside = feed.map(([text, x, y]): Entry => [text, x, y < 200 ? 500 : y]);
  tracker.observe(observation(inside));
  assert.equal(tracker.observe(observation(inside, 2)).page, "unknown");
});
test("comments are an overlay and retain recently verified underlying context", () => {
  const tracker = new LocalPageTracker();
  tracker.observe(observation(feed)); tracker.observe(observation(feed, 2));
  const result = tracker.observe(observation(comments, 3));
  assert.equal(result.overlay, "comments");
  assert.equal(result.page, "content_feed");
  assert.equal(result.source, "recent_context");
});
test("an unseen comment overlay does not fabricate an underlying feed", () => {
  const result = new LocalPageTracker().observe(observation(comments));
  assert.equal(result.overlay, "comments"); assert.equal(result.page, "unknown");
});
test("comment word alone does not open an overlay", () => {
  assert.equal(new LocalPageTracker().observe(observation([["Comments", 300, 500]])).overlay, "none");
});
test("old context expires, including beneath an overlay", () => {
  const tracker = new LocalPageTracker();
  tracker.observe(observation(feed)); tracker.observe(observation(feed, 2));
  const result = tracker.observe(observation(comments, 40));
  assert.equal(result.page, "unknown");
});
test("unrelated new evidence does not inherit the previous page", () => {
  const tracker = new LocalPageTracker();
  tracker.observe(observation(feed)); tracker.observe(observation(feed, 2));
  assert.equal(tracker.observe(observation([["Offer", 300, 300]], 3)).page, "unknown");
});
test("search requires corroboration beyond a Search button", () => {
  const tracker = new LocalPageTracker();
  const search: Entry[] = [["Search", 200, 150], ["Cancel", 600, 150], ["Recent searches", 200, 340]];
  tracker.observe(observation(search));
  assert.equal(tracker.observe(observation(search, 2)).page, "search");
  assert.equal(new LocalPageTracker().observe(observation([["Search", 200, 150]])).page, "unknown");
});
test("Chinese settings and clock layouts are supported without app-specific names", () => {
  const tracker = new LocalPageTracker();
  const settings: Entry[] = [["设置", 150, 180], ["隐私", 150, 400], ["通知", 150, 550], ["通用", 150, 700]];
  tracker.observe(observation(settings));
  assert.equal(tracker.observe(observation(settings, 2)).page, "settings");
  const clockTracker = new LocalPageTracker();
  clockTracker.observe(observation([["世界时钟", 200, 200], ...clock.slice(1)]));
  assert.equal(clockTracker.observe(observation([["世界时钟", 200, 200], ...clock.slice(1)], 2)).page, "clock");
});
test("keyboard and dialog are independent of base page", () => {
  const tracker = new LocalPageTracker();
  tracker.observe(observation(clock)); tracker.observe(observation(clock, 2));
  const result = tracker.observe(observation([["Allow", 200, 600], ["Don't allow", 450, 600]], 3, {
    scene: { kind: "keyboard", confidence: 0.9, homeGridScore: 0, keyboardVisible: true },
  }));
  assert.equal(result.overlay, "dialog"); assert.equal(result.keyboard, true); assert.equal(result.page, "clock");
});
test("frame sequence reset discards old scene memory", () => {
  const tracker = new LocalPageTracker();
  tracker.observe(observation(feed, 5)); tracker.observe(observation(feed, 6));
  assert.equal(tracker.observe(observation(comments, 1)).page, "unknown");
});
test("resolution changes discard old scene memory", () => {
  const tracker = new LocalPageTracker();
  tracker.observe(observation(feed)); tracker.observe(observation(feed, 2));
  assert.equal(tracker.observe(observation(comments, 3, { viewport: { width: 1080, height: 1920 } })).page, "unknown");
});
test("low-confidence OCR cannot establish a page", () => {
  const frame = observation(clock);
  frame.elements = frame.elements.map(item => ({ ...item, confidence: 0.2 }));
  const tracker = new LocalPageTracker(); tracker.observe(frame);
  assert.equal(tracker.observe({ ...frame, sequence: 2 }).page, "unknown");
});
