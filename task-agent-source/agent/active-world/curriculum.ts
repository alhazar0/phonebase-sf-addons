import { createHash } from "node:crypto";

export const ACTIVE_WORLD_CURRICULUM_SCHEMA_VERSION =
  "screenhand.active-world.curriculum.v1" as const;

export const DISTURBANCE_AXES = [
  "popup",
  "language",
  "theme",
  "layout",
  "blur",
  "reflection",
  "occlusion",
  "phone_drift",
  "stylus_drift",
  "camera_latency",
  "network_loss",
] as const;

export type DisturbanceAxis = (typeof DISTURBANCE_AXES)[number];

export const CURRICULUM_TASK_FAMILIES = [
  "navigation",
  "search_retrieval",
  "form_entry",
  "content_understanding",
  "multi_app_transfer",
  "interruption_recovery",
  "long_horizon",
] as const;

export type CurriculumTaskFamily = (typeof CURRICULUM_TASK_FAMILIES)[number];

export const PROMOTION_STAGES = [
  "simulator",
  "replay",
  "reversible_physical",
  "controlled_side_effect",
] as const;

export type PromotionStage = (typeof PROMOTION_STAGES)[number];

export type CurriculumDisturbance = {
  axis: DisturbanceAxis;
  intensity: number;
  parameters: Record<string, string | number | boolean>;
};

export type CurriculumScenario = {
  id: string;
  seed: string;
  index: number;
  taskFamily: CurriculumTaskFamily;
  promotionStage: PromotionStage;
  difficulty: number;
  disturbances: CurriculumDisturbance[];
  expectedCapabilities: string[];
  executionPolicy: {
    allowHardwareMotion: boolean;
    allowExternalSideEffects: boolean;
    requireVisualProof: true;
    failClosed: true;
  };
  requiredAssertions: string[];
};

export type ActiveWorldCurriculum = {
  schemaVersion: typeof ACTIVE_WORLD_CURRICULUM_SCHEMA_VERSION;
  generator: "failure-boundary-v1";
  seed: string;
  promotionStage: PromotionStage;
  passedStages: PromotionStage[];
  scenarioCount: number;
  disturbanceWeights: Record<DisturbanceAxis, number>;
  scenarios: CurriculumScenario[];
};

export type CurriculumGeneratorOptions = {
  seed: string | number;
  count: number;
  promotionStage?: PromotionStage;
  passedStages?: PromotionStage[];
  taskFamilies?: CurriculumTaskFamily[];
  failureBoundary?: Partial<Record<DisturbanceAxis, number>>;
  coverageGaps?: Partial<Record<DisturbanceAxis, number>>;
  difficulty?: {
    minimum: number;
    maximum: number;
  };
};

const CAPABILITIES: Record<DisturbanceAxis, string[]> = {
  popup: ["overlay_detection", "safe_interruption_recovery"],
  language: ["multilingual_grounding", "locale_independent_navigation"],
  theme: ["appearance_invariant_grounding"],
  layout: ["geometry_independent_grounding", "responsive_layout_reasoning"],
  blur: ["degraded_frame_detection", "temporal_evidence_fusion"],
  reflection: ["reflection_robust_grounding", "uncertainty_calibration"],
  occlusion: ["occlusion_detection", "safe_action_suspension"],
  phone_drift: ["phone_plane_relocalization", "homography_recovery"],
  stylus_drift: ["stylus_tip_relocalization", "visual_servo_correction"],
  camera_latency: ["frame_freshness_enforcement", "asynchronous_control"],
  network_loss: ["idempotent_retry", "task_state_recovery"],
};

const STAGE_PREREQUISITES: Record<PromotionStage, PromotionStage[]> = {
  simulator: [],
  replay: ["simulator"],
  reversible_physical: ["simulator", "replay"],
  controlled_side_effect: ["simulator", "replay", "reversible_physical"],
};

export function promotionStagePrerequisites(stage: PromotionStage) {
  if (!PROMOTION_STAGES.includes(stage)) {
    throw new Error(`Unknown promotion stage: ${stage}`);
  }
  return [...STAGE_PREREQUISITES[stage]];
}

