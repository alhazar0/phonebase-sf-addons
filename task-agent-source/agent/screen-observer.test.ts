import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { ScreenObserver, type AgentFrame } from "./screen-observer";
import type { VisualAffordance } from "./visual-affordance-detector";
import type { VisionOcrResult } from "./vision-ocr";

test("forced OCR rereads even an identical frame without erasing visual tracking history",async()=>{
  const bytes=await solidJpeg(240);let calls=0;
  const observer=new ScreenObserver({recognize:async()=>{calls++;return gridOcr();}});
  await observer.observe(frame(bytes,1));
  const next=await observer.observe(frame(bytes,2),undefined,{freshOcr:true});
  assert.equal(calls,2);assert.equal(next.ocrCacheHit,false);assert.equal(next.ocrStrategy,"full");
  assert.equal(next.changeKind,"stable");
  await observer.observe(frame(bytes,2),undefined,{freshOcr:true});assert.equal(calls,3);
});

test("reuses OCR for a visually stable camera frame", async () => {
  const bytes = await solidJpeg(240);
  let calls = 0;
  const observer = new ScreenObserver({
    recognize: async () => {
      calls += 1;
      return gridOcr();
    },
  });
  const first = await observer.observe(frame(bytes, 1));
  const second = await observer.observe(frame(bytes, 2));
  assert.equal(calls, 1);
  assert.equal(first.ocrCacheHit, false);
  assert.equal(second.ocrCacheHit, true);
  assert.equal(second.changeKind, "stable");
  assert.equal(first.scene.kind, "home_grid");
});

test("reuses local visual affordances on a stable frame and publishes them to the graph", async () => {
  const bytes = await solidJpeg(180);
  let calls = 0;
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => ocrResult([["Page", 360, 300]], 720, 1_560),
    detectAffordances: async () => {
      calls += 1;
      return {
        candidates: [{
          role: "navigation",
          label: "unlabeled top-right navigation",
          confidence: 0.9,
          center: { x: 650, y: 100 },
          bounds: { left: 618, top: 68, width: 64, height: 64 },
          source: "local_edges",
          edgeDensity: 0.3,
          localContrast: 80,
        }],
        elapsedMs: 4,
        sample: { width: 144, height: 312, edgeThreshold: 32 },
      };
    },
  });
  const first = await observer.observe(frame(bytes, 1));
  const second = await observer.observe(frame(bytes, 2));
  assert.equal(calls, 1);
  assert.equal(first.affordanceCacheHit, false);
  assert.equal(second.affordanceCacheHit, true);
  assert.equal(second.affordanceElapsedMs, 0);
  assert.ok(first.sceneGraph.nodes.some((node) =>
    node.role === "navigation" && node.label.includes("unlabeled")
  ));
  assert.equal(second.sceneGraph.nodes.find((node) => node.label.includes("unlabeled"))?.seenCount, 2);
});

test("reruns OCR after a major visual change", async () => {
  const observer = new ScreenObserver({ ocrMode: "fast", recognize: async () => gridOcr() });
  await observer.observe(frame(await solidJpeg(255), 1));
  const changed = await observer.observe(frame(await solidJpeg(0), 2));
  assert.equal(changed.ocrCacheHit, false);
  assert.equal(changed.changeKind, "major");
  assert.ok((changed.changeRatio ?? 0) > 0.9);
});

test("classifies a uniformly dark camera viewport as a sleeping screen", async () => {
  let calls = 0;
  const observer = new ScreenObserver({
    recognize: async () => {
      calls += 1;
      return ocrResult([], 720, 1_560);
    },
  });
  const result = await observer.observe(frame(await solidJpeg(0), 1));
  assert.equal(result.scene.kind, "screen_off");
  assert.equal(result.scene.confidence, 0.99);
  assert.equal(calls, 1);
});

test("visible text prevents a dark page from being treated as a sleeping screen", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => ocrResult([["Playing", 360, 780]], 720, 1_560),
  });
  const result = await observer.observe(frame(await solidJpeg(0), 1));
  assert.notEqual(result.scene.kind, "screen_off");
});

