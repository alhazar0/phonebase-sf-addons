import assert from "node:assert/strict";
import test from "node:test";

import { locateHomeApp, requestedHomeApp } from "./fast-vision";

test("extracts bounded open-app intents in Chinese and English", () => {
  assert.equal(requestedHomeApp("打开 Telegram 应用，并等待界面出现"), "Telegram");
  assert.equal(requestedHomeApp("Please open Google Photos app and wait"), "Google Photos");
  assert.equal(requestedHomeApp("向下滚动页面"), null);
});

test("does not collapse a multi-step goal into an app launch substring", () => {
  assert.equal(
    requestedHomeApp("给19195525252打电话，并打开扬声器，10秒后挂掉"),
    null,
  );
  assert.equal(requestedHomeApp("打开 Phone，然后拨号并挂断"), null);
  assert.equal(requestedHomeApp("打开 TikTok，刷10个视频，点赞三个"), null);
});

test("maps a recognized home label to the icon above it", () => {
  const item = (text: string, centerX: number, centerY: number) => ({
    text,
    confidence: 0.95,
    left: centerX - 20,
    top: centerY - 6,
    width: 40,
    height: 12,
    centerX,
    centerY,
  });
  const result = locateHomeApp("Telegram", {
    ok: true,
    imageWidth: 473,
    imageHeight: 1_024,
    elapsedMs: 500,
    items: [
      item("Telegram", 65, 172),
      item("Gemini", 180, 172),
      item("Reddit", 410, 172),
      item("Gmail", 65, 410),
      item("Google", 180, 410),
    ],
  }, { width: 720, height: 1_560 });
  assert.ok(result);
  assert.equal(result.homeLabelCount, 5);
  assert.ok(Math.abs(result.point.x - 99) < 2);
  assert.ok(Math.abs(result.point.y - 178) < 2);
});

test("tolerates one fast-OCR glyph error in an exact home app label", () => {
  const item = (text: string, centerX: number) => ({
    text,
    confidence: 0.5,
    left: centerX - 20,
    top: 160,
    width: 40,
    height: 12,
    centerX,
    centerY: 166,
  });
  const result = locateHomeApp("Telegram", {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 60,
    items: [
      item("Tele9ram", 120),
      item("Gemini", 240),
      item("Redd6t", 360),
      item("Outlook", 120),
      item("Google Photos", 240),
      item("AnyConnect", 360),
    ],
  }, { width: 720, height: 1_560 });

  assert.ok(result);
  assert.equal(result.recognizedLabel, "Tele9ram");
  assert.equal(result.homeLabelCount, 6);
});
