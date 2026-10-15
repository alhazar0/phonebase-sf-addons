import sharp from "sharp";

import type { VisualGroundingFixture } from "./visual-grounding-benchmark";

const viewport = { width: 720, height: 1_560 } as const;

export async function createHeldOutVisualGroundingFixtures(): Promise<VisualGroundingFixture[]> {
  const lightSymbols = await render(symbolMarkup("#eeeeee", "#111111"));
  const darkSymbols = await render(symbolMarkup("#101318", "#f5f7fa"));
  const clean: VisualGroundingFixture[] = [
    {
      id: "light-toolbar-and-primary-control",
      image: await render(`
        <rect width="720" height="1560" fill="#f5f7fa"/>
        <rect x="48" y="72" width="68" height="68" rx="18" fill="#1e293b"/>
        <path d="M92 91 L72 106 L92 121" fill="none" stroke="#f5f7fa" stroke-width="7"/>
        <circle cx="646" cy="106" r="34" fill="#1e293b"/>
        <path d="M632 106 L660 106 M646 92 L646 120" stroke="#f5f7fa" stroke-width="7"/>
        <rect x="154" y="1240" width="412" height="94" rx="46" fill="#2563eb"/>
      `),
      viewport,
      targets: [
        target("toolbar-left", "icon", 48, 72, 68, 68),
        target("toolbar-right", "icon", 612, 72, 68, 68),
        target("primary", "control", 154, 1_240, 412, 94),
      ],
    },
    {
      id: "dark-media-controls",
      image: await render(`
        <rect width="720" height="1560" fill="#090b10"/>
        <circle cx="86" cy="760" r="38" fill="#e5e7eb"/>
        <path d="M76 740 L103 760 L76 780 Z" fill="#090b10"/>
        <rect x="596" y="722" width="82" height="82" rx="24" fill="#e5e7eb"/>
        <circle cx="637" cy="763" r="15" fill="#090b10"/>
        <circle cx="632" cy="1398" r="42" fill="#38bdf8"/>
      `),
      viewport,
      targets: [
        target("media-left", "icon", 48, 722, 76, 76),
        target("media-right", "icon", 596, 722, 82, 82),
        target("floating", "icon", 590, 1_356, 84, 84),
      ],
    },
    {
      id: "neutral-unlabeled-form",
      image: await render(`
        <rect width="720" height="1560" fill="#e8ebef"/>
        <rect x="104" y="390" width="512" height="96" rx="24" fill="#ffffff" stroke="#64748b" stroke-width="5"/>
        <rect x="104" y="570" width="512" height="96" rx="24" fill="#ffffff" stroke="#64748b" stroke-width="5"/>
        <rect x="210" y="1050" width="300" height="88" rx="22" fill="#0f766e"/>
      `),
      viewport,
      targets: [
        target("field-one", "control", 104, 390, 512, 96),
        target("field-two", "control", 104, 570, 512, 96),
        target("form-action", "control", 210, 1_050, 300, 88),
      ],
    },
    {
      id: "semantic-navigation-symbols",
      image: lightSymbols,
      viewport,
      targets: [
        symbolTarget("back-symbol", "back", 38, 88, 60, 84),
        symbolTarget("add-symbol", "add", 320, 65, 80, 80),
        symbolTarget("search-symbol", "search", 470, 75, 100, 100),
        symbolTarget("close-symbol", "close", 605, 90, 80, 80),
      ],
    },
  ];
  return [
    ...clean,
    {
      ...clean[0],
      id: "disturbed-low-light-toolbar",
      image: await degrade(clean[0].image, { brightness: 0.58, quality: 58 }),
    },
    {
      ...clean[1],
      id: "disturbed-compressed-dark-media",
      image: await degrade(clean[1].image, { brightness: 1.2, quality: 42 }),
    },
    {
      ...clean[2],
      id: "disturbed-blurred-form",
      image: await degrade(clean[2].image, { brightness: 0.82, quality: 55, blur: 0.8 }),
    },
    {
      id: "disturbed-dark-navigation-symbols",
      image: await degrade(darkSymbols, { brightness: 0.86, quality: 52 }),
      viewport,
      targets: [
        symbolTarget("back-symbol", "back", 38, 88, 60, 84),
        symbolTarget("add-symbol", "add", 320, 65, 80, 80),
        symbolTarget("search-symbol", "search", 470, 75, 100, 100),
        symbolTarget("close-symbol", "close", 605, 90, 80, 80),
      ],
    },
  ];
}

function symbolMarkup(background: string, foreground: string) {
  return `
    <rect width="720" height="1560" fill="${background}"/>
    <path d="M78 105 L58 130 L78 155" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M335 105 L385 105 M360 80 L360 130" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round"/>
    <circle cx="510" cy="115" r="22" fill="none" stroke="${foreground}" stroke-width="7"/>
    <path d="M526 131 L552 157" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round"/>
    <path d="M620 105 L670 155 M670 105 L620 155" fill="none" stroke="${foreground}" stroke-width="7" stroke-linecap="round"/>
  `;
}

function render(body: string) {
  const svg = `<svg width="720" height="1560" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

async function degrade(
  image: Buffer,
  options: { brightness: number; quality: number; blur?: number },
) {
  let pipeline = sharp(image)
    .resize({ width: 360, height: 780, fit: "fill" })
    .modulate({ brightness: options.brightness, saturation: 0.82 });
  if (options.blur) pipeline = pipeline.blur(options.blur);
  return pipeline
    .resize({ width: viewport.width, height: viewport.height, fit: "fill" })
    .jpeg({ quality: options.quality })
    .toBuffer();
}

function target(
  id: string,
  role: "icon" | "control",
  left: number,
  top: number,
  width: number,
  height: number,
) {
  return { id, role, hitArea: { left, top, width, height } };
}

function symbolTarget(
  id: string,
  symbol: "back" | "close" | "add" | "search",
  left: number,
  top: number,
  width: number,
  height: number,
) {
  return { id, role: "icon" as const, symbol, hitArea: { left, top, width, height } };
}