export function generateActiveWorldCurriculum(
  options: CurriculumGeneratorOptions,
): ActiveWorldCurriculum {
  const seed = normalizeSeed(options.seed);
  const count = positiveInteger(options.count, "count", 10_000);
  const promotionStage = options.promotionStage ?? "simulator";
  const passedStages = validatePassedStages(options.passedStages ?? []);
  assertPromotionStageUnlocked(promotionStage, passedStages);
  const taskFamilies = validateTaskFamilies(
    options.taskFamilies ?? [...CURRICULUM_TASK_FAMILIES],
  );
  const difficulty = validateDifficulty(options.difficulty ?? {
    minimum: 0.15,
    maximum: 0.85,
  });
  const failureBoundary = normalizedScores(options.failureBoundary);
  const coverageGaps = normalizedScores(options.coverageGaps);
  const weights = Object.fromEntries(
    DISTURBANCE_AXES.map((axis) => [
      axis,
      rounded(1 + failureBoundary[axis] * 8 + coverageGaps[axis] * 4),
    ]),
  ) as Record<DisturbanceAxis, number>;
  const primaryAxes = buildPrimaryAxisSchedule(count, weights, seed);
  const scenarios = primaryAxes.map((primaryAxis, index) => {
    const scenarioSeed = `${seed}:${index}`;
    const random = seededRandom(scenarioSeed);
    const scenarioDifficulty = difficultyAt(index, count, difficulty, random);
    const axes = selectAxes(primaryAxis, scenarioDifficulty, weights, random);
    const disturbances = axes.map((axis) =>
      createDisturbance(axis, scenarioDifficulty, random),
    );
    const taskFamily = selectTaskFamily(taskFamilies, axes, random);
    return createScenario({
      seed: scenarioSeed,
      index,
      taskFamily,
      promotionStage,
      difficulty: scenarioDifficulty,
      disturbances,
    });
  });

  return {
    schemaVersion: ACTIVE_WORLD_CURRICULUM_SCHEMA_VERSION,
    generator: "failure-boundary-v1",
    seed,
    promotionStage,
    passedStages,
    scenarioCount: scenarios.length,
    disturbanceWeights: weights,
    scenarios,
  };
}

