import {
  DISTURBANCE_AXES,
  type CurriculumTaskFamily,
  type DisturbanceAxis,
  type PromotionStage,
} from "./curriculum";
import type { SemanticWorldReplayMetrics } from "./replay-evaluator";
import type { PromotionGateEvidence } from "./promotion-gate";

export const PHYSICAL_MOBILE_WORLD_SCHEMA_VERSION =
  "screenhand.physical-mobile-world.v1" as const;

export const BENCHMARK_TIMING_SEGMENTS = [
  "frameTransport",
  "perception",
  "planning",
  "physicalMotion",
  "phoneAnimation",
  "verification",
  "recovery",
] as const;

export type BenchmarkTimingSegment = (typeof BENCHMARK_TIMING_SEGMENTS)[number];

export type PhysicalMobileWorldRun = {
  schemaVersion: typeof PHYSICAL_MOBILE_WORLD_SCHEMA_VERSION;
  suiteId: string;
  runId: string;
  scenarioId: string;
  seed: string;
  startedAt: number;
  completedAt: number;
  heldOut: {
    device: boolean;
    application: boolean;
    wording: boolean;
  };
  device: {
    family: string;
    platform: "ios" | "android" | "other";
    aspectRatioClass: string;
    placementClass: string;
  };
  environment: {
    language: string;
    theme: "light" | "dark" | "high_contrast" | "other";
    applicationFamily: string;
    disturbances: DisturbanceAxis[];
  };
  task: {
    family: CurriculumTaskFamily;
    goalHash: string;
    sideEffectClass: "none" | "reversible" | "controlled";
  };
  executionContract: {
    cameraOnly: boolean;
    usedAdb: boolean;
    usedAccessibilityTree: boolean;
    usedPlatformApi: boolean;
    usedPerAppRoute: boolean;
  };
  outcome: {
    status: "passed" | "failed" | "cancelled" | "invalid";
    terminalStateVisuallyVerified: boolean;
    humanInterventions: number;
    duplicateIrreversibleActions: number;
    wrongIrreversibleActions: number;
    outOfEnvelopeContacts: number;
    sideEffectReceiptVerified: boolean;
  };
  recovery: {
    opportunities: number;
    successes: number;
  };
  reconnect: {
    attempts: number;
    successes: number;
  };
  timing: {
    avoidableIdleGapP95Ms: number;
    segmentsMs: Record<BenchmarkTimingSegment, number>;
  };
  targetCenterErrorsPixels: number[];
  evidence: {
    journalSha256: string;
    finalFrameSha256: string;
  };
};

export type PhysicalMobileWorldSoakSession = {
  sessionId: string;
  durationMs: number;
  humanInterventions: number;
  taskStateLosses: number;
  calibrationBoundaryLosses: number;
};

export type PhysicalMobileWorldRunAssessment = {
  runId: string;
  certified: boolean;
  durationMs: number;
  failures: string[];
};

export type DistributionSummary = {
  count: number;
  p50: number | null;
  p95: number | null;
  maximum: number | null;
};

export type PhysicalMobileWorldReport = {
  schemaVersion: typeof PHYSICAL_MOBILE_WORLD_SCHEMA_VERSION;
  suiteIds: string[];
  totalRuns: number;
  certifiedRuns: number;
  certifiedSuccessRate: number;
  visuallyVerifiedCompletionRate: number;
  allEvidenceHeldOut: boolean;
  distinctSeeds: number;
  taskDurationMs: DistributionSummary;
  avoidableIdleGapP95Ms: DistributionSummary;
  timingSegmentsMs: Record<BenchmarkTimingSegment, DistributionSummary>;
  duplicateIrreversibleActions: number;
  wrongIrreversibleActions: number;
  outOfEnvelopeContacts: number;
  humanInterventions: number;
  recoveryOpportunities: number;
  recoverySuccesses: number;
  autonomousRecoveryRate: number | null;
  reconnectAttempts: number;
  reconnectSuccesses: number;
  cameraReconnectSuccessRate: number | null;
  targetCenterErrorPixels: DistributionSummary;
  longestPassingSoakHours: number;
  coverage: {
    platforms: string[];
    deviceFamilies: string[];
    aspectRatioClasses: string[];
    placementClasses: string[];
    languages: string[];
    themes: string[];
    applicationFamilies: string[];
    taskFamilies: CurriculumTaskFamily[];
    disturbanceAxes: DisturbanceAxis[];
  };
  failureCounts: Record<string, number>;
  runs: PhysicalMobileWorldRunAssessment[];
};

