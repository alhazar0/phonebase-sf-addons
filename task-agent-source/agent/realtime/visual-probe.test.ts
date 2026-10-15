import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { AgentFrame } from "../screen-observer";
import { VisualProbe } from "./visual-probe";

test("visual probe measures localized changes and red state", async () => {
  const before = await frame(1, "white");
  const afterBytes = await sharp({
    create: { width: 100, height: 200, channels: 3, background: "white" },
  })
    .composite([{ input: await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#ef233c" },
    }).png().toBuffer(), left: 70, top: 80 }])
    .jpeg({ quality: 100 })
    .toBuffer();
  const after: AgentFrame = { ...before, sequence: 2, bytes: afterBytes };
  const probe = new VisualProbe(100, 200);
  const region = { left: 0.65, top: 0.35, width: 0.3, height: 0.25 };
  assert.ok(await probe.difference(before, after, region) > 0.05);
  assert.ok(await probe.redFraction(before, region) < 0.01);
  assert.ok(await probe.redFraction(after, region) > 0.1);
});

async function frame(sequence: number, background: string): Promise<AgentFrame> {
  return {
    bytes: await sharp({
      create: { width: 100, height: 200, channels: 3, background },
    }).jpeg({ quality: 100 }).toBuffer(),
    mimeType: "image/jpeg",
    width: 100,
    height: 200,
    capturedAt: Date.now(),
    sequence,
  };
}
