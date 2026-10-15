import assert from "node:assert/strict";
import test from "node:test";

import {
  iosKeyboardShiftActive,
  locateVisibleText,
  looksLikeIosKeyboard,
  keyboardUsesNonLatinInput,
  requestedClickTarget,
  requestedTextInput,
  requestedSwipe,
  requestsTopLeftClose,
  signaturesDiffer,
} from "./fast-intent";

const ocrItem = (text: string) => ({
  text,
  confidence: 1,
  left: 10,
  top: 10,
  width: 80,
  height: 20,
  centerX: 50,
  centerY: 20,
});

test("parses visible click, close, and directional swipe intents", () => {
  assert.equal(requestedClickTarget("点击左上角的 X，关闭当前浏览器"), "X");
  assert.equal(requestedClickTarget("Please click the Continue button"), "Continue");
  assert.equal(requestedClickTarget(`点击 "Don't Allow"`), "Don't Allow");
  assert.equal(requestsTopLeftClose("点击左上角的 X，关闭当前浏览器"), true);
  const swipe = requestedSwipe("向下滚动一次", { width: 720, height: 1_560 });
  assert.equal(swipe?.name, "scroll down");
  assert.deepEqual(swipe?.start, { x: 360, y: 1_154.4 });
  assert.ok(Math.abs(Number(swipe?.end.y) - 436.8) < 0.001);
});

test("parses bounded natural-language text entry", () => {
  assert.deepEqual(requestedTextInput("在 Message 输入框输入 ASU"), {
    field: "Message",
    text: "ASU",
  });
  assert.deepEqual(requestedTextInput('Type "hello" into the Search field'), {
    field: "Search",
    text: "hello",
  });
});

test("detects a meaningful OCR text change", () => {
  assert.equal(signaturesDiffer(new Set(["one", "two"]), new Set(["one", "three"])), true);
  assert.equal(signaturesDiffer(new Set(["one", "two"]), new Set(["one", "two"])), false);
});

test("recognizes an OCR keyboard without relying on screen colors", () => {
  const keys = "qwertyuiop".split("").map((text, index) => ({
    text,
    confidence: 0.9,
    left: index * 20,
    top: 700,
    width: 12,
    height: 18,
    centerX: index * 20 + 6,
    centerY: 720,
  }));
  assert.equal(looksLikeIosKeyboard({
    ok: true,
    imageWidth: 473,
    imageHeight: 1_024,
    elapsedMs: 10,
    items: keys,
  }), true);
});

test("detects a non-Latin keyboard candidate row without reading page content", () => {
  assert.equal(keyboardUsesNonLatinInput({
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: [
      { ...ocrItem("深航方案"), centerY: 950, top: 930 },
      { ...ocrItem("English page content"), centerY: 500, top: 480 },
    ],
  }), true);
  assert.equal(keyboardUsesNonLatinInput({
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: [{ ...ocrItem("Suggestions"), centerY: 950, top: 930 }],
  }), false);
  assert.equal(keyboardUsesNonLatinInput({
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: [
      { ...ocrItem("у и"), confidence: 0.3, centerY: 1_105, top: 1_085 },
      { ...ocrItem("і ор"), confidence: 0.3, centerY: 1_105, top: 1_085 },
    ],
  }), false);
});

test("detects the one-shot iOS uppercase keyboard state from the key rows", () => {
  const keyboardOcr = (text: string) => ({
    ok: true as const,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: [{
      ...ocrItem(text),
      centerY: 1_105,
      top: 1_085,
    }],
  });
  assert.equal(iosKeyboardShiftActive(keyboardOcr("QWERTYUIOP")), true);
  assert.equal(iosKeyboardShiftActive(keyboardOcr("qwertyuiop")), false);
  assert.equal(iosKeyboardShiftActive(keyboardOcr("Qwe")), null);
});

test("finds a short requested token when OCR merges it with an adjacent icon", () => {
  const match = locateVisibleText("ASU", {
    ok: true,
    imageWidth: 720,
    imageHeight: 1560,
    elapsedMs: 10,
    items: [ocrItem("Q ASU")],
  }, { width: 720, height: 1560 });
  assert.equal(match?.recognizedLabel, "Q ASU");
  assert.equal(
    locateVisibleText("ASU", {
      ok: true,
      imageWidth: 720,
      imageHeight: 1560,
      elapsedMs: 10,
      items: [ocrItem("CASUAL")],
    }, { width: 720, height: 1560 }),
    null,
  );
});