export function evaluatePhysicalMobileWorld(
  runs: PhysicalMobileWorldRun[],
  soakSessions: PhysicalMobileWorldSoakSession[] = [],
): PhysicalMobileWorldReport {
  const ids = new Set<string>();
  const assessments = runs.map((run) => {
    validateRun(run);
    if (ids.has(run.runId)) throw new Error(`Duplicate benchmark runId: ${run.runId}.`);
    ids.add(run.runId);
    return assessRun(run);
  });
  for (const soak of soakSessions) validateSoakSession(soak);
  const certifiedRuns = assessments.filter((assessment) => assessment.certified).length;
  const failureCounts: Record<string, number> = {};
  for (const assessment of assessments) {
    for (const failure of assessment.failures) {
      failureCounts[failure] = (failureCounts[failure] ?? 0) + 1;
    }
  }
  const segmentSummaries = Object.fromEntries(BENCHMARK_TIMING_SEGMENTS.map((segment) => [
    segment,
    distribution(runs.map((run) => run.timing.segmentsMs[segment])),
  ])) as Record<BenchmarkTimingSegment, DistributionSummary>;
  const recoveryOpportunities = sum(runs, (run) => run.recovery.opportunities);
  const recoverySuccesses = sum(runs, (run) => run.recovery.successes);
  const reconnectAttempts = sum(runs, (run) => run.reconnect.attempts);
  const reconnectSuccesses = sum(runs, (run) => run.reconnect.successes);
  const passingSoakDurations = soakSessions
    .filter((session) => session.humanInterventions === 0 &&
      session.taskStateLosses === 0 && session.calibrationBoundaryLosses === 0)
    .map((session) => session.durationMs);
  return {
    schemaVersion: PHYSICAL_MOBILE_WORLD_SCHEMA_VERSION,
    suiteIds: uniqueSorted(runs.map((run) => run.suiteId)),
    totalRuns: runs.length,
    certifiedRuns,
    certifiedSuccessRate: rounded(certifiedRuns / Math.max(1, runs.length)),
    visuallyVerifiedCompletionRate: rounded(
      runs.filter((run) => run.outcome.status === "passed" &&
        run.outcome.terminalStateVisuallyVerified).length / Math.max(1, runs.length),
    ),
    allEvidenceHeldOut: runs.length > 0 && runs.every((run) =>
      run.heldOut.device && run.heldOut.application && run.heldOut.wording),
    distinctSeeds: new Set(runs.map((run) => run.seed)).size,
    taskDurationMs: distribution(assessments.map((assessment) => assessment.durationMs)),
    avoidableIdleGapP95Ms: distribution(runs.map((run) => run.timing.avoidableIdleGapP95Ms)),
    timingSegmentsMs: segmentSummaries,
    duplicateIrreversibleActions: sum(runs, (run) => run.outcome.duplicateIrreversibleActions),
    wrongIrreversibleActions: sum(runs, (run) => run.outcome.wrongIrreversibleActions),
    outOfEnvelopeContacts: sum(runs, (run) => run.outcome.outOfEnvelopeContacts),
    humanInterventions: sum(runs, (run) => run.outcome.humanInterventions),
    recoveryOpportunities,
    recoverySuccesses,
    autonomousRecoveryRate: ratioOrNull(recoverySuccesses, recoveryOpportunities),
    reconnectAttempts,
    reconnectSuccesses,
    cameraReconnectSuccessRate: ratioOrNull(reconnectSuccesses, reconnectAttempts),
    targetCenterErrorPixels: distribution(runs.flatMap((run) => run.targetCenterErrorsPixels)),
    longestPassingSoakHours: rounded((Math.max(0, ...passingSoakDurations)) / 3_600_000),
    coverage: {
      platforms: uniqueSorted(runs.map((run) => run.device.platform)),
      deviceFamilies: uniqueSorted(runs.map((run) => run.device.family)),
      aspectRatioClasses: uniqueSorted(runs.map((run) => run.device.aspectRatioClass)),
      placementClasses: uniqueSorted(runs.map((run) => run.device.placementClass)),
      languages: uniqueSorted(runs.map((run) => run.environment.language)),
      themes: uniqueSorted(runs.map((run) => run.environment.theme)),
      applicationFamilies: uniqueSorted(runs.map((run) => run.environment.applicationFamily)),
      taskFamilies: uniqueSorted(runs.map((run) => run.task.family)) as CurriculumTaskFamily[],
      disturbanceAxes: DISTURBANCE_AXES.filter((axis) =>
        runs.some((run) => run.environment.disturbances.includes(axis))),
    },
    failureCounts,
    runs: assessments,
  };
}