test("uses changed-region OCR and preserves stable scene nodes for a localized update", async () => {
  const [beforeBytes, afterBytes] = await localizedJpegs();
  let calls = 0;
  const observer = new ScreenObserver({
    ocrMode: "fast",
    minimumFullOcrMsForIncremental: 0,
    minimumFullOcrSamplesForIncremental: 1,
    recognize: async () => {
      calls += 1;
      if (calls === 1) {
        return ocrResult([
          ["Header", 110, 150],
          ["Persistent", 130, 320],
        ], 720, 1_560);
      }
      return ocrResult([["Updated", 5, 5]], 10, 10);
    },
  });
  const before = await observer.observe(frame(beforeBytes, 1));
  const after = await observer.observe(frame(afterBytes, 2));
  assert.equal(calls, 2);
  assert.equal(after.changeKind, "minor");
  assert.equal(after.ocrStrategy, "regions");
  assert.equal(after.ocrRegionCount, 1);
  assert.ok(after.elements.some((element) => element.text === "Persistent"));
  assert.ok(after.elements.some((element) => element.text === "Updated"));
  const firstPersistent = before.sceneGraph?.nodes.find((node) => node.label === "Persistent");
  const nextPersistent = after.sceneGraph?.nodes.find((node) => node.label === "Persistent");
  assert.ok(firstPersistent && nextPersistent);
  assert.equal(nextPersistent.id, firstPersistent.id);
});

test("keeps cheap full-frame OCR on the hot path instead of forcing a slower crop", async () => {
  const [beforeBytes, afterBytes] = await localizedJpegs();
  let calls = 0;
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => {
      calls += 1;
      return { ...gridOcr(), elapsedMs: 18 };
    },
  });
  await observer.observe(frame(beforeBytes, 1));
  const after = await observer.observe(frame(afterBytes, 2));
  assert.equal(calls, 2);
  assert.equal(after.changeKind, "minor");
  assert.equal(after.ocrStrategy, "full");
  assert.equal(after.ocrRegionCount, 1);
});

test("adaptive OCR escalates an uncertain fast pass once", async () => {
  const modes: string[] = [];
  const observer = new ScreenObserver({
    recognize: async (_dataUrl, _signal, mode) => {
      modes.push(mode ?? "accurate");
      return mode === "fast" ? weakOcr() : gridOcr();
    },
  });
  const result = await observer.observe(frame(await solidJpeg(100), 1));
  assert.deepEqual(modes, ["fast", "accurate"]);
  assert.equal(result.scene.kind, "home_grid");
  assert.equal(result.ocrElapsedMs, 21);
});

test("classifies a scaled iOS app switcher card before home-grid scoring", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => appSwitcherOcr(),
  });
  const result = await observer.observe(frame(await solidJpeg(80), 1));
  assert.equal(result.scene.kind, "app_switcher");
  assert.equal(result.scene.confidence, 0.94);
});

test("recognizes one arbitrary switcher card from title and inset pixel geometry", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => arbitraryAppCardOcr(),
  });
  const result = await observer.observe(frame(await insetCardJpeg(), 1));
  assert.equal(result.scene.kind, "app_switcher");
  assert.equal(result.scene.confidence, 0.94);
});

test("does not mistake the same arbitrary title on a full-screen app for App Switcher", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => arbitraryAppCardOcr(),
  });
  const result = await observer.observe(frame(await solidJpeg(160), 1));
  assert.equal(result.scene.kind, "text_ui");
});

test("does not classify a normal search toolbar as App Switcher", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => ({
      ok: true,
      imageWidth: 720,
      imageHeight: 1_560,
      elapsedMs: 8,
      items: [
        ["Back", 45, 130], ["world largest cow", 300, 130],
        ["Top", 120, 205], ["Images", 250, 205], ["Videos", 390, 205],
      ].map(([text, centerX, centerY]) => ({
        text: String(text),
        confidence: 0.95,
        left: Number(centerX) - 45,
        top: Number(centerY) - 10,
        width: 90,
        height: 20,
        centerX: Number(centerX),
        centerY: Number(centerY),
      })),
    }),
  });
  const result = await observer.observe(frame(await solidJpeg(80), 1));
  assert.equal(result.scene.kind, "text_ui");
});

test("classifies iOS App Library independently from a normal home grid", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => appLibraryOcr(),
  });
  const result = await observer.observe(frame(await solidJpeg(100), 1));
  assert.equal(result.scene.kind, "app_library");
  assert.equal(result.scene.confidence, 0.98);
});

test("does not treat a sparse first Home row as an app switcher", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => sparseHomeOcr(),
  });
  const result = await observer.observe(frame(await solidJpeg(120), 1));
  assert.equal(result.scene.kind, "home_grid");
});

test("does not classify one bottom navigation row as a Home icon grid", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => telegramListOcr(),
  });
  const result = await observer.observe(frame(await solidJpeg(180), 1));
  assert.equal(result.scene.kind, "text_ui");
  assert.equal(result.scene.homeGridScore, 0);
});

