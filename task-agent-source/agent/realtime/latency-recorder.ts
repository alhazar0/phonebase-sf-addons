export const RUNTIME_TIMING_SCHEMA_VERSION =
  "screenhand.runtime-timing.v1" as const;

export const RUNTIME_TIMING_SEGMENTS = [
  "frameTransport",
  "perception",
  "planning",
  "physicalMotion",
  "phoneAnimation",
  "verification",
  "recovery",
] as const;

export type RuntimeTimingSegment = (typeof RUNTIME_TIMING_SEGMENTS)[number];
export type RuntimeMetricKind = "interval" | "sample";

export type RuntimeMetric = {
  phase: string;
  label: string;
  startedAt: number;
  durationMs: number;
  kind?: RuntimeMetricKind;
  detail?: Record<string, unknown>;
};

export type RuntimeTimelineSummary = {
  measuredActiveMs: number;
  measuredIdleMs: number;
  longestIdleGapMs: number;
  idleGapsOver50Ms: number;
};

export type RuntimeDistribution = {
  count: number;
  totalMs: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maximumMs: number | null;
};

export type RuntimeTimingDecomposition = {
  schemaVersion: typeof RUNTIME_TIMING_SCHEMA_VERSION;
  segmentsMs: Record<RuntimeTimingSegment, number>;
  segmentSamples: Record<RuntimeTimingSegment, RuntimeDistribution>;
  categorizedTimelineMs: number;
  otherInstrumentedMs: number;
  intentionalWaitMs: number;
  unattributedMs: number;
  instrumentationCoverage: number;
  categorizedCoverage: number;
  longestUnattributedGapMs: number;
  unattributedGapsOver50Ms: number;
};

type DecisionEvidence = {
  at: number;
  label: string;
  detail?: Record<string, unknown>;
};

