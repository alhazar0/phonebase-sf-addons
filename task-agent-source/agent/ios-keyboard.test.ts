import assert from "node:assert/strict";
import test from "node:test";
import { iosEnglishKeyboardSequence } from "./ios-keyboard";

test("turns letters, case, digits, punctuation and spaces into deterministic iOS taps", () => {
  const sequence = iosEnglishKeyboardSequence("aB 3!");
  assert.deepEqual(sequence.map((point) => point.key), [
    "a", "shift", "b", "space", "123", "3", "!", "ABC",
  ]);
});

test("accounts for iOS automatic capitalization before typing", () => {
  assert.deepEqual(
    iosEnglishKeyboardSequence("screen", undefined, { shiftActive: true })
      .map((point) => point.key),
    ["shift", "s", "c", "r", "e", "e", "n"],
  );
  assert.deepEqual(
    iosEnglishKeyboardSequence("Screen", undefined, { shiftActive: true })
      .map((point) => point.key),
    ["s", "c", "r", "e", "e", "n"],
  );
});

test("never submits a form or guesses an unsupported keyboard", () => {
  assert.throws(() => iosEnglishKeyboardSequence("hello\n"), /key action/i);
  assert.throws(() => iosEnglishKeyboardSequence("你好"), /cannot type/i);
});

test("uses strict device key overrides and rejects every uncalibrated key", () => {
  const calibration = {
    strict: true,
    points: {
      shift: { x: 10, y: 1405 },
      a: { x: 10, y: 1222 },
      s: { x: 80, y: 1222 },
      u: { x: 475, y: 1129 },
    },
  };
  assert.deepEqual(
    iosEnglishKeyboardSequence("ASU", calibration),
    [
      { key: "shift", x: 10, y: 1405 },
      { key: "a", x: 10, y: 1222 },
      { key: "shift", x: 10, y: 1405 },
      { key: "s", x: 80, y: 1222 },
      { key: "shift", x: 10, y: 1405 },
      { key: "u", x: 475, y: 1129 },
    ],
  );
  assert.throws(
    () => iosEnglishKeyboardSequence("B", calibration),
    /not calibrated/i,
  );
});