export function assertPromotionStageUnlocked(
  stage: PromotionStage,
  passedStages: PromotionStage[],
) {
  const passed = new Set(validatePassedStages(passedStages));
  const missing = promotionStagePrerequisites(stage).filter((required) => !passed.has(required));
  if (missing.length) {
    throw new Error(
      `Promotion stage ${stage} is locked; missing verified stage${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
    );
  }
}

function createScenario(input: {
  seed: string;
  index: number;
  taskFamily: CurriculumTaskFamily;
  promotionStage: PromotionStage;
  difficulty: number;
  disturbances: CurriculumDisturbance[];
}): CurriculumScenario {
  const capabilities = [...new Set(
    input.disturbances.flatMap((disturbance) => CAPABILITIES[disturbance.axis]),
  )].sort();
  const allowHardwareMotion = input.promotionStage === "reversible_physical" ||
    input.promotionStage === "controlled_side_effect";
  const allowExternalSideEffects = input.promotionStage === "controlled_side_effect";
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
  return {
    id: `awc-${String(input.index + 1).padStart(5, "0")}-${digest}`,
    seed: input.seed,
    index: input.index,
    taskFamily: input.taskFamily,
    promotionStage: input.promotionStage,
    difficulty: input.difficulty,
    disturbances: input.disturbances,
    expectedCapabilities: capabilities,
    executionPolicy: {
      allowHardwareMotion,
      allowExternalSideEffects,
      requireVisualProof: true,
      failClosed: true,
    },
    requiredAssertions: [
      "goal_terminal_state_visually_verified",
      "zero_duplicate_irreversible_actions",
      "zero_out_of_envelope_contacts",
      "frame_sequence_never_regresses",
      ...(allowExternalSideEffects ? ["side_effect_receipt_idempotent"] : ["zero_external_side_effects"]),
    ],
  };
}

function buildPrimaryAxisSchedule(
  count: number,
  weights: Record<DisturbanceAxis, number>,
  seed: string,
) {
  const random = seededRandom(`${seed}:primary`);
  const schedule: DisturbanceAxis[] = [];
  if (count >= DISTURBANCE_AXES.length) {
    schedule.push(...shuffle([...DISTURBANCE_AXES], random));
  }
  while (schedule.length < count) {
    schedule.push(weightedChoice(DISTURBANCE_AXES, weights, random));
  }
  return shuffle(schedule, random).slice(0, count);
}

function selectAxes(
  primary: DisturbanceAxis,
  difficulty: number,
  weights: Record<DisturbanceAxis, number>,
  random: () => number,
) {
  const maximum = difficulty < 0.35 ? 1 : difficulty < 0.65 ? 2 : difficulty < 0.85 ? 3 : 4;
  const count = 1 + Math.floor(random() * maximum);
  const selected = new Set<DisturbanceAxis>([primary]);
  while (selected.size < count) {
    const remaining = DISTURBANCE_AXES.filter((axis) => !selected.has(axis));
    if (!remaining.length) break;
    selected.add(weightedChoice(remaining, weights, random));
  }
  return [...selected];
}

function createDisturbance(
  axis: DisturbanceAxis,
  difficulty: number,
  random: () => number,
): CurriculumDisturbance {
  const intensity = rounded(clamp01(difficulty * (0.72 + random() * 0.4)));
  const centered = () => rounded((random() * 2 - 1) * intensity);
  const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  let parameters: CurriculumDisturbance["parameters"];
  switch (axis) {
    case "popup":
      parameters = {
        coverageRatio: rounded(0.18 + intensity * 0.62),
        dismissAffordance: pick(["text", "icon", "outside_tap"]),
        appearancePhase: pick(["before_action", "during_motion", "after_action"]),
      };
      break;
    case "language": {
      const locale = pick(["es-ES", "zh-CN", "ar-SA", "de-DE", "ja-JP", "pt-BR"]);
      parameters = { locale, rightToLeft: locale === "ar-SA" };
      break;
    }
    case "theme":
      parameters = {
        appearance: pick(["dark", "light", "high_contrast"]),
        contrastScale: rounded(0.65 + intensity * 0.7),
      };
      break;
    case "layout":
      parameters = {
        uiScale: rounded(0.82 + random() * 0.36),
        horizontalShiftRatio: rounded(centered() * 0.12),
        navigationPlacement: pick(["top", "bottom", "side"]),
      };
      break;
    case "blur":
      parameters = {
        sigma: rounded(0.3 + intensity * 3.7),
        motionAngleDegrees: Math.round(random() * 180),
      };
      break;
    case "reflection":
      parameters = {
        areaRatio: rounded(0.04 + intensity * 0.36),
        opacity: rounded(0.1 + intensity * 0.55),
        angleDegrees: Math.round(random() * 180),
      };
      break;
    case "occlusion":
      parameters = {
        areaRatio: rounded(0.03 + intensity * 0.42),
        durationMs: Math.round(80 + intensity * 1_920),
        moving: random() < 0.5,
      };
      break;
    case "phone_drift":
      parameters = {
        translationPixels: rounded(1 + intensity * 44),
        rotationDegrees: rounded(centered() * 8),
        perspectiveRatio: rounded(intensity * 0.05),
      };
      break;
    case "stylus_drift":
      parameters = {
        tipOffsetPixels: rounded(0.5 + intensity * 15.5),
        approachAngleDegrees: rounded(centered() * 6),
      };
      break;
    case "camera_latency":
      parameters = {
        delayMs: Math.round(8 + intensity * 392),
        jitterMs: Math.round(intensity * 120),
        frameDropRate: rounded(intensity * 0.35),
      };
      break;
    case "network_loss":
      parameters = {
        offlineMs: Math.round(100 + intensity * 4_900),
        packetLossRate: rounded(intensity * 0.65),
        responseDelayMs: Math.round(intensity * 1_500),
      };
      break;
  }
  return { axis, intensity, parameters };
}

function selectTaskFamily(
  allowed: CurriculumTaskFamily[],
  axes: DisturbanceAxis[],
  random: () => number,
) {
  const preferred = new Set<CurriculumTaskFamily>();
  if (axes.some((axis) => axis === "popup" || axis === "network_loss" || axis === "occlusion")) {
    preferred.add("interruption_recovery");
  }
  if (axes.some((axis) => axis === "language" || axis === "layout" || axis === "theme")) {
    preferred.add("search_retrieval");
    preferred.add("form_entry");
  }
  if (axes.some((axis) => axis === "camera_latency" || axis === "phone_drift" || axis === "stylus_drift")) {
    preferred.add("navigation");
    preferred.add("long_horizon");
  }
  const pool = allowed.filter((family) => preferred.has(family));
  const candidates = pool.length && random() < 0.7 ? pool : allowed;
  return candidates[Math.floor(random() * candidates.length)]!;
}

function difficultyAt(
  index: number,
  count: number,
  range: { minimum: number; maximum: number },
  random: () => number,
) {
  const progress = count === 1 ? 0.5 : index / (count - 1);
  const baseline = range.minimum + (range.maximum - range.minimum) * progress;
  const jitter = (random() * 2 - 1) * (range.maximum - range.minimum) * 0.08;
  return rounded(Math.max(range.minimum, Math.min(range.maximum, baseline + jitter)));
}

function normalizedScores(values?: Partial<Record<DisturbanceAxis, number>>) {
  const unknown = Object.keys(values ?? {}).filter(
    (axis) => !DISTURBANCE_AXES.includes(axis as DisturbanceAxis),
  );
  if (unknown.length) throw new Error(`Unknown disturbance axis: ${unknown.join(", ")}.`);
  return Object.fromEntries(DISTURBANCE_AXES.map((axis) => {
    const value = values?.[axis] ?? 0;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${axis} score must be between 0 and 1.`);
    }
    return [axis, value];
  })) as Record<DisturbanceAxis, number>;
}

