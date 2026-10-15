import assert from "node:assert/strict";
import test from "node:test";
import { prepareResultReadback, resultReadbackSchema } from "./result-readback";
import { LocalClosedLoopExecutor, type LocalView } from "./executor";
import { LocalVisualTaskRunner } from "./task-runner";
import { decodeWirePlan, taskPlanSchema } from "./task-planner";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";

const profile: ScreenHandCalibrationProfile = {
  id: "test", deviceId: "arm", verified: true, verifiedAt: "2026-09-07T00:00:00Z",
  frame: { width: 720, height: 1280 }, screen: { width: 720, height: 1280 },
  imagePoints: [{ x: 0, y: 0 }, { x: 720, y: 0 }, { x: 720, y: 1280 }, { x: 0, y: 1280 }],
  machinePoints: [{ x: 70, y: 160 }, { x: 10, y: 160 }, { x: 10, y: 20 }, { x: 70, y: 20 }],
  safeMachineBounds: { minimumX: 9, maximumX: 71, minimumY: 19, maximumY: 161 },
  tap: { hoverZ: 1, touchZ: 9.5, zStep: .5, feed: 3000, dwellMs: 40 },
  navigation: { home: { strategy: "screen-swipe", startPoint: { x: 360, y: 1200 }, endPoint: { x: 360, y: 700 }, durationMs: 250, source: "ios-face-id-home-v1" } },
};
function view(texts: string[], sequence = 1, capturedAt = Date.now()): LocalView {
  return {
    deviceId: "arm", frame: { ...profile.frame, sequence, capturedAt, image: "data:image/jpeg;base64," },
    visual: { targets: [], accentText: [] },
    state: { page: "unknown", source: "insufficient_evidence", overlay: "none", keyboard: false, candidates: [], evidence: [], stableFrames: 1, method: "local-feature-rules+temporal", scoreIsProbability: false },
    timing: { fetchMs: 1, observationMs: 1, ocrMs: 1, ocrCacheHit: false, ocrCapturedAt: capturedAt, ocrAgeMs: 0, stateMs: 0, totalMs: 1, frameAgeMs: 0 },
    elements: texts.map((text, i) => ({ id: `t${i}`, role: "text", text, confidence: 1,
      center: { x: 150, y: 200 + i * 80 }, bounds: { left: 100, top: 185 + i * 80, width: 100, height: 30 } })),
  };
}

test("new response text distinguishes UI response from saved-file proof", () => {
  const before = view(["Mode", "Ready"], 1, 100);
  const read = prepareResultReadback({ kind: "new_text", label: "Done" }, before);
  assert.equal(read(view(["Mode", "Ready"], 2, 200)).met, false);
  const result = read(view(["Mode", "Ready", "Done"], 3, 300));
  assert.equal(result.met, true); assert.equal(result.level, "ui_response"); assert.equal(result.storageVerified, false);
  assert.equal(read(view(["Done", "Done"], 4, 400)).met, false);
  const low = view(["Done"], 5, 500); low.elements[0].confidence = .5;
  assert.equal(read(low).met, false);
  assert.throws(() => prepareResultReadback({ kind: "new_text", label: "Ready" }, before), /already exists/);
});

test("counter read-back requires exact delta, same layout, and an unambiguous baseline", () => {
  const before = view(["Items: 12", "Ready"], 1, 100);
  const read = prepareResultReadback({ kind: "counter_delta", label: "Items", delta: 1 }, before);
  assert.equal(read(view(["Items: 13", "Ready"], 2, 200)).met, true);
  assert.equal(read(view(["Items: 12", "Ready"], 3, 300)).reason, "unchanged");
  assert.equal(read(view(["Items: 14", "Ready"], 4, 400)).reason, "unexpected_delta");
  const shifted = view(["Items: 13", "Ready"], 5, 500); shifted.elements[0].center.x += 25;
  assert.equal(read(shifted).reason, "layout_changed");
  for (const texts of [["Items: 1.2K"], ["Items: 1,200"], ["Items: 12", "Items: 13"], ["Items: 9007199254740992"]]) {
    assert.throws(() => prepareResultReadback({ kind: "counter_delta", label: "Items", delta: 1 }, view(texts)), /baseline/);
  }
});

test("adjacent OCR counter boxes work without accepting two neighboring numeric values", () => {
  const before = view(["Items", "12"], 1, 100);
  before.elements[1] = { ...before.elements[1], center: { x: 225, y: 200 }, bounds: { left: 210, top: 185, width: 30, height: 30 } };
  const after = structuredClone(before); after.frame.sequence = 2; after.frame.capturedAt = after.timing.ocrCapturedAt = 200;
  after.elements[1].text = "13";
  assert.equal(prepareResultReadback({ kind: "counter_delta", label: "Items", delta: 1 }, before)(after).met, true);
  before.elements.push({ ...before.elements[1], id: "extra", text: "14" });
  assert.throws(() => prepareResultReadback({ kind: "counter_delta", label: "Items", delta: 1 }, before), /baseline/);
});

