import assert from "node:assert/strict";
import test from "node:test";

import {
  DISTURBANCE_AXES,
  generateActiveWorldCurriculum,
} from "./curriculum";

test("generates byte-equivalent curriculum data for the same seed", () => {
  const options = {
    seed: "held-out-seed-17",
    count: 40,
    promotionStage: "replay" as const,
    passedStages: ["simulator" as const],
    failureBoundary: { popup: 0.8, camera_latency: 0.4 },
  };
  assert.deepEqual(
    generateActiveWorldCurriculum(options),
    generateActiveWorldCurriculum(options),
  );
  const different = generateActiveWorldCurriculum({ ...options, seed: "held-out-seed-18" });
  assert.notEqual(
    different.scenarios[0]?.id,
    generateActiveWorldCurriculum(options).scenarios[0]?.id,
  );
});

test("targets the measured failure boundary while retaining broad exploration", () => {
  const curriculum = generateActiveWorldCurriculum({
    seed: "failure-targeting",
    count: 500,
    failureBoundary: { popup: 1 },
    difficulty: { minimum: 0.7, maximum: 0.9 },
  });
  const counts = Object.fromEntries(DISTURBANCE_AXES.map((axis) => [axis, 0]));
  for (const scenario of curriculum.scenarios) {
    for (const disturbance of scenario.disturbances) counts[disturbance.axis] += 1;
  }
  const nonPopupMean = DISTURBANCE_AXES
    .filter((axis) => axis !== "popup")
    .reduce((sum, axis) => sum + counts[axis], 0) / (DISTURBANCE_AXES.length - 1);
  assert.ok(counts.popup > nonPopupMean * 2);
  for (const axis of DISTURBANCE_AXES) assert.ok(counts[axis] > 0, `${axis} was never explored`);
});

test("covers every disturbance axis when the suite is large enough", () => {
  const curriculum = generateActiveWorldCurriculum({
    seed: 42,
    count: DISTURBANCE_AXES.length,
  });
  const seen = new Set(
    curriculum.scenarios.flatMap((scenario) =>
      scenario.disturbances.map((disturbance) => disturbance.axis)),
  );
  assert.deepEqual([...seen].sort(), [...DISTURBANCE_AXES].sort());
});

test("locks physical and side-effect stages until every prerequisite passed", () => {
  assert.throws(
    () => generateActiveWorldCurriculum({
      seed: "locked",
      count: 1,
      promotionStage: "controlled_side_effect",
      passedStages: ["simulator", "replay"],
    }),
    /missing verified stage: reversible_physical/,
  );
  const replay = generateActiveWorldCurriculum({
    seed: "safe-replay",
    count: 5,
    promotionStage: "replay",
    passedStages: ["simulator"],
  });
  assert.ok(replay.scenarios.every((scenario) =>
    !scenario.executionPolicy.allowHardwareMotion &&
    !scenario.executionPolicy.allowExternalSideEffects));
  const controlled = generateActiveWorldCurriculum({
    seed: "unlocked",
    count: 1,
    promotionStage: "controlled_side_effect",
    passedStages: ["reversible_physical", "simulator", "replay"],
  });
  assert.equal(controlled.scenarios[0]?.executionPolicy.allowHardwareMotion, true);
  assert.equal(controlled.scenarios[0]?.executionPolicy.allowExternalSideEffects, true);
});

test("bounds difficulty, disturbance count and intensities", () => {
  const curriculum = generateActiveWorldCurriculum({
    seed: "bounds",
    count: 200,
    difficulty: { minimum: 0.05, maximum: 1 },
  });
  for (const scenario of curriculum.scenarios) {
    assert.ok(scenario.difficulty >= 0.05 && scenario.difficulty <= 1);
    assert.ok(scenario.disturbances.length >= 1 && scenario.disturbances.length <= 4);
    for (const disturbance of scenario.disturbances) {
      assert.ok(disturbance.intensity >= 0 && disturbance.intensity <= 1);
    }
  }
});

test("rejects malformed inputs instead of silently weakening the suite", () => {
  assert.throws(
    () => generateActiveWorldCurriculum({ seed: "", count: 1 }),
    /seed cannot be empty/,
  );
  assert.throws(
    () => generateActiveWorldCurriculum({ seed: "x", count: 0 }),
    /count must be an integer/,
  );
  assert.throws(
    () => generateActiveWorldCurriculum({
      seed: "x",
      count: 1,
      failureBoundary: { popup: 1.1 },
    }),
    /popup score must be between 0 and 1/,
  );
});
