import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveResponseHints, readResponseHints } from "./result-history";

function fixture() {
  const now = Date.now();
  return { modelCalls: 1, steps: [{ deviceId: "arm", calibrationFingerprint: "verified-placement", startedAt: new Date(now - 1000).toISOString(),
    receipt: { status: "completed", coordinates: "must not escape" },
    request: { intent: { type: "tap_visual", selector: { shape: "filled_circle", anchor: { text: "Mode", relation: "below" } } },
      require: { textAll: ["Mode", "Ready"], accentText: ["Mode"], overlay: "none" },
      expect: { textAll: ["Mode", "Ready"], overlay: "none", changedRegion: "left_of_target" } },
    before: { text: ["Mode", "Ready"], capturedAt: now - 1000 },
    verificationSamples: [1, 2, 3].map(i => ({ sequence: i, capturedAt: now - 900 + i * 100, ocrCapturedAt: now - 900 + i * 100,
      eligible: true, ocrCacheHit: false, overlay: "none", text: ["Mode", "Ready", "Done"],
      assessment: { checks: [{ condition: "text present: Mode", met: true }, { condition: "text present: Ready", met: true },
        { condition: "stable visual change left_of_target", met: false }] } })),
  }] };
}
test("history derives an observed response, not a cached executable plan or saved-file claim", () => {
  const hints = deriveResponseHints(fixture(), "arm", "verified-placement");
  assert.equal(hints.length, 1); assert.equal(hints[0].observedNewText, "Done"); assert.equal(hints[0].observations, 3);
  assert.equal(hints[0].level, "observed_ui_response_only"); assert.doesNotMatch(JSON.stringify(hints), /coordinates|receipt|data:image/);
});
test("known destination labels and near-identical OCR spelling jitter are not new response hints", () => {
  const report = fixture(); report.steps[0].before.text.push("PANO");
  report.steps[0].verificationSamples.forEach(s => s.text.push("PANG", "PANC", "PANO", "Mode"));
  assert.deepEqual(deriveResponseHints(report, "arm", "verified-placement").map(h => h.observedNewText), ["Done"]);
});
test("history excludes foreign placement/device, uncertain commands, stale reports and failed page checks", () => {
  assert.deepEqual(deriveResponseHints(fixture(), "other", "verified-placement"), []);
  assert.deepEqual(deriveResponseHints(fixture(), "arm", "other"), []);
  for (const mutate of [
    (r: ReturnType<typeof fixture>) => { r.steps[0].receipt.status = "failed"; },
    (r: ReturnType<typeof fixture>) => { r.steps[0].startedAt = new Date(Date.now() - 90_000_000).toISOString(); },
    (r: ReturnType<typeof fixture>) => { r.steps[0].before.text.push("Done"); },
    (r: ReturnType<typeof fixture>) => { r.steps[0].verificationSamples.forEach(s => { s.assessment.checks[0].met = false; }); },
    (r: ReturnType<typeof fixture>) => { r.steps[0].verificationSamples.forEach(s => { s.ocrCacheHit = true; }); },
    (r: ReturnType<typeof fixture>) => { r.steps[0].verificationSamples.forEach(s => { s.sequence = 1; }); },
  ]) {
    const report = fixture(); mutate(report); assert.deepEqual(deriveResponseHints(report, "arm", "verified-placement"), []);
  }
});
test("history reader accepts bounded reports, ignores partial JSON and symlinks, and deduplicates hints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-history-test-"));
  try {
    const report = JSON.stringify(fixture());
    await writeFile(join(directory, "first-task.json"), report); await writeFile(join(directory, "second-task.json"), report);
    await writeFile(join(directory, "partial-task.json"), "{");
    await writeFile(join(directory, "oversize-task.json"), " ".repeat(1_000_001));
    await symlink(join(directory, "first-task.json"), join(directory, "link-task.json"));
    const hints = await readResponseHints(directory, "arm", "verified-placement");
    assert.equal(hints.length, 1); assert.equal(hints[0].observedNewText, "Done");
    assert.deepEqual(await readResponseHints(directory, "other", "verified-placement"), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
