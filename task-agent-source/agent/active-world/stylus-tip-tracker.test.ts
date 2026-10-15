import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { StylusTipTracker } from "./stylus-tip-tracker";

test("tracks a shifted stylus feature around its kinematic prediction", async () => {
  const tracker = new StylusTipTracker({
    frame: { width: 240, height: 240 },
    templateSize: 31,
    searchRadiusPx: 16,
  });
  const first = await frame(100, 100, 1, "#5ca8c7");
  const second = await frame(108, 94, 2, "#62abc8");
  await tracker.calibrate(first, { x: 100, y: 100 });
  const track = await tracker.update(second, { x: 100, y: 100 });
  assert.equal(track.status, "tracking", JSON.stringify(track));
  assert.ok(Math.abs((track.point?.x ?? 0) - 108) <= 1);
  assert.ok(Math.abs((track.point?.y ?? 0) - 94) <= 1);
  assert.equal(track.wouldMoveHardware, false);
  assert.ok(track.confidence >= 0.72);
});

test("fails closed when the calibrated stylus appearance disappears", async () => {
  const tracker = new StylusTipTracker({
    frame: { width: 240, height: 240 },
    templateSize: 31,
    searchRadiusPx: 12,
  });
  await tracker.calibrate(await frame(100, 100, 1, "#5ca8c7"), { x: 100, y: 100 });
  const blank = await sharp({
    create: { width: 240, height: 240, channels: 3, background: "#5ca8c7" },
  }).jpeg().toBuffer();
  const track = await tracker.update({
    bytes: blank,
    width: 240,
    height: 240,
    sequence: 2,
    capturedAt: 20,
  }, { x: 100, y: 100 });
  assert.equal(track.status, "unsafe");
  assert.equal(track.reason, "appearance-mismatch");
  assert.equal(track.occluded, true);
});

test("expands the search window only when the fast kinematic window loses the tip", async () => {
  const tracker = new StylusTipTracker({
    frame: { width: 240, height: 240 },
    templateSize: 31,
    fastSearchRadiusPx: 6,
    searchRadiusPx: 18,
  });
  await tracker.calibrate(await frame(100, 100, 1, "#5ca8c7"), { x: 100, y: 100 });
  const track = await tracker.update(
    await frame(114, 100, 2, "#62abc8"),
    { x: 100, y: 100 },
  );
  assert.equal(track.status, "tracking", JSON.stringify(track));
  assert.equal(track.reacquired, true);
  assert.equal(track.searchRadiusPx, 18);
  assert.ok(Math.abs((track.point?.x ?? 0) - 114) <= 1);
});

async function frame(
  x: number,
  y: number,
  sequence: number,
  background: string,
) {
  const bytes = await sharp({
    create: { width: 240, height: 240, channels: 3, background },
  }).composite([{
    input: Buffer.from(`
      <svg width="240" height="240" xmlns="http://www.w3.org/2000/svg">
        <path d="M ${x - 11} ${y + 10} Q ${x} ${y - 13} ${x + 11} ${y + 10}"
          fill="none" stroke="#111" stroke-width="7"/>
        <circle cx="${x}" cy="${y}" r="3" fill="#eee"/>
      </svg>
    `),
  }]).jpeg({ quality: 95 }).toBuffer();
  return {
    bytes,
    width: 240,
    height: 240,
    sequence,
    capturedAt: sequence * 10,
  };
}
