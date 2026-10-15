import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { LocalPerceptionService, readFrameHeader, requireFreshFrame } from "./service";
import type { ScreenObserver, AgentFrame } from "../screen-observer";

test("camera headers accept both existing protocol names and reject missing metadata", () => {
  for (const prefix of ["x-screenhand-", "x-phonebase-"]) {
    assert.equal(readFrameHeader(new Response(null, { headers: { [prefix + "frame-sequence"]: "14" } }), "frame-sequence"), 14);
  }
  for (const value of ["", "NaN", "1.2", "-1", "0"]) assert.throws(() => readFrameHeader(new Response(null, { headers: { "x-phonebase-frame-sequence": value } }), "frame-sequence"));
});
test("stale and future frames are rejected", () => {
  assert.throws(() => requireFreshFrame(1000, 3000));
  assert.throws(() => requireFreshFrame(5000, 1000));
  assert.doesNotThrow(() => requireFreshFrame(2000, 2400));
});
test("remote endpoints and URL credentials cannot be used", () => {
  for (const url of ["https://example.com", "http://example.com", "http://user:secret@localhost"]) assert.throws(() => new LocalPerceptionService(url));
});

async function fixture() {
  const jpeg = await sharp({ create: { width: 64, height: 96, channels: 3, background: "white" } }).jpeg().toBuffer();
  let calls = 0;
  let ocrCalls = 0;
  let resets = 0;
  let forcedReads = 0;
  let stale = false;
  let sequence = 1;
  const methods: string[] = [];
  const fetcher = (async (_url, init) => {
    methods.push(init?.method ?? "GET"); calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(jpeg, { headers: { "content-type": "image/jpeg", "x-phonebase-frame-sequence": String(sequence), "x-phonebase-captured-at": String(Date.now() - (stale ? 10000 : 10)), "x-phonebase-frame-width": "64", "x-phonebase-frame-height": "96" } });
  }) as typeof fetch;
  const observer = {
    async observe(frame: AgentFrame,_signal?:AbortSignal,options?:{freshOcr?:boolean}) {
      if(options?.freshOcr)forcedReads++;
      ocrCalls++;
      return { sequence: frame.sequence, capturedAt: frame.capturedAt, viewport: { width: frame.width, height: frame.height }, fingerprint: "x", changeRatio: 0, changeKind: "stable" as const, ocrCacheHit: false, ocrElapsedMs: 1, observationElapsedMs: 1, averageTextConfidence: 0, textSignature: new Set<string>(), elements: [], scene: { kind: "unknown" as const, confidence: 0, homeGridScore: 0, keyboardVisible: false } };
    },
    reset() { resets++; },
  } as unknown as ScreenObserver;
  return { service: new LocalPerceptionService("http://127.0.0.1:3013", fetcher, () => observer), methods, counts: () => ({ calls, ocrCalls, resets, forcedReads }), setStale: (value: boolean) => { stale = value; }, setSequence: (value: number) => { sequence = value; } };
}

test("simultaneous viewers share one capture; the service issues only GET", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.service.observe("arm"), f.service.observe("arm")]);
  assert.equal(a.frame.sequence, b.frame.sequence); assert.equal(f.counts().calls, 1); assert.equal(f.counts().ocrCalls, 1);
  assert.deepEqual(f.methods, ["GET"]); assert.equal(a.generatedModelCalls, 0); assert.equal(a.physicalActionsAllowed, false);
  assert.equal(a.coordinateSpace, "raw-camera"); assert.equal(a.trainedClassifier, false);
});
test("a stale frame cannot reach OCR or be returned as live", async () => {
  const f = await fixture(); f.setStale(true);
  await assert.rejects(f.service.observe("arm"), /stale/);
  assert.equal(f.counts().ocrCalls, 0); assert.equal(f.counts().resets, 1);
  f.setStale(false); assert.equal((await f.service.observe("arm")).ok, true);
});
test("a sequence reset clears observer state after reconnect", async () => {
  const f = await fixture(); f.setSequence(100); await f.service.observe("arm");
  f.setSequence(1); await f.service.observe("arm"); assert.equal(f.counts().resets, 1);
});
test("device path traversal is rejected before network access", async () => {
  const f = await fixture(); assert.throws(() => f.service.observe("../../actions")); assert.equal(f.counts().calls, 0);
});

test("small text changes cannot be hidden by an unlimited stable-frame cache", async () => {
  const f = await fixture(); await f.service.observe("arm");
  await new Promise(resolve => setTimeout(resolve, 1_020));
  f.setSequence(2); await f.service.observe("arm");
  assert.equal(f.counts().resets, 1);
});

test("forced post-action observation does not join a pre-action OCR request",async()=>{
  const f=await fixture();const before=f.service.observe("arm");const after=f.service.observe("arm",{freshOcr:true});
  await Promise.all([before,after]);assert.equal(f.counts().calls,2);assert.equal(f.counts().resets,0);assert.equal(f.counts().forcedReads,1);
  const next=await f.service.observe("arm",{freshOcr:true});assert.equal(next.timing.ocrCapturedAt,next.frame.capturedAt);
});

test("an aborted observation cannot start a capture",async()=>{
  const f=await fixture();const controller=new AbortController();controller.abort();
  assert.throws(()=>f.service.observe("arm",{freshOcr:true,signal:controller.signal}));assert.equal(f.counts().calls,0);
});
