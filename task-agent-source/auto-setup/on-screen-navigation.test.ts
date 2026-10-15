import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { detectOnScreenNavigation } from "./on-screen-navigation";

const viewport = { width: 720, height: 1560 };

async function fixture(kind: "gesture" | "three-button" | "app-nav" | "flat") {
  const navigation = kind === "gesture"
    ? '<rect x="270" y="1520" width="180" height="12" rx="6" fill="#f7f8fa"/>'
    : kind === "three-button"
      ? `
        <path d="M180 1510 L166 1534 L194 1534 Z" fill="none" stroke="#f7f8fa" stroke-width="6"/>
        <circle cx="360" cy="1522" r="13" fill="none" stroke="#f7f8fa" stroke-width="6"/>
        <rect x="527" y="1509" width="27" height="27" fill="none" stroke="#f7f8fa" stroke-width="6"/>
      `
      : kind === "app-nav"
        ? [120, 240, 360, 480, 600].map((x) =>
            `<circle cx="${x}" cy="1410" r="18" fill="#f7f8fa"/>`
          ).join("")
        : "";
  return sharp({
    create: {
      width: viewport.width,
      height: viewport.height,
      channels: 3,
      background: { r: 27, g: 31, b: 38 },
    },
  }).composite([{
    input: Buffer.from(`
      <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
        <rect width="720" height="1560" fill="#1d222a"/>
        ${navigation}
      </svg>
    `),
  }]).jpeg({ quality: 90 }).toBuffer();
}

test("recognizes a bottom gesture handle without enabling Home", async () => {
  const result = await detectOnScreenNavigation({
    imageBytes: await fixture("gesture"),
    viewport,
  });
  assert.equal(result.status, "detected", JSON.stringify(result));
  assert.equal(result.strategy, "gesture_handle");
  assert.equal(result.homePoint, null);
  assert.equal(result.actionReady, false);
});

test("recognizes three-button navigation and locates the center Home control", async () => {
  const result = await detectOnScreenNavigation({
    imageBytes: await fixture("three-button"),
    viewport,
  });
  assert.equal(result.status, "detected", JSON.stringify(result));
  assert.equal(result.strategy, "three_button");
  assert.ok(Math.abs((result.homePoint?.x ?? 0) - 360) < 15);
  assert.ok((result.homePoint?.y ?? 0) > 1480);
  assert.equal(result.actionReady, false);
});

test("does not confuse app navigation or a flat footer with system navigation", async () => {
  for (const kind of ["app-nav", "flat"] as const) {
    const result = await detectOnScreenNavigation({
      imageBytes: await fixture(kind),
      viewport,
    });
    assert.equal(result.status, "not_detected", `${kind}: ${JSON.stringify(result)}`);
    assert.equal(result.strategy, "unknown");
  }
});