export class LatencyRecorder {
  private readonly startedAt: number;
  private readonly records: RuntimeMetric[] = [];
  private decisionEvidence: DecisionEvidence | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.now();
  }

  async measure<T>(
    phase: string,
    label: string,
    operation: () => Promise<T>,
    detail?: Record<string, unknown>,
  ) {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      this.pushInterval(phase, label, startedAt, this.now() - startedAt, detail);
    }
  }

  measureSync<T>(
    phase: string,
    label: string,
    operation: () => T,
    detail?: Record<string, unknown>,
  ) {
    const startedAt = this.now();
    try {
      return operation();
    } finally {
      this.pushInterval(phase, label, startedAt, this.now() - startedAt, detail);
    }
  }

  record(
    phase: string,
    label: string,
    durationMs: number,
    detail?: Record<string, unknown>,
  ) {
    const duration = finiteDuration(durationMs);
    this.pushInterval(phase, label, this.now() - duration, duration, detail);
  }

  recordSample(
    phase: string,
    label: string,
    durationMs: number,
    detail?: Record<string, unknown>,
  ) {
    this.records.push({
      phase,
      label,
      startedAt: Math.max(0, this.now() - this.startedAt),
      durationMs: finiteDuration(durationMs),
      kind: "sample",
      ...(detail ? { detail } : {}),
    });
  }

  markDecisionEvidence(label: string, detail?: Record<string, unknown>) {
    this.decisionEvidence = {
      at: this.now(),
      label,
      ...(detail ? { detail } : {}),
    };
  }

  recordDecision(label: string, detail?: Record<string, unknown>) {
    const evidence = this.decisionEvidence;
    this.decisionEvidence = null;
    if (!evidence) return null;
    const endedAt = this.now();
    const durationMs = finiteDuration(endedAt - evidence.at);
    this.pushInterval("planning", label, evidence.at, durationMs, {
      evidence: evidence.label,
      ...(evidence.detail ? { evidenceDetail: evidence.detail } : {}),
      ...(detail ?? {}),
    });
    return durationMs;
  }

  ingest(
    snapshot: { records: RuntimeMetric[] },
    absoluteStartedAt: number,
    labelPrefix = "nested",
  ) {
    for (const record of snapshot.records) {
      const detail = {
        nestedLabel: record.label,
        ...(record.detail ?? {}),
      };
      if (record.kind === "sample") {
        this.recordSample(
          record.phase,
          `${labelPrefix}:${record.label}`,
          record.durationMs,
          detail,
        );
        continue;
      }
      this.records.push({
        phase: record.phase,
        label: `${labelPrefix}:${record.label}`,
        startedAt: absoluteStartedAt - this.startedAt + record.startedAt,
        durationMs: finiteDuration(record.durationMs),
        kind: "interval",
        detail,
      });
    }
  }

  snapshot() {
    const totalMs = this.now() - this.startedAt;
    const byPhase: Record<string, {
      count: number;
      totalMs: number;
      averageMs: number;
      p95Ms: number;
    }> = {};
    for (const phase of new Set(this.records.map((record) => record.phase))) {
      const durations = this.records
        .filter((record) => record.phase === phase)
        .map((record) => record.durationMs)
        .sort((left, right) => left - right);
      const phaseTotalMs = durations.reduce((sum, duration) => sum + duration, 0);
      byPhase[phase] = {
        count: durations.length,
        totalMs: round(phaseTotalMs),
        averageMs: round(phaseTotalMs / durations.length),
        p95Ms: round(percentile(durations, 0.95) ?? 0),
      };
    }
    return {
      totalMs: round(totalMs),
      byPhase,
      timeline: summarizeRuntimeTimeline(this.records, totalMs),
      timing: decomposeRuntimeTiming(this.records, totalMs),
      records: this.records.map((record) => ({
        ...record,
        kind: record.kind ?? "interval",
        startedAt: round(record.startedAt),
        durationMs: round(record.durationMs),
      })),
    };
  }

  private pushInterval(
    phase: string,
    label: string,
    absoluteStartedAt: number,
    durationMs: number,
    detail?: Record<string, unknown>,
  ) {
    this.records.push({
      phase,
      label,
      startedAt: absoluteStartedAt - this.startedAt,
      durationMs: finiteDuration(durationMs),
      kind: "interval",
      ...(detail ? { detail } : {}),
    });
  }
}

export function summarizeRuntimeTimeline(
  records: RuntimeMetric[],
  totalMs: number,
): RuntimeTimelineSummary {
  const boundedTotal = Math.max(0, totalMs);
  const intervals = boundedIntervals(
    records.filter((record) => record.kind !== "sample"),
    boundedTotal,
  );
  const merged = mergeIntervals(intervals);
  const gaps = intervalGaps(merged, boundedTotal);
  const active = intervalTotal(merged);
  const idle = Math.max(0, boundedTotal - active);
  return {
    measuredActiveMs: round(active),
    measuredIdleMs: round(idle),
    longestIdleGapMs: round(gaps.length ? Math.max(...gaps) : 0),
    idleGapsOver50Ms: gaps.filter((gap) => gap > 50).length,
  };
}