test("stale, cached, cross-device and resized result evidence is rejected", () => {
  const before = view(["Mode"], 1, 100), read = prepareResultReadback({ kind: "new_text", label: "Done" }, before);
  for (const change of [(v: LocalView) => { v.deviceId = "other"; }, (v: LocalView) => { v.frame.width = 800; },
    (v: LocalView) => { v.frame.sequence = 1; }, (v: LocalView) => { v.timing.ocrCacheHit = true; },
    (v: LocalView) => { v.timing.ocrCapturedAt--; }]) {
    const after = view(["Done"], 2, 200); change(after); assert.throws(() => read(after), /fresh independent/);
  }
  assert.equal(resultReadbackSchema.safeParse({ kind: "counter_delta", label: "Items", delta: 0 }).success, false);
});

test("executor requires two independent response observations, never retries and rejects an existing badge", async () => {
  for (const mode of ["success", "brief", "existing", "uncertain"] as const) {
    let actions = 0, observations = 0;
    const executor = new LocalClosedLoopExecutor({ deviceId: "arm", getCalibration: async () => profile,
      getDevice: async () => ({ id: "arm", connected: true, status: "running", screen: null, state: { grbl: { homed: true, state: "Idle" } }, capabilities: { actions: { tap: { available: true } } } }),
      observe: async () => {
        observations++;
        const response = mode === "existing" || (actions > 0 && (mode === "success" || (mode === "brief" && observations === 3)));
        return view(["Submit", "Mode", "Ready", ...(response ? ["Done"] : [])], observations);
      },
      act: async () => { actions++; if (mode === "uncertain") throw new Error("Lost receipt"); return { receipt: { id: "one", status: "completed" }, elapsedMs: 1, response: {} }; },
    });
    const report = await executor.run({ intent: { type: "tap_text", text: "Submit" }, expect: { textAll: ["Mode", "Ready"], readback: { kind: "new_text", label: "Done" } } },
      { execute: true, verificationMs: 550 });
    assert.equal(report.status, mode === "success" ? "verified" : mode === "existing" ? "blocked" : mode === "uncertain" ? "action_uncertain" : "unverified", report.error);
    assert.equal(actions, mode === "existing" ? 0 : 1);
    if (mode === "success") assert.ok(report.verificationSamples.filter(s => s.eligible && s.readback?.met).length >= 2);
  }
});

test("planned Home cleans up a pre-action failure after a completed earlier step, never an uncertain receipt", async () => {
  const plan = taskPlanSchema.parse({ steps: [
    { intent: { type: "tap_text", text: "Open" }, expect: { textAll: ["Destination", "Title"] } },
    { intent: { type: "tap_text", text: "Missing" }, require: { textAll: ["Destination", "Title"] }, expect: { textAll: ["Finished", "Title"] } },
    { intent: { type: "navigate", key: "home" }, expect: { textAll: ["Open", "Settings"] } },
  ], unsupportedReason: null });
  for (const uncertain of [false, true]) {
    let actions = 0, sequence = 0;
    const runner = new LocalVisualTaskRunner({ deviceId: "arm", getCalibration: async () => profile,
      getDevice: async () => ({ id: "arm", connected: true, status: "running", screen: null, state: { grbl: { homed: true, state: "Idle" } }, capabilities: { actions: { tap: { available: true }, phone_key: { available: true } } } }),
      observe: async () => view(actions === 1 ? ["Destination", "Title"] : ["Open", "Settings"], ++sequence),
      act: async () => { actions++; if (uncertain) throw new Error("Lost receipt"); return { receipt: { id: `r${actions}`, status: "completed" }, elapsedMs: 1, response: {} }; },
    }, { plan: async () => ({ plan, elapsedMs: 1, model: "fake" }) });
    const result = await runner.run("fixture", { execute: true, signal: AbortSignal.timeout(3000) });
    assert.equal(result.status, uncertain ? "action_uncertain" : "unverified", result.error);
    assert.equal(actions, uncertain ? 1 : 2); assert.equal(result.cleanup?.status, uncertain ? undefined : "verified");
    assert.equal(result.resultEvidence?.level, "not_confirmed");
  }
});

test("wire plan read-back is explicit, bounded and cannot smuggle contradictory evidence", () => {
  const step = { action: "tap_text", text: "Submit", shape: null, tone: null, anchor: null, relation: null,
    beforeTexts: ["Mode", "Ready"], beforeAccent: [], afterTexts: ["Mode", "Ready"], afterAccent: [], changedRegion: null,
    readbackKind: "new_text", readbackLabel: "Done", readbackDelta: null };
  const decoded = decodeWirePlan({ steps: [step], unsupportedReason: null });
  assert.deepEqual(decoded.steps[0].expect.readback, { kind: "new_text", label: "Done" });
  for (const bad of [{ readbackLabel: null }, { readbackDelta: 1 }, { readbackKind: null }, { readbackKind: "counter_delta", readbackDelta: 0 }]) {
    assert.throws(() => decodeWirePlan({ steps: [{ ...step, ...bad }], unsupportedReason: null }));
  }
});
