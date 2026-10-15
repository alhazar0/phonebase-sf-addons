import {
  RUNTIME_TIMING_SCHEMA_VERSION,
  RUNTIME_TIMING_SEGMENTS,
  type RuntimeTimingSegment,
} from "./latency-recorder";

const REQUIRED_ACTIVE_SEGMENTS: RuntimeTimingSegment[] = [
  "frameTransport",
  "perception",
  "planning",
  "physicalMotion",
  "phoneAnimation",
  "verification",
];

export type FastRuntimeEvidence = {
  id: string;
  status: string;
  totalMs: number;
  recoveries: number;
  frameTransportP95Ms: number | null;
  perceptionP95Ms: number | null;
  planningP95Ms: number | null;
  actionP95Ms: number | null;
  phoneAnimationP95Ms: number | null;
  verificationP95Ms: number | null;
  modelAverageMs: number | null;
  instrumentationCoverage: number | null;
  longestUnattributedGapMs: number | null;
  timingComplete: boolean;
  missingTimingSegments: RuntimeTimingSegment[];
};

export type FastRuntimeGateOptions = {
  requiredRuns?: number;
  maximumSuiteMs?: number;
  maximumFrameTransportP95Ms?: number;
  maximumPerceptionP95Ms?: number;
  maximumPlanningP95Ms?: number;
  maximumActionP95Ms?: number;
  maximumVerificationP95Ms?: number;
  maximumModelAverageMs?: number;
  maximumUnattributedGapMs?: number;
  minimumInstrumentationCoverage?: number;
};

export function evaluateFastRuntimeGate(
  evidence: FastRuntimeEvidence[],
  options: FastRuntimeGateOptions = {},
) {
  const requiredRuns = options.requiredRuns ?? 3;
  const maximumSuiteMs = options.maximumSuiteMs ?? 90_000;
  const maximumFrameTransportP95Ms = options.maximumFrameTransportP95Ms ?? 100;
  const maximumPerceptionP95Ms = options.maximumPerceptionP95Ms ?? 300;
  const maximumPlanningP95Ms = options.maximumPlanningP95Ms ?? 50;
  const maximumActionP95Ms = options.maximumActionP95Ms ?? 2_500;
  const maximumVerificationP95Ms = options.maximumVerificationP95Ms ?? 100;
  const maximumModelAverageMs = options.maximumModelAverageMs ?? 2_500;
  const maximumUnattributedGapMs = options.maximumUnattributedGapMs ?? 50;
  const minimumInstrumentationCoverage = options.minimumInstrumentationCoverage ?? 0.9;
  const blockers: string[] = [];
  if (evidence.length < requiredRuns) {
    blockers.push(`requires ${requiredRuns} runs; received ${evidence.length}`);
  }
  const selected = evidence.slice(0, requiredRuns);
  for (const run of selected) {
    if (run.status !== "completed") blockers.push(`${run.id}: status=${run.status}`);
    if (run.recoveries !== 0) blockers.push(`${run.id}: recoveries=${run.recoveries}`);
    if (!run.timingComplete) {
      blockers.push(
        `${run.id}: incomplete timing decomposition` +
        (run.missingTimingSegments.length
          ? ` (${run.missingTimingSegments.join(", ")})`
          : ""),
      );
    }
    maximumMetric(
      blockers,
      run.id,
      "frame transport P95",
      run.frameTransportP95Ms,
      maximumFrameTransportP95Ms,
    );
    maximumMetric(
      blockers,
      run.id,
      "perception P95",
      run.perceptionP95Ms,
      maximumPerceptionP95Ms,
    );
    maximumMetric(
      blockers,
      run.id,
      "planning P95",
      run.planningP95Ms,
      maximumPlanningP95Ms,
    );
    maximumMetric(blockers, run.id, "action P95", run.actionP95Ms, maximumActionP95Ms);
    maximumMetric(
      blockers,
      run.id,
      "verification P95",
      run.verificationP95Ms,
      maximumVerificationP95Ms,
    );
    if (
      run.modelAverageMs !== null &&
      run.modelAverageMs > maximumModelAverageMs
    ) blockers.push(`${run.id}: model average ${run.modelAverageMs}ms`);
    if (
      run.instrumentationCoverage === null ||
      run.instrumentationCoverage < minimumInstrumentationCoverage
    ) {
      blockers.push(
        `${run.id}: timing coverage ${formatNullable(run.instrumentationCoverage)} ` +
        `< ${minimumInstrumentationCoverage}`,
      );
    }
    maximumMetric(
      blockers,
      run.id,
      "unattributed gap",
      run.longestUnattributedGapMs,
      maximumUnattributedGapMs,
    );
  }
  const suiteMs = selected.reduce((sum, run) => sum + run.totalMs, 0);
  if (selected.length === requiredRuns && suiteMs > maximumSuiteMs) {
    blockers.push(`suite ${suiteMs}ms exceeds ${maximumSuiteMs}ms`);
  }
  return {
    passed: blockers.length === 0,
    suiteMs,
    requiredRuns,
    evaluatedRuns: selected.length,
    targets: {
      maximumSuiteMs,
      maximumFrameTransportP95Ms,
      maximumPerceptionP95Ms,
      maximumPlanningP95Ms,
      maximumActionP95Ms,
      maximumVerificationP95Ms,
      maximumModelAverageMs,
      maximumUnattributedGapMs,
      minimumInstrumentationCoverage,
      recoveries: 0,
      completeTimingDecomposition: true,
    },
    blockers,
  };
}

