import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRealtimePhoneKeyAllowed,
  assertRealtimeTapAllowed,
  assertRealtimeTextInputAllowed,
  RealtimeActionSafetyError,
} from "./action-safety";

const readOnlyInstagram = { mode: "read_only", app: "instagram" } as const;

test("read-only Instagram permits navigation and account lookup", () => {
  assert.doesNotThrow(() => assertRealtimeTapAllowed(
    readOnlyInstagram,
    { x: 0.69, y: 0.942 },
    "search:open-tab",
  ));
  assert.doesNotThrow(() => assertRealtimeTapAllowed(
    readOnlyInstagram,
    { x: 0.16, y: 0.7 },
    "profile:open-latest-reel",
  ));
  assert.doesNotThrow(() => assertRealtimeTextInputAllowed(
    readOnlyInstagram,
    "search:type-query",
  ));
  assert.doesNotThrow(() => assertRealtimePhoneKeyAllowed(
    readOnlyInstagram,
    "back",
    "navigation:back",
  ));
});

test("read-only Instagram blocks mutation labels and the engagement rail", () => {
  assert.throws(
    () => assertRealtimeTapAllowed(readOnlyInstagram, { x: 0.5, y: 0.5 }, "metrics:read-likes"),
    RealtimeActionSafetyError,
  );
  assert.throws(
    () => assertRealtimeTapAllowed(readOnlyInstagram, { x: 0.925, y: 0.57 }, "metrics:probe"),
    RealtimeActionSafetyError,
  );
  assert.throws(
    () => assertRealtimeTextInputAllowed(readOnlyInstagram, "comment:type"),
    RealtimeActionSafetyError,
  );
  assert.throws(
    () => assertRealtimePhoneKeyAllowed(readOnlyInstagram, "enter", "submit"),
    RealtimeActionSafetyError,
  );
});

test("full access exposes all interaction capabilities to the task executor", () => {
  const fullAccess = { mode: "full_access", app: "instagram" } as const;
  assert.doesNotThrow(() => assertRealtimeTapAllowed(
    fullAccess,
    { x: 0.925, y: 0.57 },
    "engagement:like",
  ));
  assert.doesNotThrow(() => assertRealtimeTextInputAllowed(
    fullAccess,
    "comment:type",
  ));
  assert.doesNotThrow(() => assertRealtimePhoneKeyAllowed(
    fullAccess,
    "enter",
    "comment:submit",
  ));
});
