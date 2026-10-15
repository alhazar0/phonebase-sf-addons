import type { ActiveWorldJournalRecord, ActiveWorldSpeculativeHoverReason } from "./types";

export const SPECULATIVE_HOVER_REPLAY_SCHEMA_VERSION =
  "screenhand.active-world.speculative-hover-replay.v1" as const;

const MINIMUM_ELIGIBLE_DECISIONS = 100;
const MINIMUM_PHYSICAL_DEVICES = 3;
const MINIMUM_TARGET_PRECISION = 0.99;
const MAXIMUM_TARGET_ERROR_P95_PIXELS = 8;
const MINIMUM_LEAD_TIME_P50_MS = 150;
const MINIMUM_USEFUL_DECISION_RATE = 0.95;

export type SpeculativeHoverReplaySource = {
  sourceId: string;
  physicalDeviceKey: string;
  split: "development" | "holdout";
  usedForTuning: boolean;
  records: ActiveWorldJournalRecord[];
};

export type SpeculativeHoverReplayTrial = {
  sourceId: string;
  runId: string;
  physicalDeviceKey: string;
  decisionSequence: number;
  decisionAt: number;
  label: string;
  status: "matched" | "unmatched" | "invalid";
  reason:
    | "matched"
    | "next-action-mismatch"
    | "superseded-before-action"
    | "run-ended-before-action"
    | "no-following-action"
    | "candidate-invalid"
    | "actual-action-invalid"
    | "action-start-precedes-decision";
  actionSequence: number | null;
  leadTimeMs: number | null;
  targetErrorPixels: number | null;
  accurateTarget: boolean;
  usefulLead: boolean;
};

export type SpeculativeHoverReplayReport = {
  schemaVersion: typeof SPECULATIVE_HOVER_REPLAY_SCHEMA_VERSION;
  sourceCount: number;
  runCount: number;
  physicalDevices: number;
  allEvidenceHeldOut: boolean;
  decisions: number;
  scoredDecisions: number;
  dryRunDecisions: number;
  dryRunEligibleDecisions: number;
  eligibleDecisions: number;
  rejectedDecisions: number;
  rejectionReasons: Partial<Record<ActiveWorldSpeculativeHoverReason, number>>;
  matchedActions: number;
  unmatchedDecisions: number;
  invalidDecisions: number;
  accurateTargets: number;
  targetPrecision: number;
  usefulDecisions: number;
  usefulDecisionRate: number;
  targetErrorPixels: Distribution;
  leadTimeMs: Distribution;
  trials: SpeculativeHoverReplayTrial[];
  gate: {
    passed: boolean;
    reversiblePhysicalTrialEligible: boolean;
    wouldEnableHardware: false;
    checks: Array<{
      code: string;
      passed: boolean;
      actual: number | boolean | null;
      required: number | boolean | string;
    }>;
    blockers: string[];
  };
};

type Distribution = {
  count: number;
  p50: number | null;
  p95: number | null;
  maximum: number | null;
};

/**
 * Scores Shadow pre-hover decisions against the next action that actually ran.
 * Passing only permits a later reversible physical trial; this evaluator has
 * no motor client and never authorizes production movement.
 */
