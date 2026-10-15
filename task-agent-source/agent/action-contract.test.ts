import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScreenHandCapabilities,
  normalizeScreenHandPoint,
  parseScreenHandActionEnvelope,
  ScreenHandActionValidationError,
} from "./action-contract";

test("accepts a VMOS-style viewport tap and normalizes it", () => {
  const envelope = parseScreenHandActionEnvelope({
    idempotencyKey: "agent-job-1-step-2",
    action: {
      type: "tap",
      point: { x: 540, y: 600 },
      viewport: { width: 1080, height: 2400 },
      frameSequence: 42,
    },
  });

  assert.equal(envelope.action.type, "tap");
  if (envelope.action.type !== "tap") return;
  assert.deepEqual(
    normalizeScreenHandPoint(envelope.action.point, envelope.action.viewport),
    { x: 0.5, y: 0.25 },
  );
  assert.equal(envelope.action.durationMs, 40);
});

test("rejects unknown request, action, and coordinate fields", () => {
  assert.throws(
    () => parseScreenHandActionEnvelope({
      idempotencyKey: "strict-envelope",
      action: { type: "status" },
      debug: true,
    }),
    /unsupported field: debug/,
  );
  assert.throws(
    () => parseScreenHandActionEnvelope({
      idempotencyKey: "strict-action",
      action: {
        type: "tap",
        point: { x: 10, y: 20 },
        viewport: { width: 720, height: 1560 },
        frameSequence: 1,
        force: 1,
      },
    }),
    /unsupported field: force/,
  );
  assert.throws(
    () => parseScreenHandActionEnvelope({
      idempotencyKey: "strict-point",
      action: {
        type: "tap",
        point: { x: 10, y: 20, z: 3 },
        viewport: { width: 720, height: 1560 },
        frameSequence: 1,
      },
    }),
    /unsupported field: z/,
  );
});

test("accepts an audited per-gesture touch depth", () => {
  const envelope = parseScreenHandActionEnvelope({
    idempotencyKey: "human-pressure-1",
    action: {
      type: "tap",
      point: { x: 360, y: 780 },
      viewport: { width: 720, height: 1560 },
      frameSequence: 7,
      touchZ: 9.73,
    },
  });
  assert.equal(envelope.action.type, "tap");
  if (envelope.action.type !== "tap") return;
  assert.equal(envelope.action.touchZ, 9.73);
});

test("publishes the exact physical gesture duration limits", () => {
  const context = {
    point: { x: 360, y: 780 },
    viewport: { width: 720, height: 1560 },
    frameSequence: 7,
  };
  for (const action of [
    { type: "tap", ...context, durationMs: 251 },
    { type: "long_press", ...context, durationMs: 499 },
    {
      type: "swipe",
      start: context.point,
      end: { x: 400, y: 900 },
      viewport: context.viewport,
      frameSequence: context.frameSequence,
      durationMs: 3_001,
    },
  ]) {
    assert.throws(
      () => parseScreenHandActionEnvelope({
        idempotencyKey: `duration-${action.type}`,
        action,
      }),
      ScreenHandActionValidationError,
    );
  }
});

test("allows a bounded task wait long enough for timed UI workflows", () => {
  assert.deepEqual(parseScreenHandActionEnvelope({
    idempotencyKey: "wait-ten-seconds",
    action: { type: "wait", durationMs: 10_000 },
  }).action, { type: "wait", durationMs: 10_000 });
  assert.throws(
    () => parseScreenHandActionEnvelope({
      idempotencyKey: "wait-too-long",
      action: { type: "wait", durationMs: 30_001 },
    }),
    ScreenHandActionValidationError,
  );
});

test("accepts a calibrated hover target without a touch depth", () => {
  const envelope = parseScreenHandActionEnvelope({
    idempotencyKey: "mouse-hover-1",
    action: {
      type: "hover_move",
      point: { x: 360, y: 780 },
      viewport: { width: 720, height: 1560 },
      frameSequence: 7,
    },
  });
  assert.deepEqual(envelope.action, {
    type: "hover_move",
    point: { x: 360, y: 780 },
    viewport: { width: 720, height: 1560 },
    frameSequence: 7,
  });
});

test("accepts a session-bound live mouse contact lifecycle", () => {
  const context = {
    point: { x: 360, y: 780 },
    viewport: { width: 720, height: 1560 },
    frameSequence: 9,
    sessionId: "mouse-session-1",
  };
  const down = parseScreenHandActionEnvelope({
    idempotencyKey: "live-down-1",
    action: { type: "touch_down", ...context, touchZ: 9.75 },
  });
  assert.deepEqual(down.action, {
    type: "touch_down",
    ...context,
    touchZ: 9.75,
  });
  const move = parseScreenHandActionEnvelope({
    idempotencyKey: "live-move-1",
    action: { type: "touch_move", ...context, point: { x: 400, y: 820 } },
  });
  assert.equal(move.action.type, "touch_move");
  const up = parseScreenHandActionEnvelope({
    idempotencyKey: "live-up-1",
    action: { type: "touch_up", sessionId: context.sessionId },
  });
  assert.deepEqual(up.action, { type: "touch_up", sessionId: context.sessionId });
  const keepalive = parseScreenHandActionEnvelope({
    idempotencyKey: "live-keepalive-1",
    action: { type: "touch_keepalive", sessionId: context.sessionId },
  });
  assert.deepEqual(keepalive.action, {
    type: "touch_keepalive",
    sessionId: context.sessionId,
  });
});

