import {
  DISTURBANCE_AXES,
  generateActiveWorldCurriculum,
  type ActiveWorldCurriculum,
  type CurriculumGeneratorOptions,
  type DisturbanceAxis,
} from "./curriculum";

export const ACTIVE_WORLD_CURRICULUM_FEEDBACK_SCHEMA_VERSION =
  "screenhand.active-world.curriculum-feedback.v1" as const;

export type CurriculumScenarioResult = {
  scenarioId: string;
  seed: string;
  status: "passed" | "failed" | "invalid";
  visualProof: boolean;
  elapsedMs: number | null;
  baselineElapsedMs: number | null;
  recoveryOutcome: "not_needed" | "recovered" | "failed";
  duplicateIrreversibleActions: number;
  wrongIrreversibleActions: number;
  outOfEnvelopeContacts: number;
  failureCodes: string[];
};

export type CurriculumAxisFeedback = {
  axis: DisturbanceAxis;
  scheduledScenarios: number;
  validResults: number;
  distinctSeeds: number;
  certifiedPasses: number;
  certifiedSuccessRate: number | null;
  recoveryFailures: number;
  safetyFailures: number;
  duplicateActions: number;
  meanTaskDurationRatio: number | null;
  meanFailureSeverity: number | null;
  evidenceConfidence: number;
  failureBoundary: number;
  coverageGap: number;
};

export type CurriculumFeedbackProfile = {
  schemaVersion: typeof ACTIVE_WORLD_CURRICULUM_FEEDBACK_SCHEMA_VERSION;
  curriculumSeed: string;
  scheduledScenarios: number;
  suppliedResults: number;
  validResults: number;
  invalidResults: number;
  missingResults: number;
  axes: Record<DisturbanceAxis, CurriculumAxisFeedback>;
  failureBoundary: Record<DisturbanceAxis, number>;
  coverageGaps: Record<DisturbanceAxis, number>;
};

export type CurriculumFeedbackOptions = {
  desiredValidResultsPerAxis?: number;
  desiredDistinctSeedsPerAxis?: number;
};

export function analyzeCurriculumFeedback(
  curriculum: ActiveWorldCurriculum,
  results: CurriculumScenarioResult[],
  options: CurriculumFeedbackOptions = {},
): CurriculumFeedbackProfile {
  const desiredValidResults = positiveInteger(
    options.desiredValidResultsPerAxis ?? 20,
    "desiredValidResultsPerAxis",
  );
  const desiredDistinctSeeds = positiveInteger(
    options.desiredDistinctSeedsPerAxis ?? 5,
    "desiredDistinctSeedsPerAxis",
  );
  const scenarios = new Map(curriculum.scenarios.map((scenario) => [scenario.id, scenario]));
  const resultsByScenario = new Map<string, CurriculumScenarioResult>();
  for (const result of results) {
    validateResult(result);
    const scenario = scenarios.get(result.scenarioId);
    if (!scenario) throw new Error(`Result references unknown scenario: ${result.scenarioId}.`);
    if (result.seed !== scenario.seed) {
      throw new Error(`Result seed does not match scenario ${result.scenarioId}.`);
    }
    if (resultsByScenario.has(result.scenarioId)) {
      throw new Error(`Duplicate result for scenario: ${result.scenarioId}.`);
    }
    resultsByScenario.set(result.scenarioId, result);
  }

  const axes = Object.fromEntries(DISTURBANCE_AXES.map((axis) => [
    axis,
    analyzeAxis(
      axis,
      curriculum,
      resultsByScenario,
      desiredValidResults,
      desiredDistinctSeeds,
    ),
  ])) as Record<DisturbanceAxis, CurriculumAxisFeedback>;
  const validResults = results.filter((result) => result.status !== "invalid").length;
  const invalidResults = results.length - validResults;
  return {
    schemaVersion: ACTIVE_WORLD_CURRICULUM_FEEDBACK_SCHEMA_VERSION,
    curriculumSeed: curriculum.seed,
    scheduledScenarios: curriculum.scenarioCount,
    suppliedResults: results.length,
    validResults,
    invalidResults,
    missingResults: Math.max(0, curriculum.scenarioCount - results.length),
    axes,
    failureBoundary: Object.fromEntries(
      DISTURBANCE_AXES.map((axis) => [axis, axes[axis].failureBoundary]),
    ) as Record<DisturbanceAxis, number>,
    coverageGaps: Object.fromEntries(
      DISTURBANCE_AXES.map((axis) => [axis, axes[axis].coverageGap]),
    ) as Record<DisturbanceAxis, number>,
  };
}

export function generateNextCurriculum(input: {
  curriculum: ActiveWorldCurriculum;
  results: CurriculumScenarioResult[];
  nextSeed: string | number;
  count: number;
  feedbackOptions?: CurriculumFeedbackOptions;
  generatorOverrides?: Pick<CurriculumGeneratorOptions, "taskFamilies" | "difficulty">;
}) {
  const feedback = analyzeCurriculumFeedback(
    input.curriculum,
    input.results,
    input.feedbackOptions,
  );
  const curriculum = generateActiveWorldCurriculum({
    seed: input.nextSeed,
    count: input.count,
    promotionStage: input.curriculum.promotionStage,
    passedStages: input.curriculum.passedStages,
    failureBoundary: feedback.failureBoundary,
    coverageGaps: feedback.coverageGaps,
    ...input.generatorOverrides,
  });
  return { feedback, curriculum };
}

