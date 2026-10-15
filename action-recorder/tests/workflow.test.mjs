import test from "node:test";
import assert from "node:assert/strict";

import {
  containDimensions,
  describeStep,
  interpolateHoverPath,
  materializeAction,
  normalizeStep,
  normalizeWorkflow,
  shouldRunStep,
} from "../public/workflow.js";
import { allowedProxyRoute, createRecorderServer } from "../server.mjs";

test("normalizes a bounded loop workflow", () => {
  const workflow = normalizeWorkflow({
    name: "Feed loop",
    deviceId: "black-arm-01",
    steps: [
      {
        type: "swipe",
        start: { x: 0.5, y: 0.8 },
        end: { x: 0.5, y: 0.2 },
        durationMs: 420,
      },
      { type: "tap", point: { x: 0.88, y: 0.62 }, chance: 0.2 },
    ],
    loop: { infinite: true, delayMs: 750 },
  });
  assert.equal(workflow.version, 2);
  assert.equal(workflow.steps.length, 2);
  assert.equal(workflow.steps[1].chance, 0.2);
  assert.equal(workflow.steps[1].pressure, "natural");
  assert.equal(workflow.steps[1].durationMs, 40);
  assert.equal(workflow.loop.delayMs, 750);
});

test("materializes normalized coordinates against a fresh frame", () => {
  const action = materializeAction(
    {
      type: "swipe",
      start: { x: 0.5, y: 0.8 },
      end: { x: 0.5, y: 0.2 },
      durationMs: 400,
    },
    { width: 720, height: 1560, sequence: 123 },
  );
  assert.deepEqual(action.viewport, { width: 720, height: 1560 });
  assert.deepEqual(action.start, { x: 360, y: 1248 });
  assert.deepEqual(action.end, { x: 360, y: 312 });
  assert.equal(action.frameSequence, 123);
});

test("fits a tall phone frame inside the visible stage without cropping or stretching", () => {
  const fitted = containDimensions(720, 1560, 1276, 1062);
  assert.deepEqual(fitted, { width: 490, height: 1062 });
  assert.ok(Math.abs(fitted.width / fitted.height - 720 / 1560) < 0.001);
});

test("materializes pressure per device inside its verified Z range", () => {
  const action = materializeAction(
    {
      type: "tap",
      point: { x: 0.5, y: 0.5 },
      pressure: "firm",
    },
    { width: 720, height: 1560, sequence: 123 },
    { touchZ: 10, minimumTouchZ: 9.5, maximumTouchZ: 10 },
  );
  assert.equal(action.touchZ, 10);
});

test("normalizes and materializes a timed physical hover path", () => {
  const step = normalizeStep({
    type: "hover_path",
    delayBeforeMs: 75,
    points: [
      { x: 0.2, y: 0.8, atMs: 0 },
      { x: 0.5, y: 0.5, atMs: 120 },
      { x: 0.8, y: 0.2, atMs: 260 },
    ],
  });
  assert.equal(step.durationMs, 260);
  assert.equal(step.points.length, 3);
  assert.match(describeStep(step), /Hover path · 3 points · 260 ms/);

  const action = materializeAction(step, { width: 720, height: 1280, sequence: 456 });
  assert.equal(action.type, "hover_path");
  assert.deepEqual(action.points[1], { x: 360, y: 640, atMs: 120 });
  assert.equal(action.frameSequence, 456);
});

test("rejects malformed or unbounded hover trajectories", () => {
  assert.throws(
    () => normalizeStep({
      type: "hover_path",
      points: [
        { x: 0.5, y: 0.5, atMs: 0 },
        { x: 0.6, y: 0.6, atMs: 90 },
        { x: 0.7, y: 0.7, atMs: 80 },
      ],
    }),
    /times must be in order/,
  );
  assert.throws(
    () => normalizeStep({ type: "hover_path", points: [] }),
    /must contain between/,
  );
});

test("resamples sparse hover recordings into a smooth fixed-rate path", () => {
  const points = interpolateHoverPath([
    { x: 0.1, y: 0.2, atMs: 0 },
    { x: 0.7, y: 0.8, atMs: 120 },
    { x: 0.9, y: 0.4, atMs: 240 },
  ], 50);
  assert.deepEqual(points.map((point) => point.atMs), [0, 50, 100, 150, 200, 240]);
  assert.ok(Math.abs(points[1].x - 0.35) < 0.000_001);
  assert.deepEqual(points.at(-1), { x: 0.9, y: 0.4, atMs: 240 });
});

test("recorder runner keeps workflows and leases isolated by device", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /leaseStorageKey\(deviceId\)/);
  assert.match(source, /workflowStorageKey\(workflow\.deviceId\)/);
  assert.match(source, /latestRunnableDevice\(deviceId, actionType\)/);
  assert.match(source, /deviceId: runDeviceId/);
  assert.match(source, /runners: new Map\(\)/);
  assert.match(source, /state\.runners\.set\(runDeviceId, runner\)/);
  assert.match(source, /state\.runners\.delete\(runDeviceId\)/);
  assert.doesNotMatch(source, /deviceSelect\.disabled = state\.running/);
});