function validateDifficulty(range: { minimum: number; maximum: number }) {
  if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) ||
      range.minimum < 0 || range.maximum > 1 || range.minimum > range.maximum) {
    throw new Error("difficulty minimum/maximum must satisfy 0 <= minimum <= maximum <= 1.");
  }
  return { minimum: range.minimum, maximum: range.maximum };
}

function validateTaskFamilies(values: CurriculumTaskFamily[]) {
  if (!values.length) throw new Error("At least one task family is required.");
  const unique = [...new Set(values)];
  const unknown = unique.filter((value) => !CURRICULUM_TASK_FAMILIES.includes(value));
  if (unknown.length) throw new Error(`Unknown task family: ${unknown.join(", ")}.`);
  return unique;
}

function validatePassedStages(stages: PromotionStage[]) {
  const unique = [...new Set(stages)];
  const unknown = unique.filter((stage) => !PROMOTION_STAGES.includes(stage));
  if (unknown.length) throw new Error(`Unknown passed stage: ${unknown.join(", ")}.`);
  return unique.sort((left, right) => PROMOTION_STAGES.indexOf(left) - PROMOTION_STAGES.indexOf(right));
}

function weightedChoice(
  values: readonly DisturbanceAxis[],
  weights: Record<DisturbanceAxis, number>,
  random: () => number,
) {
  const total = values.reduce((sum, value) => sum + weights[value], 0);
  let cursor = random() * total;
  for (const value of values) {
    cursor -= weights[value];
    if (cursor <= 0) return value;
  }
  return values.at(-1)!;
}

function shuffle<T>(values: T[], random: () => number) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [values[index], values[target]] = [values[target]!, values[index]!];
  }
  return values;
}

function seededRandom(seed: string) {
  let state = stableHash(seed) || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function positiveInteger(value: number, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizeSeed(value: string | number) {
  const seed = String(value).trim();
  if (!seed) throw new Error("seed cannot be empty.");
  return seed;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
