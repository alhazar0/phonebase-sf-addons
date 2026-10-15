import assert from "node:assert/strict";
import test from "node:test";

import {
  DISTURBANCE_AXES,
  generateActiveWorldCurriculum,
} from "./curriculum";
import {
  analyzeCurriculumFeedback,
  generateNextCurriculum,
  type CurriculumScenarioResult,
} from "./curriculum-feedback";

test("reports no observations as coverage gaps rather than learned success", () => {
  const curriculum = generateActiveWorldCurriculum({
    seed: "empty-results",
    count: DISTURBANCE_AXES.length,
    difficulty: { minimum: 0.1, maximum: 0.1 },
  });
  const feedback = analyzeCurriculumFeedback(curriculum, []);
  assert.equal(feedback.validResults, 0);
  for (const axis of DISTURBANCE_AXES) {
    assert.equal(feedback.axes[axis].failureBoundary, 0);
    assert.equal(feedback.axes[axis].coverageGap, 0.9);
  }
});

test("turns a localized failure into a more heavily sampled next curriculum", () => {
  const curriculum = generateActiveWorldCurriculum({
    seed: "first-round",
    count: DISTURBANCE_AXES.length * 4,
    difficulty: { minimum: 0.1, maximum: 0.1 },
  });
  const results = curriculum.scenarios.map((scenario) => {
    const failed = scenario.disturbances[0]?.axis === "popup";
    return resultFor(scenario.id, scenario.seed, failed);
  });
  const { feedback, curriculum: next } = generateNextCurriculum({
    curriculum,
    results,
    nextSeed: "second-round",
    count: 500,
    generatorOverrides: { difficulty: { minimum: 0.1, maximum: 0.1 } },
  });
  assert.ok(feedback.failureBoundary.popup > feedback.failureBoundary.theme);
  const counts = Object.fromEntries(DISTURBANCE_AXES.map((axis) => [axis, 0]));
  for (const scenario of next.scenarios) {
    for (const disturbance of scenario.disturbances) counts[disturbance.axis] += 1;
  }
  const nonPopupMean = DISTURBANCE_AXES
    .filter((axis) => axis !== "popup")
    .reduce((sum, axis) => sum + counts[axis], 0) / (DISTURBANCE_AXES.length - 1);
  assert.ok(counts.popup > nonPopupMean);
});

test("unsafe contacts dominate otherwise successful evidence", () => {
  const curriculum = generateActiveWorldCurriculum({ seed: "unsafe", count: 1 });
  const scenario = curriculum.scenarios[0]!;
  const result = resultFor(scenario.id, scenario.seed, false);
  result.outOfEnvelopeContacts = 1;
  const feedback = analyzeCurriculumFeedback(curriculum, [result]);
  const axis = scenario.disturbances[0]!.axis;
  assert.equal(feedback.axes[axis].meanFailureSeverity, 1);
  assert.equal(feedback.axes[axis].safetyFailures, 1);
  assert.equal(feedback.axes[axis].certifiedPasses, 0);
});

test("rejects unknown, duplicated, mismatched and malformed result evidence", () => {
  const curriculum = generateActiveWorldCurriculum({ seed: "validation", count: 1 });
  const scenario = curriculum.scenarios[0]!;
  const valid = resultFor(scenario.id, scenario.seed, false);
  assert.throws(
    () => analyzeCurriculumFeedback(curriculum, [{ ...valid, scenarioId: "unknown" }]),
    /unknown scenario/,
  );
  assert.throws(
    () => analyzeCurriculumFeedback(curriculum, [valid, valid]),
    /Duplicate result/,
  );
  assert.throws(
    () => analyzeCurriculumFeedback(curriculum, [{ ...valid, seed: "wrong" }]),
    /seed does not match/,
  );
  assert.throws(
    () => analyzeCurriculumFeedback(curriculum, [{ ...valid, elapsedMs: -1 }]),
    /elapsedMs must be null or non-negative/,
  );
});

function resultFor(
  scenarioId: string,
  seed: string,
  failed: boolean,
): CurriculumScenarioResult {
  return {
    scenarioId,
    seed,
    status: failed ? "failed" : "passed",
    visualProof: !failed,
    elapsedMs: failed ? 1_500 : 900,
    baselineElapsedMs: 1_000,
    recoveryOutcome: failed ? "failed" : "not_needed",
    duplicateIrreversibleActions: 0,
    wrongIrreversibleActions: 0,
    outOfEnvelopeContacts: 0,
    failureCodes: failed ? ["popup_not_dismissed"] : [],
  };
}