function analyzeAxis(
  axis: DisturbanceAxis,
  curriculum: ActiveWorldCurriculum,
  resultsByScenario: Map<string, CurriculumScenarioResult>,
  desiredValidResults: number,
  desiredDistinctSeeds: number,
): CurriculumAxisFeedback {
  const scheduled = curriculum.scenarios.filter((scenario) =>
    scenario.disturbances.some((disturbance) => disturbance.axis === axis));
  const valid = scheduled
    .map((scenario) => ({ scenario, result: resultsByScenario.get(scenario.id) }))
    .filter((entry): entry is { scenario: typeof scheduled[number]; result: CurriculumScenarioResult } =>
      entry.result !== undefined && entry.result.status !== "invalid");
  const seeds = new Set(valid.map(({ scenario }) => scenario.seed));
  const certifiedPasses = valid.filter(({ result }) => certifiedPass(result)).length;
  const recoveryFailures = valid.filter(({ result }) => result.recoveryOutcome === "failed").length;
  const safetyFailures = valid.filter(({ result }) =>
    result.wrongIrreversibleActions > 0 || result.outOfEnvelopeContacts > 0).length;
  const duplicateActions = valid.reduce(
    (sum, { result }) => sum + result.duplicateIrreversibleActions,
    0,
  );
  const taskDurationRatios = valid.flatMap(({ result }) => {
    if (result.elapsedMs === null || result.baselineElapsedMs === null || result.baselineElapsedMs <= 0) {
      return [];
    }
    return [result.elapsedMs / result.baselineElapsedMs];
  });
  const severities = valid.map(({ result }) => failureSeverity(result));
  const meanFailureSeverity = averageOrNull(severities);
  const evidenceConfidence = rounded(valid.length / (valid.length + 5));
  const validCoverage = clamp01(valid.length / desiredValidResults);
  const seedCoverage = clamp01(seeds.size / desiredDistinctSeeds);
  const scheduleCoverage = scheduled.length ? 1 : 0;
  const coverageGap = rounded(1 - (validCoverage * 0.6 + seedCoverage * 0.3 + scheduleCoverage * 0.1));
  return {
    axis,
    scheduledScenarios: scheduled.length,
    validResults: valid.length,
    distinctSeeds: seeds.size,
    certifiedPasses,
    certifiedSuccessRate: valid.length ? rounded(certifiedPasses / valid.length) : null,
    recoveryFailures,
    safetyFailures,
    duplicateActions,
    meanTaskDurationRatio: averageOrNull(taskDurationRatios),
    meanFailureSeverity,
    evidenceConfidence,
    failureBoundary: rounded((meanFailureSeverity ?? 0) * evidenceConfidence),
    coverageGap,
  };
}

function failureSeverity(result: CurriculumScenarioResult) {
  let severity = 0;
  if (result.status === "failed") severity = 0.8;
  if (!result.visualProof) severity = 1;
  if (result.recoveryOutcome === "failed") severity = Math.max(severity, 0.9);
  if (result.duplicateIrreversibleActions > 0 ||
      result.wrongIrreversibleActions > 0 ||
      result.outOfEnvelopeContacts > 0) {
    severity = 1;
  }
  if (result.elapsedMs !== null && result.baselineElapsedMs !== null && result.baselineElapsedMs > 0) {
    const ratio = result.elapsedMs / result.baselineElapsedMs;
    if (ratio > 1) severity = Math.max(severity, Math.min(0.7, 0.2 + (ratio - 1)));
  }
  return rounded(severity);
}

function certifiedPass(result: CurriculumScenarioResult) {
  return result.status === "passed" &&
    result.visualProof &&
    result.recoveryOutcome !== "failed" &&
    result.duplicateIrreversibleActions === 0 &&
    result.wrongIrreversibleActions === 0 &&
    result.outOfEnvelopeContacts === 0;
}

function validateResult(result: CurriculumScenarioResult) {
  if (!result || typeof result !== "object") throw new Error("Every result must be an object.");
  if (!result.scenarioId || !result.seed) throw new Error("Every result requires scenarioId and seed.");
  if (!["passed", "failed", "invalid"].includes(result.status)) {
    throw new Error(`Invalid result status for ${result.scenarioId}.`);
  }
  if (typeof result.visualProof !== "boolean") {
    throw new Error(`visualProof must be boolean for ${result.scenarioId}.`);
  }
  nullableNonNegative(result.elapsedMs, "elapsedMs", result.scenarioId);
  nullableNonNegative(result.baselineElapsedMs, "baselineElapsedMs", result.scenarioId);
  if (!["not_needed", "recovered", "failed"].includes(result.recoveryOutcome)) {
    throw new Error(`Invalid recoveryOutcome for ${result.scenarioId}.`);
  }
  for (const [name, value] of [
    ["duplicateIrreversibleActions", result.duplicateIrreversibleActions],
    ["wrongIrreversibleActions", result.wrongIrreversibleActions],
    ["outOfEnvelopeContacts", result.outOfEnvelopeContacts],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer for ${result.scenarioId}.`);
    }
  }
  if (!Array.isArray(result.failureCodes) || result.failureCodes.some((code) => typeof code !== "string")) {
    throw new Error(`failureCodes must be a string array for ${result.scenarioId}.`);
  }
}

function nullableNonNegative(value: number | null, name: string, scenarioId: string) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be null or non-negative for ${scenarioId}.`);
  }
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function averageOrNull(values: number[]) {
  return values.length
    ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
