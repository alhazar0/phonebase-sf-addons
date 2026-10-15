import assert from "node:assert/strict";
import test from "node:test";
import {
  invertHomography,
  referencePointsInCurrentFrame,
  transformPoint,
  type Matrix3x3,
} from "./vision-register";

test("inverts a projective camera transform", () => {
  const matrix: Matrix3x3 = [
    1.1, 0.02, 12,
    -0.01, 0.96, -8,
    0.0001, -0.0002, 1,
  ];
  const point = { x: 320, y: 640 };
  const transformed = transformPoint(matrix, point);
  const recovered = transformPoint(invertHomography(matrix), transformed);
  assert.ok(Math.abs(recovered.x - point.x) < 1e-6);
  assert.ok(Math.abs(recovered.y - point.y) < 1e-6);
});

test("maps saved reference corners into the current camera frame", () => {
  const referenceToCurrentVision: Matrix3x3 = [
    1, 0, 14,
    0, 1, -9,
    0, 0, 1,
  ];
  const corners = referencePointsInCurrentFrame(referenceToCurrentVision, [
    { x: 100, y: 80 },
    { x: 600, y: 80 },
    { x: 600, y: 1200 },
    { x: 100, y: 1200 },
  ], 1280);
  assert.deepEqual(corners, [
    { x: 114, y: 89 },
    { x: 614, y: 89 },
    { x: 614, y: 1209 },
    { x: 114, y: 1209 },
  ]);
});