test("action recorder previews and safely throttles physical hover tracking", async () => {
  const { readFile } = await import("node:fs/promises");
  const [source, html, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="mouseTracker"/);
  assert.match(html, /id="recordMouseTrajectory"[^>]*checked/);
  assert.match(html, /Off restores touch-only recording/);
  assert.match(source, /function showMouseTracker/);
  assert.match(source, /pointerType === "mouse"/);
  assert.match(source, /type: "hover_move"/);
  assert.match(source, /HOVER_MOVE_INTERVAL_MS = 50/);
  assert.match(source, /window\.addEventListener\("pointermove", globalMouseMove/);
  assert.match(source, /recordHoverPoint\(point, recordedAt\);/);
  assert.match(source, /type: "hover_path"/);
  assert.match(source, /executeHoverPath\(step/);
  assert.match(source, /latestRunnableDevice\(deviceId, "hover_move"\)/);
  assert.match(source, /interpolateHoverPath\(step\.points, HOVER_MOVE_INTERVAL_MS\)/);
  assert.match(source, /finalSubmission = await queueAction/);
  assert.match(source, /finishHoverPoint\(deviceId, replayPoints\.at\(-1\), finalSubmission, runner\)/);
  assert.match(source, /isTransientHoverBusyError/);
  assert.match(source, /Coalesced .* transient busy points without stopping the loop/);
  const refreshSource = source.slice(
    source.indexOf("async function latestHoverReplayDevice"),
    source.indexOf("function isTransientHoverBusyError"),
  );
  assert.doesNotMatch(refreshSource, /capabilities/);
  assert.match(source, /executeWhileRecording\.checked/);
  const scheduleSource = source.slice(
    source.indexOf("function scheduleHover"),
    source.indexOf("function newStepId"),
  );
  assert.match(
    scheduleSource,
    /!elements\.recordMouseTrajectory\.checked && !elements\.executeWhileRecording\.checked/,
  );
  const dispatchSource = source.slice(
    source.indexOf("async function dispatchPendingHover"),
    source.indexOf("function scheduleHover"),
  );
  assert.ok(
    dispatchSource.indexOf("recordHoverPoint(point, recordedAt)") <
      dispatchSource.indexOf("executeWhileRecording.checked"),
    "dry recording must capture the path before live hardware execution is gated",
  );
  const recordPathSource = source.slice(
    source.indexOf("function recordHoverPoint"),
    source.indexOf("async function dispatchPendingHover"),
  );
  assert.match(recordPathSource, /!elements\.recordMouseTrajectory\.checked/);
  assert.match(source, /RECORDER_PREFERENCES_KEY/);
  assert.match(source, /loadRecorderPreferences\(\);/);
  assert.match(source, /phoneStage\.addEventListener\("pointerleave"/);
  assert.match(styles, /\.mouse-tracker/);
  assert.match(styles, /pointer-events: none/);
  assert.match(styles, /height: calc\(100dvh - 64px\)/);
  assert.match(styles, /\.phone-stage canvas \{[^}]*max-height: calc\(100dvh - 176px\)/s);
  assert.doesNotMatch(styles, /\.phone-stage canvas \{[^}]*100vh - 160px/s);
  assert.match(source, /function fitPhoneCanvas\(\)/);
  assert.match(source, /containDimensions\(sourceWidth, sourceHeight, availableWidth, availableHeight\)/);
  assert.match(source, /new ResizeObserver\(fitPhoneCanvas\)\.observe\(elements\.phoneStage\)/);
});

test("rejects unsafe workflow coordinates", () => {
  assert.throws(
    () => normalizeWorkflow({ steps: [{ type: "tap", point: { x: 1.1, y: 0.5 } }] }),
    /point\.x/,
  );
});

test("supports deterministic chance steps", () => {
  const step = { type: "tap", point: { x: 0.5, y: 0.5 }, chance: 0.2 };
  assert.equal(shouldRunStep(step, () => 0.19), true);
  assert.equal(shouldRunStep(step, () => 0.2), false);
});

test("the local proxy exposes only the required semantic API", () => {
  assert.equal(allowedProxyRoute("GET", "/api/v1/devices"), true);
  assert.equal(allowedProxyRoute("GET", "/api/v1/devices/black-arm-01"), true);
  assert.equal(allowedProxyRoute("POST", "/api/v1/devices/black-arm-01/actions"), true);
  assert.equal(allowedProxyRoute("GET", "/api/v1/devices/black-arm-01/actions/receipt-1"), true);
  assert.equal(allowedProxyRoute("POST", "/api/nodes/black-arm-01/commands"), false);
  assert.equal(allowedProxyRoute("POST", "/api/frame/jpeg"), false);
  assert.equal(allowedProxyRoute("POST", "/api/home-machine"), false);
});

test("serves the recorder and rejects hardware-driver proxy routes", async (context) => {
  const server = createRecorderServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ScreenHand Action Recorder/);

  const blocked = await fetch(`${origin}/screenhand/api/home-machine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(blocked.status, 404);
  assert.deepEqual(await blocked.json(), {
    ok: false,
    error: "Recorder proxy route not found.",
  });
});
