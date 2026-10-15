import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { detectVisualAffordances } from "./visual-affordance-detector";

const viewport = { width: 720, height: 1_560 };

test("detects unlabeled icons and a wide control by their local visual bounds", async () => {
  const result = await detectVisualAffordances(await fixture(), { viewport });
  assert.ok(candidateHits(result.candidates, { left: 610, top: 70, width: 70, height: 70 }));
  assert.ok(candidateHits(result.candidates, { left: 45, top: 1_380, width: 76, height: 76 }));
  assert.ok(candidateHits(result.candidates, { left: 170, top: 1_120, width: 380, height: 92 }));
  assert.ok(result.candidates.some((candidate) => candidate.role === "control"));
  assert.ok(result.elapsedMs < 300);
});

test("does not invent an affordance on a flat camera frame", async () => {
  const bytes = await sharp({
    create: {
      width: viewport.width,
      height: viewport.height,
      channels: 3,
      background: { r: 120, g: 120, b: 120 },
    },
  }).jpeg().toBuffer();
  const result = await detectVisualAffordances(bytes, { viewport });
  assert.deepEqual(result.candidates, []);
});

test("suppresses a compact component already explained by OCR", async () => {
  const result = await detectVisualAffordances(await fixture(), {
    viewport,
    excludeBounds: [{ left: 600, top: 55, width: 95, height: 100 }],
  });
  assert.equal(
    candidateHits(result.candidates, { left: 610, top: 70, width: 70, height: 70 }),
    false,
  );
  assert.ok(candidateHits(result.candidates, { left: 170, top: 1_120, width: 380, height: 92 }));
});