test("does not mistake a two-by-three in-app mini launcher for system Home", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => miniLauncherOcr(),
  });
  const result = await observer.observe(frame(await solidJpeg(180), 1));
  assert.equal(result.scene.kind, "text_ui");
  assert.equal(result.scene.homeGridScore, 0);
});

test("combines partial fast OCR with local icon geometry to recover Home", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => partialHomeOcr(),
    detectAffordances: async () => ({
      candidates: partialHomeAffordances(),
      elapsedMs: 7,
      sample: { width: 144, height: 312, edgeThreshold: 30 },
    }),
  });
  const result = await observer.observe(frame(await solidJpeg(150), 1));
  assert.equal(result.scene.kind, "home_grid");
  assert.ok(result.scene.homeGridScore >= 0.7);
  assert.ok(result.sceneGraph?.nodes.filter((node) => node.role === "app_icon").length >= 8);
});

test("does not promote a three-row in-app grid without a dock or fourth row", async () => {
  const observer = new ScreenObserver({
    ocrMode: "fast",
    recognize: async () => miniLauncherOcr(),
    detectAffordances: async () => ({
      candidates: [200, 390, 580].flatMap((y) =>
        [150, 360, 570].map((x) => visualCandidate(x, y))
      ),
      elapsedMs: 7,
      sample: { width: 144, height: 312, edgeThreshold: 30 },
    }),
  });
  const result = await observer.observe(frame(await solidJpeg(150), 1));
  assert.equal(result.scene.kind, "text_ui");
  assert.equal(result.scene.homeGridScore, 0);
});

function frame(bytes: Buffer, sequence: number): AgentFrame {
  return {
    bytes,
    mimeType: "image/jpeg",
    width: 720,
    height: 1_560,
    capturedAt: Date.now(),
    sequence,
  };
}

function solidJpeg(value: number) {
  return sharp({
    create: {
      width: 72,
      height: 156,
      channels: 3,
      background: { r: value, g: value, b: value },
    },
  }).jpeg().toBuffer();
}

async function localizedJpegs() {
  const before = await sharp({
    create: {
      width: 72,
      height: 156,
      channels: 3,
      background: { r: 80, g: 80, b: 80 },
    },
  }).png().toBuffer();
  const after = await sharp(before)
    .composite([{
      input: await sharp({
        create: {
          width: 16,
          height: 24,
          channels: 3,
          background: { r: 245, g: 245, b: 245 },
        },
      }).png().toBuffer(),
      left: 48,
      top: 88,
    }])
    .jpeg({ quality: 95 })
    .toBuffer();
  return [await sharp(before).jpeg({ quality: 95 }).toBuffer(), after] as const;
}

async function insetCardJpeg() {
  const card = await sharp({
    create: {
      width: 52,
      height: 104,
      channels: 3,
      background: { r: 175, g: 175, b: 175 },
    },
  }).png().toBuffer();
  return sharp({
    create: {
      width: 72,
      height: 156,
      channels: 3,
      background: { r: 4, g: 4, b: 4 },
    },
  }).composite([{ input: card, left: 10, top: 24 }]).jpeg({ quality: 95 }).toBuffer();
}

function ocrResult(
  labels: ReadonlyArray<readonly [string, number, number]>,
  imageWidth: number,
  imageHeight: number,
): VisionOcrResult {
  return {
    ok: true,
    imageWidth,
    imageHeight,
    elapsedMs: 8,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 20,
      top: centerY - 8,
      width: 40,
      height: 16,
      centerX,
      centerY,
    })),
  };
}

function gridOcr(): VisionOcrResult {
  const labels = [
    ["One", 90, 260], ["Two", 270, 260],
    ["Three", 450, 260], ["Four", 630, 260],
    ["Five", 90, 520], ["Six", 270, 520],
    ["Seven", 450, 520], ["Eight", 630, 520],
  ] as const;
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 14,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 40,
      top: centerY - 10,
      width: 80,
      height: 20,
      centerX,
      centerY,
    })),
  };
}

function weakOcr(): VisionOcrResult {
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 7,
    items: [{
      text: "blur",
      confidence: 0.3,
      left: 20,
      top: 20,
      width: 50,
      height: 20,
      centerX: 45,
      centerY: 30,
    }],
  };
}

