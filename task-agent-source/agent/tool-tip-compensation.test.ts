import assert from "node:assert/strict";
import test from "node:test";

import { compensatePhysicalTip } from "./tool-tip-compensation";

test("corrects only the measured top-corner tool-tip offset", () => {
  const viewport = { width: 720, height: 1_560 };
  assert.ok(Math.abs(compensatePhysicalTip({ x: 49, y: 155 }, viewport).x - 18.76) < 0.001);
  assert.ok(Math.abs(compensatePhysicalTip({ x: 660, y: 135 }, viewport).x - 690.24) < 0.001);
  assert.deepEqual(compensatePhysicalTip({ x: 100, y: 175 }, viewport), { x: 100, y: 175 });
  assert.deepEqual(compensatePhysicalTip({ x: 49, y: 500 }, viewport), { x: 49, y: 500 });
});