test("excludes non-interactive status-bar glyphs from spatial grounding", async () => {
  const svg = `
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1560" fill="#f2f4f7"/>
      <circle cx="645" cy="42" r="24" fill="#17202a"/>
      <circle cx="645" cy="130" r="34" fill="#17202a"/>
    </svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  const result = await detectVisualAffordances(bytes, { viewport });
  assert.equal(candidateHits(result.candidates, { left: 615, top: 12, width: 60, height: 60 }), false);
  assert.ok(candidateHits(result.candidates, { left: 605, top: 90, width: 80, height: 80 }));
});

test("classifies back, close, add, and search symbols without OCR or an app list", async () => {
  for (const dark of [false, true]) {
    const result = await detectVisualAffordances(await symbolFixture(dark), { viewport });
    const symbols = new Map(result.candidates.map((candidate) => [candidate.symbol, candidate]));
    assert.ok((symbols.get("back")?.symbolConfidence ?? 0) >= 0.78);
    assert.ok((symbols.get("close")?.symbolConfidence ?? 0) >= 0.78);
    assert.ok((symbols.get("add")?.symbolConfidence ?? 0) >= 0.78);
    assert.ok((symbols.get("search")?.symbolConfidence ?? 0) >= 0.78);
  }
});

test("does not assign symbol semantics to ordinary compact shapes", async () => {
  const svg = `
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1560" fill="#f2f4f7"/>
      <circle cx="645" cy="130" r="34" fill="none" stroke="#17202a" stroke-width="7"/>
      <rect x="326" y="96" width="68" height="68" rx="18" fill="#17202a"/>
      <path d="M55 105 L80 130 L55 155" fill="none" stroke="#17202a" stroke-width="7"/>
      <circle cx="520" cy="125" r="27" fill="none" stroke="#17202a" stroke-width="7"/>
    </svg>`;
  const result = await detectVisualAffordances(
    await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer(),
    { viewport },
  );
  assert.equal(result.candidates.some((candidate) => candidate.symbol), false);
});

test("recovers a low-contrast compressed Back chevron inside a navigation circle", async () => {
  const svg = `
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1560" fill="#babdb8"/>
      <circle cx="70" cy="130" r="38" fill="#ced0cb"/>
      <path d="M78 108 L60 130 L78 152" fill="none" stroke="#282b29" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="310" y="140" font-size="38" fill="#2c2f2d">General</text>
    </svg>`;
  const degraded = await sharp(Buffer.from(svg))
    .resize({ width: 360, height: 780, fit: "fill" })
    .blur(0.7)
    .resize({ width: 720, height: 1_560, fit: "fill" })
    .jpeg({ quality: 46 })
    .toBuffer();
  const result = await detectVisualAffordances(degraded, {
    viewport,
    excludeBounds: [{ left: 290, top: 100, width: 160, height: 60 }],
  });
  const back = result.candidates.find((candidate) => candidate.symbol === "back");
  assert.ok(back);
  assert.equal(back.source, "local_intensity");
  assert.ok((back.symbolConfidence ?? 0) >= 0.9);
  assert.ok(Math.abs(back.center.x - 70) <= 8);
  assert.ok(Math.abs(back.center.y - 130) <= 8);
});

test("isolates a top-right Search symbol from a busy video background", async () => {
  const background = `
    <defs>
      <linearGradient id="video" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#111827"/>
        <stop offset="0.45" stop-color="#7c2d12"/>
        <stop offset="1" stop-color="#14532d"/>
      </linearGradient>
    </defs>
    <rect width="720" height="1560" fill="url(#video)"/>
    <path d="M540 40 L720 190 M560 190 L710 45" stroke="#806f62" stroke-width="18" opacity="0.55"/>
    <text x="390" y="135" font-size="42" fill="#f8fafc">For You</text>`;
  const withSearch = await sharp(Buffer.from(`
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      ${background}
      <circle cx="662" cy="116" r="24" fill="none" stroke="#f8fafc" stroke-width="7"/>
      <path d="M679 133 L704 158" fill="none" stroke="#f8fafc" stroke-width="7" stroke-linecap="round"/>
    </svg>`)).jpeg({ quality: 54 }).toBuffer();
  const detected = await detectVisualAffordances(withSearch, { viewport });
  const search = detected.candidates.find((candidate) => candidate.symbol === "search");
  assert.ok(search);
  assert.ok(Math.abs(search.center.x - 670) <= 18);
  assert.ok(Math.abs(search.center.y - 124) <= 18);

  const withoutSearch = await sharp(Buffer.from(`
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      ${background}
    </svg>`)).jpeg({ quality: 54 }).toBuffer();
  const negative = await detectVisualAffordances(withoutSearch, { viewport });
  assert.equal(negative.candidates.some((candidate) => candidate.symbol === "search"), false);
});

async function fixture() {
  const svg = `
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1560" fill="#f2f4f7"/>
      <circle cx="645" cy="105" r="35" fill="#17202a"/>
      <path d="M632 105 L658 105 M645 92 L645 118" stroke="#f2f4f7" stroke-width="7"/>
      <rect x="170" y="1120" width="380" height="92" rx="42" fill="#246bfd"/>
      <rect x="45" y="1380" width="76" height="76" rx="18" fill="#17202a"/>
      <circle cx="83" cy="1418" r="13" fill="#f2f4f7"/>
    </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

function symbolFixture(dark: boolean) {
  const background = dark ? "#101318" : "#eeeeee";
  const foreground = dark ? "#f5f7fa" : "#111111";
  const svg = `
    <svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1560" fill="${background}"/>
      <path d="M78 105 L58 130 L78 155" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M620 105 L670 155 M670 105 L620 155" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round"/>
      <path d="M335 105 L385 105 M360 80 L360 130" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round"/>
      <circle cx="510" cy="115" r="22" fill="none" stroke="${foreground}" stroke-width="7"/>
      <path d="M526 131 L552 157" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round"/>
    </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
}

function candidateHits(
  candidates: Array<{ center: { x: number; y: number } }>,
  target: { left: number; top: number; width: number; height: number },
) {
  return candidates.some((candidate) =>
    candidate.center.x >= target.left &&
    candidate.center.x <= target.left + target.width &&
    candidate.center.y >= target.top &&
    candidate.center.y <= target.top + target.height
  );
}