export function decomposeRuntimeTiming(
  records: RuntimeMetric[],
  totalMs: number,
): RuntimeTimingDecomposition {
  const boundedTotal = Math.max(0, totalMs);
  const intervalRecords = records.filter((record) => record.kind !== "sample");
  const allIntervals = mergeIntervals(boundedIntervals(intervalRecords, boundedTotal));
  const categorizedRecords = intervalRecords.filter((record) => phaseSegment(record.phase));
  const categorizedIntervals = mergeIntervals(
    boundedIntervals(categorizedRecords, boundedTotal),
  );
  const intentionalRecords = intervalRecords.filter((record) => record.phase === "intentional_wait");
  const intentionalIntervals = mergeIntervals(
    boundedIntervals(intentionalRecords, boundedTotal),
  );
  const accountedIntervals = mergeIntervals([...categorizedIntervals, ...intentionalIntervals]);
  const unaccountedGaps = intervalGaps(accountedIntervals, boundedTotal);
  const categorizedTimelineMs = intervalTotal(categorizedIntervals);
  const allInstrumentedMs = intervalTotal(allIntervals);
  const intentionalWaitMs = intervalTotal(intentionalIntervals);
  const accountedMs = intervalTotal(accountedIntervals);

  const segmentsMs = Object.fromEntries(RUNTIME_TIMING_SEGMENTS.map((segment) => [
    segment,
    round(intervalTotal(mergeIntervals(boundedIntervals(
      categorizedRecords.filter((record) => phaseSegment(record.phase) === segment),
      boundedTotal,
    )))),
  ])) as Record<RuntimeTimingSegment, number>;

  const segmentSamples = Object.fromEntries(RUNTIME_TIMING_SEGMENTS.map((segment) => [
    segment,
    distribution(records
      .filter((record) => phaseSegment(record.phase) === segment)
      .map((record) => record.durationMs)),
  ])) as Record<RuntimeTimingSegment, RuntimeDistribution>;

  return {
    schemaVersion: RUNTIME_TIMING_SCHEMA_VERSION,
    segmentsMs,
    segmentSamples,
    categorizedTimelineMs: round(categorizedTimelineMs),
    otherInstrumentedMs: round(Math.max(0, allInstrumentedMs - categorizedTimelineMs)),
    intentionalWaitMs: round(intentionalWaitMs),
    unattributedMs: round(Math.max(0, boundedTotal - accountedMs)),
    instrumentationCoverage: ratio(allInstrumentedMs, boundedTotal),
    categorizedCoverage: ratio(accountedMs, boundedTotal),
    longestUnattributedGapMs: round(unaccountedGaps.length ? Math.max(...unaccountedGaps) : 0),
    unattributedGapsOver50Ms: unaccountedGaps.filter((gap) => gap > 50).length,
  };
}

function phaseSegment(phase: string): RuntimeTimingSegment | null {
  if (phase === "frame_transport" || phase === "transport") return "frameTransport";
  if (["perception", "ocr", "content", "perception_stream", "visual_servo"].includes(phase)) {
    return "perception";
  }
  if (phase === "planning" || phase === "decision") return "planning";
  if (phase === "physical_motion" || phase === "action") return "physicalMotion";
  if (phase === "phone_animation") return "phoneAnimation";
  if (phase === "verification") return "verification";
  if (phase === "recovery" || phase === "popup") return "recovery";
  return null;
}

function boundedIntervals(records: RuntimeMetric[], totalMs: number) {
  return records
    .map((record) => ({
      start: Math.max(0, Math.min(totalMs, record.startedAt)),
      end: Math.max(0, Math.min(totalMs, record.startedAt + record.durationMs)),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function mergeIntervals(intervals: Array<{ start: number; end: number }>) {
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }
  return merged;
}

function intervalGaps(intervals: Array<{ start: number; end: number }>, totalMs: number) {
  const gaps: number[] = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.start > cursor) gaps.push(interval.start - cursor);
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < totalMs) gaps.push(totalMs - cursor);
  return gaps;
}

function intervalTotal(intervals: Array<{ start: number; end: number }>) {
  return intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

function distribution(values: number[]): RuntimeDistribution {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    totalMs: round(totalMs),
    averageMs: sorted.length ? round(totalMs / sorted.length) : null,
    p50Ms: roundedNullable(percentile(sorted, 0.5)),
    p95Ms: roundedNullable(percentile(sorted, 0.95)),
    maximumMs: roundedNullable(sorted.at(-1) ?? null),
  };
}

function percentile(sorted: number[], quantile: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? null;
}

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return 1;
  return Math.round(Math.min(1, Math.max(0, numerator / denominator)) * 10_000) / 10_000;
}

function finiteDuration(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundedNullable(value: number | null) {
  return value === null ? null : round(value);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
