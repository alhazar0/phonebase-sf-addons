import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenQuad } from "../vision-screen";
import { evaluateVisualServoCorrection } from "./visual-servo-controller";

const phone: ScreenQuad = [
  { x: 70, y: 12 },
  { x: 625, y: 12 },
  { x: 641, y: 1_211 },
  { x: 87, y: 1_211 },
];
const machine: ScreenQuad = [
  { x: 78, y: 156 },
  { x: 9, y: 158 },
  { x: 7, y: 6 },
  { x: 80, y: 5 },
];
const bounds = { minimumX: 5, maximumX: 82, minimumY: 1, maximumY: 170 };

test("proposes a bounded shadow correction from camera tip residual", () => {
  const correction = evaluateVisualServoCorrection({
    phonePoints: phone,
    controlMachinePoints: machine,
    targetCameraPoint: { x: 360, y: 600 },
    observedTipCameraPoint: { x: 350, y: 610 },
    currentMachinePoint: { x: 44, y: 82 },
    safeMachineBounds: bounds,
    phoneConfidence: 0.97,
    tipConfidence: 0.92,
    frameAgeMs: 24,
    occluded: false,
  });
  assert.equal(correction.status, "correct");
  assert.equal(correction.wouldMoveHardware, false);
  assert.ok((correction.residualMm ?? 0) > 1);
  assert.ok(Math.hypot(
    correction.correctionDelta?.x ?? 0,
    correction.correctionDelta?.y ?? 0,
  ) <= 0.801);
});

test("settles inside the deadband and holds on stale or uncertain evidence", () => {
  const common = {
    phonePoints: phone,
    controlMachinePoints: machine,
    targetCameraPoint: { x: 360, y: 600 },
    currentMachinePoint: { x: 44, y: 82 },
    safeMachineBounds: bounds,
    phoneConfidence: 0.97,
    tipConfidence: 0.92,
    frameAgeMs: 24,
    occluded: false,
  };
  assert.equal(evaluateVisualServoCorrection({
    ...common,
    observedTipCameraPoint: { x: 360.2, y: 599.8 },
  }).status, "settled");
  assert.equal(evaluateVisualServoCorrection({
    ...common,
    observedTipCameraPoint: { x: 350, y: 610 },
    frameAgeMs: 500,
  }).reason, "frame-stale");
  assert.equal(evaluateVisualServoCorrection({
    ...common,
    observedTipCameraPoint: { x: 350, y: 610 },
    tipConfidence: 0.2,
  }).reason, "tip-confidence-low");
});