function appSwitcherOcr(): VisionOcrResult {
  const labels = [
    ["Telegram", 150, 150], ["TikTok", 320, 150],
    ["Following", 290, 330], ["For You", 430, 330],
    ["Home", 210, 1_180], ["Friends", 320, 1_180],
    ["Inbox", 440, 1_180], ["Profile", 520, 1_180],
  ] as const;
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 45,
      top: centerY - 10,
      width: 90,
      height: 20,
      centerX,
      centerY,
    })),
  };
}

function arbitraryAppCardOcr(): VisionOcrResult {
  return ocrResult([
    ["Aether Notes", 290, 180],
    ["Workspace", 290, 370],
  ], 720, 1_560);
}

function appLibraryOcr(): VisionOcrResult {
  const labels = [
    ["App Library", 360, 150], ["Suggestions", 190, 250],
    ["Recently Added", 520, 250], ["Social", 190, 600],
    ["Utilities", 190, 960], ["Creativity", 520, 960],
  ] as const;
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 60,
      top: centerY - 10,
      width: 120,
      height: 20,
      centerX,
      centerY,
    })),
  };
}

function sparseHomeOcr(): VisionOcrResult {
  const labels = [
    ["/TV", 606, 184], ["Pinterest", 115, 271],
    ["Threads", 278, 267], ["Authenticator", 453, 264],
    ["Discord", 112, 445], ["Authenticator", 278, 443],
    ["Block Blast!", 442, 439], ["Subway Surf", 606, 439],
    ["GitHub", 114, 800], ["Stripe", 608, 615],
  ] as const;
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 45,
      top: centerY - 10,
      width: 90,
      height: 20,
      centerX,
      centerY,
    })),
  };
}

function partialHomeOcr(): VisionOcrResult {
  return ocrResult([
    ["Weather", 110, 270], ["Stocks", 275, 270],
    ["Books", 110, 450], ["Store", 275, 450],
    ["Contacts", 110, 630], ["Translate", 275, 630], ["Files", 440, 630],
    ["Utilities", 110, 810], ["Tips", 610, 810],
    ["TikTok", 275, 990], ["Instagram", 440, 990], ["YouTube", 610, 990],
    ["ChatGPT", 440, 1_170],
  ], 720, 1_560);
}

function partialHomeAffordances(): VisualAffordance[] {
  return [
    visualCandidate(110, 200),
    visualCandidate(440, 560), visualCandidate(610, 560),
    visualCandidate(275, 740),
    visualCandidate(275, 920), visualCandidate(440, 920), visualCandidate(610, 920),
    visualCandidate(110, 1_100), visualCandidate(275, 1_100), visualCandidate(440, 1_100),
    visualCandidate(275, 1_450, "navigation"),
    visualCandidate(440, 1_450, "navigation"),
    visualCandidate(610, 1_450, "navigation"),
  ];
}

function visualCandidate(
  x: number,
  y: number,
  role: VisualAffordance["role"] = "icon",
): VisualAffordance {
  return {
    role,
    label: `unlabeled ${role}`,
    confidence: 0.9,
    center: { x, y },
    bounds: { left: x - 65, top: y - 75, width: 130, height: 150 },
    source: "local_edges",
    edgeDensity: 0.2,
    localContrast: 60,
  };
}

function telegramListOcr(): VisionOcrResult {
  const labels = [
    ["Chats", 360, 120], ["Search", 360, 190],
    ["Work", 210, 300], ["Bro", 210, 340], ["03:58", 660, 300],
    ["Female bible app", 253, 446], ["02:12", 662, 440],
    ["Shubhan Dua", 222, 481], ["@ 1", 653, 493],
    ["Manifest following up here", 307, 513],
    ["jia liang", 192, 577], ["Sun", 671, 568], ["JL", 77, 610],
    ["Contacts", 100, 1_500], ["Calls", 270, 1_500],
    ["Chats", 450, 1_500], ["Settings", 620, 1_500],
  ] as const;
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 55,
      top: centerY - 10,
      width: 110,
      height: 20,
      centerX,
      centerY,
    })),
  };
}

function miniLauncherOcr(): VisionOcrResult {
  const labels = [
    ["My Perfect Air", 150, 270], ["Gunfire Evolution", 360, 270],
    ["My Dream Pizza", 570, 270], ["DramaBloom", 150, 460],
    ["ReelShorts", 360, 460], ["StoryRush", 570, 460],
    ["Got it", 360, 1_420],
  ] as const;
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 55,
      top: centerY - 10,
      width: 110,
      height: 20,
      centerX,
      centerY,
    })),
  };
}
