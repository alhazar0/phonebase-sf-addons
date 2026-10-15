import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRealtimeRunApiRequest,
  RealtimeRunApiValidationError,
  selectRuntimeEngine,
  summarizeRealtimeUpstream,
} from "./server-contract";

test("parses a bounded persistent realtime run request", () => {
  assert.deepEqual(parseRealtimeRunApiRequest({ goal: "打开 TikTok" }), {
    goal: "打开 TikTok",
    deviceId: "black-arm-01",
    mode: "dry_run",
    accessMode: "full_access",
    timeoutMs: 300_000,
  });
  assert.equal(parseRealtimeRunApiRequest({
    goal: "返回首页",
    mode: "execute",
    accessMode: "read_only",
    timeoutMs: 30_000,
  }).accessMode, "read_only");
});

test("routes every app and unseen task through the same universal Task IR runtime", () => {
  assert.equal(selectRuntimeEngine("打开 TikTok 搜索 alhazar"), "universal_task_ir");
  assert.equal(
    selectRuntimeEngine("打开 Instagram 搜索 Nonna Sofia，读取最新视频播放量"),
    "universal_task_ir",
  );
  assert.equal(selectRuntimeEngine("打开 Telegram"), "universal_task_ir");
  assert.equal(selectRuntimeEngine("在一个从未见过的应用里完成设置"), "universal_task_ir");
  assert.equal(selectRuntimeEngine("返回首页"), "universal_task_ir");
});

test("rejects unbounded or ambiguous realtime requests", () => {
  assert.throws(
    () => parseRealtimeRunApiRequest({ goal: "x", execute: true }),
    RealtimeRunApiValidationError,
  );
  assert.throws(
    () => parseRealtimeRunApiRequest({ goal: "x", timeoutMs: 1 }),
    RealtimeRunApiValidationError,
  );
  assert.throws(
    () => parseRealtimeRunApiRequest({ goal: "x", accessMode: "unsafe" }),
    RealtimeRunApiValidationError,
  );
});

test("reports the physical bridge ready only with camera, homing, and touch", () => {
  const ready = summarizeRealtimeUpstream("black-arm-01", {
    id: "black-arm-01",
    connected: true,
    status: "running",
    screen: {
      width: 720,
      height: 1_560,
      rawWidth: 720,
      rawHeight: 1_280,
      rectified: true,
      imagePoints: [
        { x: 70, y: 12 },
        { x: 625, y: 12 },
        { x: 640, y: 1_211 },
        { x: 88, y: 1_211 },
      ],
      calibrationId: "fixture",
    },
    state: { grbl: { connected: true, homed: true } },
    capabilities: {
      observation: { screenshot: { available: true } },
      actions: { tap: { available: true } },
    },
  });
  assert.equal(ready.readyForPreview, true);
  assert.equal(ready.readyForExecute, true);
  assert.equal(ready.blockReason, null);

  const locked = summarizeRealtimeUpstream("black-arm-01", {
    id: "black-arm-01",
    connected: true,
    status: "running",
    screen: null,
    state: { grbl: { connected: true, homed: false } },
    capabilities: {
      observation: { screenshot: { available: false, reason: "No frame" } },
      actions: { tap: { available: false, reason: "Home required" } },
    },
  });
  assert.equal(locked.readyForPreview, false);
  assert.equal(locked.readyForExecute, false);
  assert.match(locked.blockReason ?? "", /homed/);
});
