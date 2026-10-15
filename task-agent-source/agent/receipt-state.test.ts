import assert from "node:assert/strict";
import test from "node:test";
import {
  compactHoverReceiptOperation,
  commandResultReceiptDecision,
  operationReceiptDecision,
  receiptIdsToPrune,
} from "./receipt-state";

test("keeps physical touches executing after node acceptance", () => {
  assert.deepEqual(
    commandResultReceiptDecision({
      id: "touch-1",
      action: "tap",
      ok: true,
    }),
    {
      id: "touch-1",
      status: "executing",
      error: null,
      result: { id: "touch-1", action: "tap", ok: true },
    },
  );
});

test("keeps a physical text sequence executing after node acceptance", () => {
  assert.equal(
    commandResultReceiptDecision({
      id: "text-1",
      action: "input_text",
      ok: true,
    })?.status,
    "executing",
  );
});

test("finishes non-motion safety commands on command result", () => {
  assert.equal(
    commandResultReceiptDecision({
      id: "hold-1",
      action: "hold",
      ok: true,
    })?.status,
    "completed",
  );
});

test("keeps machine homing executing until the driver reports completion", () => {
  assert.equal(
    commandResultReceiptDecision({
      id: "home-1",
      action: "home",
      ok: true,
    })?.status,
    "executing",
  );
});

test("keeps a calibrated system-edge gesture executing until it is parked", () => {
  assert.equal(
    commandResultReceiptDecision({
      id: "system-home-1",
      action: "system_edge_swipe",
      ok: true,
    })?.status,
    "executing",
  );
  assert.equal(
    commandResultReceiptDecision({
      id: "keyboard-edge-1",
      action: "system_edge_tap",
      ok: true,
    })?.status,
    "executing",
  );
});

test("preserves hardware rejection and operation failure reasons", () => {
  assert.deepEqual(
    commandResultReceiptDecision({
      id: "tap-rejected",
      action: "tap",
      ok: false,
      error: "Z is not at hover height",
    })?.status,
    "failed",
  );
  assert.equal(
    operationReceiptDecision({
      id: "swipe-failed",
      status: "failed",
      error: "GRBL entered Hold",
    })?.error,
    "GRBL entered Hold",
  );
});

test("only a final operation snapshot completes a touch", () => {
  assert.equal(
    operationReceiptDecision({ id: "swipe-1", status: "running" })?.status,
    "executing",
  );
  assert.equal(
    operationReceiptDecision({ id: "swipe-1", status: "completed" })?.status,
    "completed",
  );
  assert.equal(operationReceiptDecision({ status: "completed" }), null);
});

test("keeps receipt retention fair per device and never evicts active work", () => {
  const receipts = [
    { id: "a-active", deviceId: "arm-a", status: "executing" as const },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `a-${index}`,
      deviceId: "arm-a",
      status: "completed" as const,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `b-${index}`,
      deviceId: "arm-b",
      status: "completed" as const,
    })),
  ];
  const pruned = receiptIdsToPrune(receipts, 3, 6);
  assert.equal(pruned.includes("a-active"), false);
  assert.deepEqual(pruned.slice(0, 3), ["a-0", "a-1", "a-2"]);
  assert.equal(receipts.length - pruned.length <= 6, true);
});

test("compacts hover results without retaining the full hardware state", () => {
  assert.deepEqual(
    compactHoverReceiptOperation({
      id: "hover-1",
      action: "hover_move",
      ok: true,
      result: {
        ok: true,
        state: "Idle",
        position: { x: 12, y: 34, z: 1 },
        recovery: { large: "value" },
      },
      state: { grbl: { recovery: { huge: true } } },
    }),
    {
      ok: true,
      state: "Idle",
      position: { x: 12, y: 34, z: 1 },
    },
  );
});