test("rejects unbound or overlong live mouse sessions", () => {
  for (const [type, sessionId] of [
    ["touch_up", ""],
    ["touch_keepalive", "x".repeat(161)],
  ] as const) {
    assert.throws(
      () => parseScreenHandActionEnvelope({
        idempotencyKey: `bad-${type}`,
        action: { type, sessionId },
      }),
      ScreenHandActionValidationError,
    );
  }
});

test("rejects touch points outside the declared viewport", () => {
  assert.throws(
    () => parseScreenHandActionEnvelope({
      idempotencyKey: "bad-point",
      action: {
        type: "tap",
        point: { x: 1081, y: 600 },
        viewport: { width: 1080, height: 2400 },
        frameSequence: 42,
      },
    }),
    ScreenHandActionValidationError,
  );
});

test("requires an explicit clear-workspace confirmation before homing", () => {
  const envelope = parseScreenHandActionEnvelope({
    idempotencyKey: "operator-home-1",
    action: {
      type: "home",
      confirmation: "CLEAR_WORKSPACE_AND_HOME",
    },
  });
  assert.deepEqual(envelope.action, {
    type: "home",
    confirmation: "CLEAR_WORKSPACE_AND_HOME",
  });
  assert.throws(
    () => parseScreenHandActionEnvelope({
      idempotencyKey: "operator-home-unsafe",
      action: { type: "home" },
    }),
    ScreenHandActionValidationError,
  );
});

test("accepts an explicit non-motion resume action", () => {
  const envelope = parseScreenHandActionEnvelope({
    idempotencyKey: "operator-resume-1",
    action: { type: "resume" },
  });
  assert.deepEqual(envelope.action, { type: "resume" });
});

test("accepts bounded text entry and phone navigation actions", () => {
  const text = parseScreenHandActionEnvelope({
    idempotencyKey: "agent-text-1",
    action: { type: "input_text", text: "ASU", touchZ: 9.7 },
  });
  assert.deepEqual(text.action, {
    type: "input_text",
    text: "ASU",
    touchZ: 9.7,
  });
  const back = parseScreenHandActionEnvelope({
    idempotencyKey: "agent-back-1",
    action: { type: "phone_key", key: "back" },
  });
  assert.deepEqual(back.action, { type: "phone_key", key: "back" });
  const keyboardNext = parseScreenHandActionEnvelope({
    idempotencyKey: "keyboard-next-1",
    action: { type: "phone_key", key: "keyboard_next" },
  });
  assert.deepEqual(keyboardNext.action, {
    type: "phone_key",
    key: "keyboard_next",
  });
  assert.throws(
    () => parseScreenHandActionEnvelope({
      idempotencyKey: "agent-key-unsafe",
      action: { type: "phone_key", key: "volume_up" },
    }),
    ScreenHandActionValidationError,
  );
});

test("publishes physical actions as calibration-gated capabilities", () => {
  const gated = buildScreenHandCapabilities({
    frameReady: true,
    calibrationReady: false,
  });
  assert.equal(gated.observation.screenshot.available, true);
  assert.equal(gated.actions.tap.available, false);
  assert.equal(gated.actions.hover_move.available, false);
  assert.equal(gated.actions.touch_down.available, false);
  assert.equal(gated.actions.touch_move.available, false);
  assert.equal(gated.actions.touch_up.available, true);
  assert.equal(gated.actions.touch_keepalive.available, true);
  assert.match(gated.actions.tap.reason ?? "", /calibration/i);
  assert.equal(gated.actions.hold.available, true);
  assert.equal(gated.actions.resume.available, false);
  assert.equal(gated.actions.wait.available, true);

  const gestureReady = buildScreenHandCapabilities({
    frameReady: true,
    calibrationReady: true,
    homeReady: true,
    resumeReady: true,
    longPressReady: true,
    swipeReady: true,
    inputTextReady: true,
    phoneKeyReady: true,
  });
  assert.equal(gestureReady.actions.long_press.available, true);
  assert.equal(gestureReady.actions.hover_move.available, true);
  assert.equal(gestureReady.actions.touch_down.available, true);
  assert.equal(gestureReady.actions.touch_move.available, true);
  assert.equal(gestureReady.actions.swipe.available, true);
  assert.equal(gestureReady.actions.home.available, true);
  assert.equal(gestureReady.actions.resume.available, true);
  assert.deepEqual(Object.keys(gestureReady.actions), [
    "status",
    "hold",
    "resume",
    "home",
    "hover_move",
    "touch_down",
    "touch_move",
    "touch_up",
    "touch_keepalive",
    "tap",
    "long_press",
    "swipe",
    "input_text",
    "phone_key",
    "wait",
  ]);
});
