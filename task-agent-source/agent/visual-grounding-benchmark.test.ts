import assert from "node:assert/strict";
import test from "node:test";

import { evaluateVisualGrounding } from "./visual-grounding-benchmark";
import { createHeldOutVisualGroundingFixtures } from "./visual-grounding-fixtures";

test("passes held-out hit-area and local latency gates", async () => {
  const report = await evaluateVisualGrounding(
    await createHeldOutVisualGroundingFixtures(),
  );
  assert.equal(report.gate.passed, true, report.gate.blockers.join("; "));
  assert.ok(report.targetHitRate >= 0.9);
  assert.ok(report.candidatePrecision >= 0.65);
  assert.ok(report.latencyMs.p95 <= 300);
});
