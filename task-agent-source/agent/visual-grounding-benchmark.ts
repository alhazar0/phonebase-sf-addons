import type {
  VisualAffordance,
  VisualAffordanceRole,
  VisualAffordanceSymbol,
} from "./visual-affordance-detector";
import { detectVisualAffordances } from "./visual-affordance-detector";

export type VisualGroundingTarget = {
  id: string;
  role: "icon" | "control";
  symbol?: VisualAffordanceSymbol;
  hitArea: { left: number; top: number; width: number; height: number };
};

export type VisualGroundingFixture = {
  id: string;
  image: Buffer;
  viewport: { width: number; height: number };
  targets: VisualGroundingTarget[];
  excludeBounds?: Array<{ left: number; top: number; width: number; height: number }>;
};

export type VisualGroundingReport = {
  fixtureCount: number;
  targetCount: number;
  targetHits: number;
  targetHitRate: number;
  candidateCount: number;
  candidateHits: number;
  candidatePrecision: number;
  latencyMs: { p50: number; p95: number; maximum: number };
  fixtures: Array<{
    id: string;
    targets: number;
    targetHits: number;
    candidates: number;
    candidateHits: number;
    elapsedMs: number;
  }>;
  gate: {
    minimumTargetHitRate: number;
    minimumCandidatePrecision: number;
    maximumP95Ms: number;
    passed: boolean;
    blockers: string[];
  };
};

export async function evaluateVisualGrounding(
  fixtures: VisualGroundingFixture[],
  options: {
    minimumTargetHitRate?: number;
    minimumCandidatePrecision?: number;
    maximumP95Ms?: number;
  } = {},
): Promise<VisualGroundingReport> {
  const minimumTargetHitRate = boundedRatio(options.minimumTargetHitRate, 0.9);
  const minimumCandidatePrecision = boundedRatio(options.minimumCandidatePrecision, 0.65);
  const maximumP95Ms = boundedPositive(options.maximumP95Ms, 300);
  const fixtureResults = [];
  const latencies: number[] = [];
  let targetCount = 0;
  let targetHits = 0;
  let candidateCount = 0;
  let candidateHits = 0;
  for (const fixture of fixtures) {
    const detection = await detectVisualAffordances(fixture.image, {
      viewport: fixture.viewport,
      excludeBounds: fixture.excludeBounds,
    });
    const hits = fixture.targets.filter((target) =>
      detection.candidates.some((candidate) => candidateHitsTarget(candidate, target))
    ).length;
    const groundedCandidates = detection.candidates.filter((candidate) =>
      fixture.targets.some((target) => candidateHitsTarget(candidate, target))
    ).length;
    targetCount += fixture.targets.length;
    targetHits += hits;
    candidateCount += detection.candidates.length;
    candidateHits += groundedCandidates;
    latencies.push(detection.elapsedMs);
    fixtureResults.push({
      id: fixture.id,
      targets: fixture.targets.length,
      targetHits: hits,
      candidates: detection.candidates.length,
      candidateHits: groundedCandidates,
      elapsedMs: detection.elapsedMs,
    });
  }
  const targetHitRate = ratio(targetHits, targetCount);
  const candidatePrecision = ratio(candidateHits, candidateCount);
  const p95 = percentile(latencies, 0.95);
  const blockers: string[] = [];
  if (targetHitRate < minimumTargetHitRate) {
    blockers.push(`target hit rate ${targetHitRate} is below ${minimumTargetHitRate}`);
  }
  if (candidatePrecision < minimumCandidatePrecision) {
    blockers.push(`candidate precision ${candidatePrecision} is below ${minimumCandidatePrecision}`);
  }
  if (p95 > maximumP95Ms) blockers.push(`P95 ${p95} ms exceeds ${maximumP95Ms} ms`);
  return {
    fixtureCount: fixtures.length,
    targetCount,
    targetHits,
    targetHitRate,
    candidateCount,
    candidateHits,
    candidatePrecision,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95,
      maximum: latencies.length ? Math.max(...latencies) : 0,
    },
    fixtures: fixtureResults,
    gate: {
      minimumTargetHitRate,
      minimumCandidatePrecision,
      maximumP95Ms,
      passed: blockers.length === 0,
      blockers,
    },
  };
}

function candidateHitsTarget(
  candidate: VisualAffordance,
  target: VisualGroundingTarget,
) {
  return roleCompatible(candidate.role, target.role) &&
    (!target.symbol || candidate.symbol === target.symbol) &&
    candidate.center.x >= target.hitArea.left &&
    candidate.center.x <= target.hitArea.left + target.hitArea.width &&
    candidate.center.y >= target.hitArea.top &&
    candidate.center.y <= target.hitArea.top + target.hitArea.height;
}

function roleCompatible(candidate: VisualAffordanceRole, target: VisualGroundingTarget["role"]) {
  return target === "icon"
    ? candidate === "icon" || candidate === "navigation"
    : candidate === "control";
}

function ratio(numerator: number, denominator: number) {
  return denominator ? round(numerator / denominator) : 0;
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return round(sorted[index]);
}

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : fallback;
}

function boundedPositive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Number(value)) : fallback;
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