export function evaluateSpeculativeHoverReplay(
  sources: SpeculativeHoverReplaySource[],
): SpeculativeHoverReplayReport {
  validateSources(sources);
  const trials: SpeculativeHoverReplayTrial[] = [];
  const rejectionReasons: SpeculativeHoverReplayReport["rejectionReasons"] = {};
  let decisions = 0;
  let scoredDecisions = 0;
  let dryRunDecisions = 0;
  let dryRunEligibleDecisions = 0;
  let eligibleDecisions = 0;

  for (const source of sources) {
    const start = runStartFor(source);
    const runId = start.runId;
    for (let index = 0; index < source.records.length; index += 1) {
      const record = source.records[index];
      if (record.event.type !== "speculative_hover") continue;
      decisions += 1;
      const decision = record.event.decision;
      if (start.mode === "dry_run") {
        dryRunDecisions += 1;
        if (decision.eligible) dryRunEligibleDecisions += 1;
        continue;
      }
      scoredDecisions += 1;
      if (!decision.eligible) {
        rejectionReasons[decision.reason] = (rejectionReasons[decision.reason] ?? 0) + 1;
        continue;
      }
      eligibleDecisions += 1;
      trials.push(matchDecision(source, runId, record, index));
    }
  }

  const matched = trials.filter((trial) => trial.status === "matched");
  const invalid = trials.filter((trial) => trial.status === "invalid");
  const unmatched = trials.filter((trial) => trial.status === "unmatched");
  const accurateTargets = matched.filter((trial) => trial.accurateTarget).length;
  const usefulDecisions = matched.filter((trial) => trial.usefulLead).length;
  const targetPrecision = ratio(accurateTargets, eligibleDecisions);
  const usefulDecisionRate = ratio(usefulDecisions, eligibleDecisions);
  const targetErrorPixels = distribution(matched.flatMap((trial) =>
    trial.targetErrorPixels === null ? [] : [trial.targetErrorPixels]
  ));
  const leadTimeMs = distribution(matched.flatMap((trial) =>
    trial.leadTimeMs === null ? [] : [trial.leadTimeMs]
  ));
  const allEvidenceHeldOut = sources.length > 0 && sources.every((source) =>
    source.split === "holdout" && !source.usedForTuning
  );
  const physicalDevices = new Set(sources.map((source) => source.physicalDeviceKey)).size;
  const checks = [
    exact("held_out_evidence", allEvidenceHeldOut, true),
    minimum("eligible_decisions", eligibleDecisions, MINIMUM_ELIGIBLE_DECISIONS),
    minimum("physical_devices", physicalDevices, MINIMUM_PHYSICAL_DEVICES),
    exact("invalid_decisions", invalid.length, 0),
    exact("unmatched_decisions", unmatched.length, 0),
    minimum("target_precision", targetPrecision, MINIMUM_TARGET_PRECISION),
    maximum(
      "target_error_p95_pixels",
      targetErrorPixels.p95,
      MAXIMUM_TARGET_ERROR_P95_PIXELS,
    ),
    minimum("lead_time_p50_ms", leadTimeMs.p50, MINIMUM_LEAD_TIME_P50_MS),
    minimum("useful_decision_rate", usefulDecisionRate, MINIMUM_USEFUL_DECISION_RATE),
  ];
  const blockers = checks.filter((check) => !check.passed).map((check) => check.code);
  return {
    schemaVersion: SPECULATIVE_HOVER_REPLAY_SCHEMA_VERSION,
    sourceCount: sources.length,
    runCount: new Set(sources.map((source) => runIdFor(source))).size,
    physicalDevices,
    allEvidenceHeldOut,
    decisions,
    scoredDecisions,
    dryRunDecisions,
    dryRunEligibleDecisions,
    eligibleDecisions,
    rejectedDecisions: scoredDecisions - eligibleDecisions,
    rejectionReasons,
    matchedActions: matched.length,
    unmatchedDecisions: unmatched.length,
    invalidDecisions: invalid.length,
    accurateTargets,
    targetPrecision,
    usefulDecisions,
    usefulDecisionRate,
    targetErrorPixels,
    leadTimeMs,
    trials,
    gate: {
      passed: blockers.length === 0,
      reversiblePhysicalTrialEligible: blockers.length === 0,
      wouldEnableHardware: false,
      checks,
      blockers,
    },
  };
}

function matchDecision(
  source: SpeculativeHoverReplaySource,
  runId: string,
  decisionRecord: ActiveWorldJournalRecord,
  decisionIndex: number,
): SpeculativeHoverReplayTrial {
  if (decisionRecord.event.type !== "speculative_hover") {
    throw new Error("Internal replay error: decision record type changed.");
  }
  const decision = decisionRecord.event.decision;
  const base = {
    sourceId: source.sourceId,
    runId,
    physicalDeviceKey: source.physicalDeviceKey,
    decisionSequence: decisionRecord.sequence,
    decisionAt: decision.evaluatedAt,
    label: decision.label,
  };
  const end = (
    status: SpeculativeHoverReplayTrial["status"],
    reason: SpeculativeHoverReplayTrial["reason"],
  ): SpeculativeHoverReplayTrial => ({
    ...base,
    status,
    reason,
    actionSequence: null,
    leadTimeMs: null,
    targetErrorPixels: null,
    accurateTarget: false,
    usefulLead: false,
  });

  if (!validCandidate(decision)) return end("invalid", "candidate-invalid");
  for (let index = decisionIndex + 1; index < source.records.length; index += 1) {
    const record = source.records[index];
    if (record.event.type === "speculative_hover") {
      return end("unmatched", "superseded-before-action");
    }
    if (record.event.type === "run_finished") {
      return end("unmatched", "run-ended-before-action");
    }
    if (record.event.type !== "action_started") continue;
    const actual = record.event.action;
    if (
      actual.label !== decision.label ||
      decision.actionType !== "tap" ||
      actual.action.type !== "tap"
    ) return end("unmatched", "next-action-mismatch");
    if (!validTap(actual.action)) return end("invalid", "actual-action-invalid");
    const leadTimeMs = actual.startedAt - decision.evaluatedAt;
    if (!Number.isFinite(leadTimeMs) || leadTimeMs < 0) {
      return end("invalid", "action-start-precedes-decision");
    }
    const candidate = decision.candidate!;
    const actualNormalized = {
      x: actual.action.point.x / actual.action.viewport.width,
      y: actual.action.point.y / actual.action.viewport.height,
    };
    const targetErrorPixels = Math.hypot(
      (candidate.normalizedPoint.x - actualNormalized.x) * candidate.viewport.width,
      (candidate.normalizedPoint.y - actualNormalized.y) * candidate.viewport.height,
    );
    const accurateTarget = targetErrorPixels <= MAXIMUM_TARGET_ERROR_P95_PIXELS;
    return {
      ...base,
      status: "matched",
      reason: "matched",
      actionSequence: record.sequence,
      leadTimeMs: rounded(leadTimeMs),
      targetErrorPixels: rounded(targetErrorPixels),
      accurateTarget,
      usefulLead: accurateTarget && leadTimeMs >= MINIMUM_LEAD_TIME_P50_MS,
    };
  }
  return end("unmatched", "no-following-action");
}