export function physicalWorldReportToPromotionEvidence(input: {
  report: PhysicalMobileWorldReport;
  stage: PromotionStage;
  passedStages: PromotionStage[];
  baselineSuccessRate: number;
  baselineTaskDurationP50Ms: number;
  replayMetrics?: SemanticWorldReplayMetrics;
}): PromotionGateEvidence {
  const durationP50 = input.report.taskDurationMs.p50;
  return {
    stage: input.stage,
    passedStages: input.passedStages,
    heldOut: input.report.allEvidenceHeldOut,
    evaluatedRuns: input.report.totalRuns,
    distinctSeeds: input.report.distinctSeeds,
    certifiedSuccessRate: input.report.certifiedSuccessRate,
    baselineSuccessRate: input.baselineSuccessRate,
    taskDurationRatioToBaseline: durationP50 !== null && input.baselineTaskDurationP50Ms > 0
      ? rounded(durationP50 / input.baselineTaskDurationP50Ms)
      : null,
    avoidableIdleGapP95Ms: input.report.avoidableIdleGapP95Ms.p95,
    duplicateIrreversibleActions: input.report.duplicateIrreversibleActions,
    wrongIrreversibleActions: input.report.wrongIrreversibleActions,
    outOfEnvelopeContacts: input.report.outOfEnvelopeContacts,
    autonomousRecoveryRate: input.report.autonomousRecoveryRate,
    disturbanceAxesCovered: input.report.coverage.disturbanceAxes,
    cameraReconnectSuccessRate: input.report.cameraReconnectSuccessRate,
    targetCenterErrorP95Pixels: input.report.targetCenterErrorPixels.p95,
    unattendedSoakHours: input.report.longestPassingSoakHours,
    replayMetrics: input.replayMetrics,
  };
}

function assessRun(run: PhysicalMobileWorldRun): PhysicalMobileWorldRunAssessment {
  const failures: string[] = [];
  if (!run.heldOut.device) failures.push("device_not_held_out");
  if (!run.heldOut.application) failures.push("application_not_held_out");
  if (!run.heldOut.wording) failures.push("wording_not_held_out");
  if (!run.executionContract.cameraOnly || run.executionContract.usedAdb ||
      run.executionContract.usedAccessibilityTree || run.executionContract.usedPlatformApi ||
      run.executionContract.usedPerAppRoute) {
    failures.push("camera_only_contract_violated");
  }
  if (run.outcome.status !== "passed") failures.push(`outcome_${run.outcome.status}`);
  if (!run.outcome.terminalStateVisuallyVerified) failures.push("terminal_state_unverified");
  if (run.outcome.humanInterventions > 0) failures.push("human_intervention");
  if (run.outcome.duplicateIrreversibleActions > 0) failures.push("duplicate_irreversible_action");
  if (run.outcome.wrongIrreversibleActions > 0) failures.push("wrong_irreversible_action");
  if (run.outcome.outOfEnvelopeContacts > 0) failures.push("out_of_envelope_contact");
  if (run.recovery.successes < run.recovery.opportunities) failures.push("recovery_incomplete");
  if (run.reconnect.successes < run.reconnect.attempts) failures.push("reconnect_failed");
  if (run.task.sideEffectClass === "controlled" && !run.outcome.sideEffectReceiptVerified) {
    failures.push("side_effect_receipt_unverified");
  }
  return {
    runId: run.runId,
    certified: failures.length === 0,
    durationMs: run.completedAt - run.startedAt,
    failures,
  };
}

