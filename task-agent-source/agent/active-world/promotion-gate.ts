import type { SemanticWorldReplayMetrics } from "./replay-evaluator";
import {
  DISTURBANCE_AXES,
  PROMOTION_STAGES,
  promotionStagePrerequisites,
  type DisturbanceAxis,
  type PromotionStage,
} from "./curriculum";

export const ACTIVE_WORLD_PROMOTION_GATE_SCHEMA_VERSION =
  "screenhand.active-world.promotion-gate.v1" as const;

export type PromotionGateEvidence = {
  stage: PromotionStage;
  passedStages: PromotionStage[];
  heldOut: boolean;
  evaluatedRuns: number;
  distinctSeeds: number;
  certifiedSuccessRate: number;
  baselineSuccessRate: number;
  taskDurationRatioToBaseline: number | null;
  avoidableIdleGapP95Ms: number | null;
  duplicateIrreversibleActions: number;
  wrongIrreversibleActions: number;
  outOfEnvelopeContacts: number;
  autonomousRecoveryRate: number | null;
  disturbanceAxesCovered: DisturbanceAxis[];
  cameraReconnectSuccessRate?: number | null;
  targetCenterErrorP95Pixels?: number | null;
  unattendedSoakHours?: number | null;
  replayMetrics?: SemanticWorldReplayMetrics;
};

export type PromotionGateStagePolicy = {
  minimumRuns: number;
  minimumDistinctSeeds: number;
  minimumCertifiedSuccessRate: number;
  maximumSuccessRegression: number;
  maximumTaskDurationRatio: number;
  maximumAvoidableIdleGapP95Ms: number;
  minimumAutonomousRecoveryRate: number;
  requiredDisturbanceAxes: DisturbanceAxis[];
  minimumCameraReconnectSuccessRate?: number;
  maximumTargetCenterErrorP95Pixels?: number;
  minimumUnattendedSoakHours?: number;
  replay?: {
    minimumTrainTransitions: number;
    minimumTestTransitions: number;
    minimumCoverage: number;
    maximumSuccessBrierScore: number;
    minimumNextScreenTop3: number;
    minimumCriticAccuracy: number;
    maximumCriticFalseAcceptRate: number;
  };
};

export type PromotionGatePolicy = Record<PromotionStage, PromotionGateStagePolicy>;

export type PromotionGateCheck = {
  code: string;
  passed: boolean;
  actual: number | boolean | string[] | null;
  required: number | boolean | string;
};

export type PromotionGateDecision = {
  schemaVersion: typeof ACTIVE_WORLD_PROMOTION_GATE_SCHEMA_VERSION;
  stage: PromotionStage;
  passed: boolean;
  checks: PromotionGateCheck[];
  blockers: string[];
};

const COMMON_POLICY = {
  minimumCertifiedSuccessRate: 0.95,
  maximumSuccessRegression: 0,
  maximumTaskDurationRatio: 1,
  maximumAvoidableIdleGapP95Ms: 50,
  minimumAutonomousRecoveryRate: 0.9,
  requiredDisturbanceAxes: [...DISTURBANCE_AXES],
};

export const DEFAULT_PROMOTION_GATE_POLICY: PromotionGatePolicy = {
  simulator: {
    ...COMMON_POLICY,
    minimumRuns: 500,
    minimumDistinctSeeds: 10,
  },
  replay: {
    ...COMMON_POLICY,
    minimumRuns: 200,
    minimumDistinctSeeds: 10,
    replay: {
      minimumTrainTransitions: 500,
      minimumTestTransitions: 100,
      minimumCoverage: 0.8,
      maximumSuccessBrierScore: 0.15,
      minimumNextScreenTop3: 0.9,
      minimumCriticAccuracy: 0.95,
      maximumCriticFalseAcceptRate: 0.01,
    },
  },
  reversible_physical: {
    ...COMMON_POLICY,
    minimumRuns: 100,
    minimumDistinctSeeds: 10,
    minimumCameraReconnectSuccessRate: 0.95,
    maximumTargetCenterErrorP95Pixels: 8,
  },
  controlled_side_effect: {
    ...COMMON_POLICY,
    minimumRuns: 500,
    minimumDistinctSeeds: 20,
    minimumCameraReconnectSuccessRate: 0.99,
    maximumTargetCenterErrorP95Pixels: 8,
    minimumUnattendedSoakHours: 8,
  },
};