function validCandidate(
  decision: Extract<ActiveWorldJournalRecord["event"], { type: "speculative_hover" }>["decision"],
) {
  const candidate = decision.candidate;
  if (
    decision.mode !== "shadow" || decision.wouldMoveHardware !== false ||
    !candidate || decision.actionType !== "tap" ||
    !validViewport(candidate.viewport) || !validPoint(candidate.point, candidate.viewport) ||
    !finite(candidate.normalizedPoint.x) || !finite(candidate.normalizedPoint.y) ||
    candidate.normalizedPoint.x < 0 || candidate.normalizedPoint.x > 1 ||
    candidate.normalizedPoint.y < 0 || candidate.normalizedPoint.y > 1
  ) return false;
  const expected = {
    x: candidate.point.x / candidate.viewport.width,
    y: candidate.point.y / candidate.viewport.height,
  };
  return Math.abs(expected.x - candidate.normalizedPoint.x) <= 0.001 &&
    Math.abs(expected.y - candidate.normalizedPoint.y) <= 0.001;
}

function validTap(action: Extract<
  Extract<ActiveWorldJournalRecord["event"], { type: "action_started" }>["action"]["action"],
  { type: "tap" }
>) {
  return validViewport(action.viewport) && validPoint(action.point, action.viewport) &&
    Number.isInteger(action.frameSequence) && action.frameSequence >= 0;
}

function validViewport(viewport: { width: number; height: number }) {
  return finite(viewport.width) && finite(viewport.height) &&
    viewport.width > 0 && viewport.height > 0;
}

function validPoint(point: { x: number; y: number }, viewport: { width: number; height: number }) {
  return finite(point.x) && finite(point.y) && point.x >= 0 && point.x <= viewport.width &&
    point.y >= 0 && point.y <= viewport.height;
}

function validateSources(sources: SpeculativeHoverReplaySource[]) {
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error("Speculative-hover replay requires at least one journal source.");
  }
  const sourceIds = new Set<string>();
  const runIds = new Set<string>();
  for (const source of sources) {
    if (!source.sourceId.trim() || !source.physicalDeviceKey.trim()) {
      throw new Error("Replay source and physical device identities cannot be empty.");
    }
    if (sourceIds.has(source.sourceId)) throw new Error(`Duplicate sourceId ${source.sourceId}.`);
    sourceIds.add(source.sourceId);
    if (!Array.isArray(source.records) || !source.records.length) {
      throw new Error(`Replay source ${source.sourceId} is empty.`);
    }
    const starts = source.records.filter((record) => record.event.type === "run_started");
    if (starts.length !== 1) {
      throw new Error(`Replay source ${source.sourceId} must contain exactly one run_started.`);
    }
    const runId = starts[0].event.runId;
    if (runIds.has(runId)) throw new Error(`Duplicate replay runId ${runId}.`);
    runIds.add(runId);
    let expectedSequence = 1;
    for (const record of source.records) {
      if (record.sequence !== expectedSequence) {
        throw new Error(`Replay source ${source.sourceId} has a discontinuous sequence.`);
      }
      if ("runId" in record.event && record.event.runId !== runId) {
        throw new Error(`Replay source ${source.sourceId} mixes run identities.`);
      }
      expectedSequence += 1;
    }
    if (source.split === "holdout" && source.usedForTuning) {
      throw new Error(`Holdout source ${source.sourceId} cannot be used for tuning.`);
    }
  }
}

function runIdFor(source: SpeculativeHoverReplaySource) {
  return runStartFor(source).runId;
}

function runStartFor(source: SpeculativeHoverReplaySource) {
  const event = source.records.find((record) => record.event.type === "run_started")!.event;
  if (event.type !== "run_started") throw new Error("Validated replay source lost run_started.");
  return event;
}

function distribution(values: number[]): Distribution {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    maximum: sorted.length ? rounded(sorted[sorted.length - 1]) : null,
  };
}

function percentile(sorted: number[], quantile: number) {
  if (!sorted.length) return null;
  return rounded(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]);
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? rounded(numerator / denominator) : 0;
}

function exact(code: string, actual: number | boolean, required: number | boolean) {
  return { code, passed: actual === required, actual, required };
}

function minimum(code: string, actual: number | null, required: number) {
  return {
    code,
    passed: actual !== null && Number.isFinite(actual) && actual >= required,
    actual,
    required,
  };
}

function maximum(code: string, actual: number | null, required: number) {
  return {
    code,
    passed: actual !== null && Number.isFinite(actual) && actual <= required,
    actual,
    required,
  };
}

function finite(value: number) {
  return Number.isFinite(value);
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