export function fastRuntimeEvidenceFromResult(value: unknown, id: string): FastRuntimeEvidence {
  const result = record(record(value).result ?? value);
  const metrics = record(result.metrics);
  const runtimeTiming = record(metrics.runtimeTiming);
  const byPhase = record(runtimeTiming.byPhase ?? metrics.byPhase);
  const timing = record(runtimeTiming.timing ?? metrics.timing);
  const segmentSamples = record(timing.segmentSamples);
  const segmentsMs = record(timing.segmentsMs);
  const skill = record(result.skill);
  const actionReceipts = Array.isArray(metrics.actionReceiptMs)
    ? metrics.actionReceiptMs.map(Number).filter(Number.isFinite)
    : [];
  const schemaMatches = timing.schemaVersion === RUNTIME_TIMING_SCHEMA_VERSION;
  const missingTimingSegments: RuntimeTimingSegment[] = REQUIRED_ACTIVE_SEGMENTS.filter(
    (segment) => !(segment in segmentsMs) ||
      !nonnegativeFinite(segmentsMs[segment]) ||
      sampleCount(segmentSamples, segment) < 1,
  );
  if (!("recovery" in segmentsMs) || !nonnegativeFinite(segmentsMs.recovery)) {
    missingTimingSegments.push("recovery");
  }
  return {
    id,
    status: String(result.status ?? "unknown"),
    totalMs: finite(metrics.totalMs),
    recoveries: finite(skill.recoveries ?? metrics.recoveries),
    frameTransportP95Ms: segmentP95(segmentSamples, "frameTransport"),
    perceptionP95Ms: segmentP95(segmentSamples, "perception") ??
      nullableFinite(record(byPhase.perception).p95Ms) ??
      nullableFinite(metrics.averageObservationMs),
    planningP95Ms: segmentP95(segmentSamples, "planning"),
    actionP95Ms: segmentP95(segmentSamples, "physicalMotion") ??
      nullableFinite(record(byPhase.action).p95Ms) ?? percentile95(actionReceipts),
    phoneAnimationP95Ms: segmentP95(segmentSamples, "phoneAnimation"),
    verificationP95Ms: segmentP95(segmentSamples, "verification"),
    modelAverageMs: nullableFinite(metrics.averageModelMs),
    instrumentationCoverage: nullableRatio(timing.instrumentationCoverage),
    longestUnattributedGapMs: nullableNonnegative(timing.longestUnattributedGapMs),
    timingComplete: schemaMatches && missingTimingSegments.length === 0,
    missingTimingSegments: schemaMatches
      ? missingTimingSegments
      : [...RUNTIME_TIMING_SEGMENTS],
  };
}

function segmentP95(samples: Record<string, unknown>, segment: RuntimeTimingSegment) {
  return nullableNonnegative(record(samples[segment]).p95Ms);
}

function sampleCount(samples: Record<string, unknown>, segment: RuntimeTimingSegment) {
  return finite(record(samples[segment]).count);
}

function maximumMetric(
  blockers: string[],
  id: string,
  label: string,
  actual: number | null,
  maximum: number,
) {
  if (actual === null) blockers.push(`${id}: ${label} missing`);
  else if (actual > maximum) blockers.push(`${id}: ${label} ${actual}ms`);
}

function percentile95(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null;
}

function nullableFinite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nullableNonnegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nullableRatio(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function nonnegativeFinite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatNullable(value: number | null) {
  return value === null ? "missing" : String(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
