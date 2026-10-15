import assert from "node:assert/strict";
import test from "node:test";
import {
  inferIntentSwipe,
  mapCameraPointToScreen,
  mapContainedClientPoint,
} from "../app/pointer-geometry";

function closeTo(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test("maps an exact-aspect canvas into the full rectified phone viewport", () => {
  const point = mapContainedClientPoint(
    { x: 180, y: 390 },
    { left: 0, top: 0, width: 360, height: 780 },
    { width: 720, height: 1560 },
  );

  assert.ok(point);
  closeTo(point.x, 360);
  closeTo(point.y, 780);
});

test("ignores pillarbox bands and maps only the visible phone image", () => {
  const bounds = { left: 100, top: 20, width: 360, height: 600 };
  const viewport = { width: 720, height: 1560 };

  assert.equal(
    mapContainedClientPoint({ x: 110, y: 320 }, bounds, viewport),
    null,
  );

  const center = mapContainedClientPoint({ x: 280, y: 320 }, bounds, viewport);
  assert.ok(center);
  closeTo(center.x, 360);
  closeTo(center.y, 780);
});

test("ignores letterbox bands and preserves screen corners", () => {
  const bounds = { left: 10, top: 20, width: 360, height: 900 };
  const viewport = { width: 720, height: 1560 };
  const displayedTop = 20 + (900 - 780) / 2;

  assert.equal(
    mapContainedClientPoint({ x: 190, y: 30 }, bounds, viewport),
    null,
  );

  assert.deepEqual(
    mapContainedClientPoint({ x: 10, y: displayedTop }, bounds, viewport),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    mapContainedClientPoint({ x: 370, y: displayedTop + 780 }, bounds, viewport),
    { x: 720, y: 1560 },
  );
});

test("fails closed for invalid geometry", () => {
  assert.equal(
    mapContainedClientPoint(
      { x: 10, y: 10 },
      { left: 0, top: 0, width: 0, height: 100 },
      { width: 720, height: 1560 },
    ),
    null,
  );
});

test("maps complete raw-camera screen corners into the control viewport", () => {
  const imagePoints = [
    { x: 198, y: 128 },
    { x: 534, y: 124 },
    { x: 517, y: 1149 },
    { x: 189, y: 1134 },
  ] as const;
  const screen = { width: 720, height: 1560 };

  assert.deepEqual(
    mapCameraPointToScreen(imagePoints[0], [...imagePoints], screen),
    { x: 0, y: 0 },
  );
  const bottomRight = mapCameraPointToScreen(
    imagePoints[2],
    [...imagePoints],
    screen,
  );
  assert.ok(bottomRight);
  closeTo(bottomRight.x, 720);
  closeTo(bottomRight.y, 1560);
});

test("ignores fixture clicks outside the calibrated phone screen", () => {
  const imagePoints = [
    { x: 198, y: 128 },
    { x: 534, y: 124 },
    { x: 517, y: 1149 },
    { x: 189, y: 1134 },
  ] as const;

  assert.equal(
    mapCameraPointToScreen(
      { x: 40, y: 600 },
      [...imagePoints],
      { width: 720, height: 1560 },
    ),
    null,
  );
});

test("expands a short upward mouse flick into a complete vertical swipe", () => {
  assert.deepEqual(
    inferIntentSwipe(
      { x: 350, y: 800 },
      { x: 354, y: 782 },
      { width: 720, height: 1_560 },
    ),
    {
      direction: "up",
      start: { x: 352, y: 1_185.6 },
      end: { x: 352, y: 436.8 },
      durationMs: 320,
    },
  );
});

test("expands a short horizontal mouse flick and keeps it off system edges", () => {
  assert.deepEqual(
    inferIntentSwipe(
      { x: 500, y: 500 },
      { x: 482, y: 504 },
      { width: 720, height: 1_560 },
    ),
    {
      direction: "left",
      start: { x: 561.6, y: 502 },
      end: { x: 158.4, y: 502 },
      durationMs: 320,
    },
  );
});

test("keeps click jitter as a tap instead of inferring a swipe", () => {
  assert.equal(
    inferIntentSwipe(
      { x: 350, y: 800 },
      { x: 356, y: 807 },
      { width: 720, height: 1_560 },
    ),
    null,
  );
});
