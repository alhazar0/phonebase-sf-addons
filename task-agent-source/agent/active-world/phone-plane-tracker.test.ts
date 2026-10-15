import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenQuad, VisionScreenCandidate } from "../vision-screen";
import { PhonePlaneTracker } from "./phone-plane-tracker";

const reference: ScreenQuad = [
  { x: 70, y: 12 },
  { x: 625, y: 12 },
  { x: 641, y: 1_211 },
  { x: 87, y: 1_211 },
];

test("tracks and projects the canonical screen through the live phone plane", async () => {
  const tracker = trackerWith([
    candidate(reference),
    candidate(translate(reference, 2, -1)),
  ]);
  const first = await tracker.update(frame(1));
  const second = await tracker.update(frame(2));
  assert.equal(first.status, "tracking");
  assert.equal(second.status, "tracking");
  assert.equal(second.safeForCorrection, true);
  const center = tracker.projectScreenPoint({ x: 360, y: 780 });
  assert.ok(center.x > 350 && center.x < 365);
  assert.ok(center.y > 600 && center.y < 620);
});

test("requires two consistent frames before accepting a displaced phone", async () => {
  const moved = translate(reference, 30, 8);
  const tracker = trackerWith([
    candidate(reference),
    candidate(moved),
    candidate(translate(moved, 0.5, -0.5)),
  ], { maximumInterframeJumpRatio: 0.01 });
  assert.equal((await tracker.update(frame(1))).status, "tracking");
  const unconfirmed = await tracker.update(frame(2));
  assert.equal(unconfirmed.status, "unsafe");
  assert.equal(unconfirmed.reason, "relocation-unconfirmed");
  const confirmed = await tracker.update(frame(3));
  assert.equal(confirmed.status, "tracking");
  assert.equal(confirmed.reason, "relocated-confirmed");
  assert.equal(confirmed.relocated, true);
});

test("coasts through short occlusion and then fails closed", async () => {
  const tracker = trackerWith([candidate(reference), null, null], {
    maximumCoastingFrames: 1,
  });
  await tracker.update(frame(1));
  const coast = await tracker.update(frame(2));
  assert.equal(coast.status, "coasting");
  assert.equal(coast.safeForFeedForward, true);
  assert.equal(coast.safeForCorrection, false);
  const lost = await tracker.update(frame(3));
  assert.equal(lost.status, "unsafe");
  assert.equal(lost.reason, "screen-not-found");
});

function trackerWith(
  detections: Array<VisionScreenCandidate | null>,
  overrides: Partial<ConstructorParameters<typeof PhonePlaneTracker>[0]> = {},
) {
  let index = 0;
  return new PhonePlaneTracker({
    frame: { width: 720, height: 1_280 },
    screen: { width: 720, height: 1_560 },
    referencePoints: reference,
    detector: async () => detections[index++] ?? null,
    ...overrides,
  });
}

function frame(sequence: number) {
  return {
    bytes: Buffer.from(`frame-${sequence}`),
    width: 720,
    height: 1_280,
    sequence,
    capturedAt: sequence * 10,
  };
}

function candidate(points: ScreenQuad): VisionScreenCandidate {
  return {
    confidence: 0.98,
    topLeft: points[0],
    topRight: points[1],
    bottomRight: points[2],
    bottomLeft: points[3],
    areaRatio: 0.72,
  };
}

function translate(points: ScreenQuad, x: number, y: number): ScreenQuad {
  return points.map((point) => ({ x: point.x + x, y: point.y + y })) as ScreenQuad;
}