function validateRun(run: PhysicalMobileWorldRun) {
  if (run.schemaVersion !== PHYSICAL_MOBILE_WORLD_SCHEMA_VERSION) {
    throw new Error(`Unsupported benchmark schema for run ${run.runId || "<unknown>"}.`);
  }
  for (const [name, value] of [
    ["suiteId", run.suiteId], ["runId", run.runId], ["scenarioId", run.scenarioId],
    ["seed", run.seed], ["device.family", run.device?.family],
    ["task.goalHash", run.task?.goalHash],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} cannot be empty.`);
  }
  if (!Number.isFinite(run.startedAt) || !Number.isFinite(run.completedAt) ||
      run.completedAt < run.startedAt) {
    throw new Error(`Invalid timestamps for run ${run.runId}.`);
  }
  const counters = [
    run.outcome.humanInterventions,
    run.outcome.duplicateIrreversibleActions,
    run.outcome.wrongIrreversibleActions,
    run.outcome.outOfEnvelopeContacts,
    run.recovery.opportunities,
    run.recovery.successes,
    run.reconnect.attempts,
    run.reconnect.successes,
  ];
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Run ${run.runId} contains an invalid counter.`);
  }
  if (run.recovery.successes > run.recovery.opportunities ||
      run.reconnect.successes > run.reconnect.attempts) {
    throw new Error(`Run ${run.runId} has more successes than opportunities.`);
  }
  const axes = run.environment.disturbances;
  if (!Array.isArray(axes) || axes.some((axis) => !DISTURBANCE_AXES.includes(axis))) {
    throw new Error(`Run ${run.runId} contains an unknown disturbance axis.`);
  }
  const timingValues = [
    run.timing.avoidableIdleGapP95Ms,
    ...BENCHMARK_TIMING_SEGMENTS.map((segment) => run.timing.segmentsMs[segment]),
    ...run.targetCenterErrorsPixels,
  ];
  if (timingValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`Run ${run.runId} contains an invalid timing or target-error value.`);
  }
  const sha256 = /^[a-f0-9]{64}$/i;
  if (!sha256.test(run.evidence.journalSha256) || !sha256.test(run.evidence.finalFrameSha256)) {
    throw new Error(`Run ${run.runId} requires SHA-256 journal and final-frame evidence.`);
  }
}

function validateSoakSession(session: PhysicalMobileWorldSoakSession) {
  if (!session.sessionId.trim() || !Number.isFinite(session.durationMs) || session.durationMs < 0) {
    throw new Error("Invalid soak session identity or duration.");
  }
  if ([session.humanInterventions, session.taskStateLosses, session.calibrationBoundaryLosses]
    .some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Soak session ${session.sessionId} contains an invalid counter.`);
  }
}

function distribution(values: number[]): DistributionSummary {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    maximum: sorted.at(-1) ?? null,
  };
}

function percentile(sorted: number[], percentileValue: number) {
  if (!sorted.length) return null;
  return rounded(sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]!);
}

function sum<T>(values: T[], select: (value: T) => number) {
  return values.reduce((total, value) => total + select(value), 0);
}

function ratioOrNull(numerator: number, denominator: number) {
  return denominator > 0 ? rounded(numerator / denominator) : null;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