export function evaluatePromotionGate(
  evidence: PromotionGateEvidence,
  policy: PromotionGatePolicy = DEFAULT_PROMOTION_GATE_POLICY,
): PromotionGateDecision {
  const stagePolicy = policy[evidence.stage];
  if (!stagePolicy) throw new Error(`No promotion policy for stage ${evidence.stage}.`);
  const checks: PromotionGateCheck[] = [
    requiredStages(evidence.passedStages, promotionStagePrerequisites(evidence.stage)),
    exact("held_out_evidence", evidence.heldOut, true),
    minimum("evaluated_runs", evidence.evaluatedRuns, stagePolicy.minimumRuns),
    minimum("distinct_seeds", evidence.distinctSeeds, stagePolicy.minimumDistinctSeeds),
    minimum(
      "certified_success_rate",
      evidence.certifiedSuccessRate,
      stagePolicy.minimumCertifiedSuccessRate,
    ),
    minimum(
      "success_delta_vs_baseline",
      safeDifference(evidence.certifiedSuccessRate, evidence.baselineSuccessRate),
      -stagePolicy.maximumSuccessRegression,
    ),
    maximum(
      "task_duration_ratio_vs_baseline",
      evidence.taskDurationRatioToBaseline,
      stagePolicy.maximumTaskDurationRatio,
    ),
    maximum(
      "avoidable_idle_gap_p95_ms",
      evidence.avoidableIdleGapP95Ms,
      stagePolicy.maximumAvoidableIdleGapP95Ms,
    ),
    exact("duplicate_irreversible_actions", evidence.duplicateIrreversibleActions, 0),
    exact("wrong_irreversible_actions", evidence.wrongIrreversibleActions, 0),
    exact("out_of_envelope_contacts", evidence.outOfEnvelopeContacts, 0),
    minimum(
      "autonomous_recovery_rate",
      evidence.autonomousRecoveryRate,
      stagePolicy.minimumAutonomousRecoveryRate,
    ),
    requiredAxes(evidence.disturbanceAxesCovered, stagePolicy.requiredDisturbanceAxes),
  ];

  if (stagePolicy.minimumCameraReconnectSuccessRate !== undefined) {
    checks.push(minimum(
      "camera_reconnect_success_rate",
      evidence.cameraReconnectSuccessRate,
      stagePolicy.minimumCameraReconnectSuccessRate,
    ));
  }
  if (stagePolicy.maximumTargetCenterErrorP95Pixels !== undefined) {
    checks.push(maximum(
      "target_center_error_p95_pixels",
      evidence.targetCenterErrorP95Pixels,
      stagePolicy.maximumTargetCenterErrorP95Pixels,
    ));
  }
  if (stagePolicy.minimumUnattendedSoakHours !== undefined) {
    checks.push(minimum(
      "unattended_soak_hours",
      evidence.unattendedSoakHours,
      stagePolicy.minimumUnattendedSoakHours,
    ));
  }
  if (stagePolicy.replay) {
    checks.push(...replayChecks(evidence.replayMetrics, stagePolicy.replay));
  }
  const blockers = checks.filter((check) => !check.passed).map((check) => check.code);
  return {
    schemaVersion: ACTIVE_WORLD_PROMOTION_GATE_SCHEMA_VERSION,
    stage: evidence.stage,
    passed: blockers.length === 0,
    checks,
    blockers,
  };
}

function replayChecks(
  metrics: SemanticWorldReplayMetrics | undefined,
  policy: NonNullable<PromotionGateStagePolicy["replay"]>,
) {
  return [
    minimum("replay_train_transitions", metrics?.trainTransitions, policy.minimumTrainTransitions),
    minimum("replay_test_transitions", metrics?.testTransitions, policy.minimumTestTransitions),
    minimum("replay_coverage", metrics?.coverage, policy.minimumCoverage),
    maximum("replay_success_brier", metrics?.successBrierScore, policy.maximumSuccessBrierScore),
    minimum("replay_next_screen_top3", metrics?.nextScreenTop3, policy.minimumNextScreenTop3),
    minimum("replay_critic_accuracy", metrics?.criticAccuracy, policy.minimumCriticAccuracy),
    maximum(
      "replay_critic_false_accept_rate",
      metrics?.criticFalseAcceptRate,
      policy.maximumCriticFalseAcceptRate,
    ),
  ];
}

function minimum(code: string, actual: number | null | undefined, required: number): PromotionGateCheck {
  return {
    code,
    passed: typeof actual === "number" && Number.isFinite(actual) && actual >= required,
    actual: finiteOrNull(actual),
    required,
  };
}

function maximum(code: string, actual: number | null | undefined, required: number): PromotionGateCheck {
  return {
    code,
    passed: typeof actual === "number" && Number.isFinite(actual) && actual <= required,
    actual: finiteOrNull(actual),
    required,
  };
}

function exact(
  code: string,
  actual: number | boolean | null | undefined,
  required: number | boolean,
): PromotionGateCheck {
  return {
    code,
    passed: actual === required,
    actual: typeof actual === "number" && !Number.isFinite(actual) ? null : actual ?? null,
    required,
  };
}

function requiredAxes(
  actual: DisturbanceAxis[] | undefined,
  required: DisturbanceAxis[],
): PromotionGateCheck {
  const unique = [...new Set(Array.isArray(actual) ? actual : [])]
    .filter((axis) => DISTURBANCE_AXES.includes(axis))
    .sort();
  const missing = required.filter((axis) => !unique.includes(axis));
  return {
    code: "disturbance_axis_coverage",
    passed: missing.length === 0,
    actual: unique,
    required: missing.length ? `all axes; missing ${missing.join(", ")}` : "all axes",
  };
}

function requiredStages(
  actual: PromotionStage[] | undefined,
  required: PromotionStage[],
): PromotionGateCheck {
  const unique = [...new Set(Array.isArray(actual) ? actual : [])]
    .filter((stage) => PROMOTION_STAGES.includes(stage))
    .sort((left, right) => PROMOTION_STAGES.indexOf(left) - PROMOTION_STAGES.indexOf(right));
  const missing = required.filter((stage) => !unique.includes(stage));
  return {
    code: "prerequisite_stages",
    passed: missing.length === 0,
    actual: unique,
    required: missing.length ? `all prerequisites; missing ${missing.join(", ")}` : "all prerequisites",
  };
}

function safeDifference(left: number | null, right: number | null) {
  return typeof left === "number" && Number.isFinite(left) &&
    typeof right === "number" && Number.isFinite(right)
    ? left - right
    : undefined;
}

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
