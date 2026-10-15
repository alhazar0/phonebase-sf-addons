import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { detectBackControl } from "./back-control-vision";

const screen = { width: 720, height: 1560 };

async function fixture(withChevron: boolean) {
  const svg = Buffer.from(`
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1560" fill="#eeeeee"/>
      <text x="300" y="135" font-size="32" fill="#222">Contacts</text>
      ${withChevron
        ? '<path d="M 78 105 L 58 130 L 78 155" fill="none" stroke="#111" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
        : ""}
    </svg>
  `);
  return sharp(svg).jpeg().toBuffer();
}

test("finds an unambiguous top-left Back chevron", async () => {
  const point = await detectBackControl(await fixture(true), screen);
  assert.ok(point);
  assert.ok(Math.abs(point.x - 68) < 8);
  assert.ok(Math.abs(point.y - 130) < 8);
});

test("does not invent a Back control on a blank navigation bar", async () => {
  assert.equal(await detectBackControl(await fixture(false), screen), null);
});
