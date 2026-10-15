import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { ScreenHandSemanticAction } from "../action-contract";
import { readTransitionJournal } from "./transition-journal";
import type {
  ActiveWorldBeliefSnapshot,
  ActiveWorldTransition,
} from "./types";

export type SemanticWorldPrediction = {
  sampleCount: number;
  effectiveSamples: number;
  successProbability: number | null;
  visualChangeProbability: number | null;
  semanticChangeProbability: number | null;
  expectedLatencyMs: number | null;
  uncertainty: number;
  predictedScreenKinds: Array<{ kind: string; probability: number }>;
  evidenceTransitionIds: string[];
};

export type SemanticTargetPrediction = {
  mode: "shadow";
  evaluatedAt: number;
  eligible: boolean;
  reason:
    | "predicted-shadow-only"
    | "side-effect-not-safe"
    | "evidence-insufficient"
    | "target-unstable"
    | "confidence-low";
  wouldMoveHardware: false;
  sampleCount: number;
  effectiveSamples: number;
  confidence: number;
  uncertainty: number;
  targetErrorP95Pixels: number | null;
  candidate: {
    point: { x: number; y: number };
    normalizedPoint: { x: number; y: number };
    viewport: { width: number; height: number };
  } | null;
  evidenceTransitionIds: string[];
};

export type SemanticWorldModelOptions = {
  maximumTransitions?: number;
  maximumEvidence?: number;
  minimumSimilarity?: number;
};

type WeightedTransition = {
  transition: ActiveWorldTransition;
  similarity: number;
};

/** A platform-neutral empirical forward model over verified camera transitions. */
export class SemanticWorldModel {
  private readonly maximumTransitions: number;
  private readonly maximumEvidence: number;
  private readonly minimumSimilarity: number;
  private readonly transitions: ActiveWorldTransition[] = [];

  constructor(
    transitions: Iterable<ActiveWorldTransition> = [],
    options: SemanticWorldModelOptions = {},
  ) {
    this.maximumTransitions = boundedInteger(
      options.maximumTransitions,
      32,
      100_000,
      10_000,
    );
    this.maximumEvidence = boundedInteger(options.maximumEvidence, 1, 100, 20);
    this.minimumSimilarity = boundedRatio(options.minimumSimilarity, 0.25);
    for (const transition of transitions) this.add(transition);
  }

  static async fromJournalDirectory(
    directory: string,
    options: SemanticWorldModelOptions & { maximumFiles?: number } = {},
  ) {
    return new SemanticWorldModel(
      await loadTransitionsFromJournalDirectory(directory, options),
      options,
    );
  }

  static async fromJournalTree(
    directory: string,
    options: SemanticWorldModelOptions & { maximumFiles?: number } = {},
  ) {
    return new SemanticWorldModel(
      await loadTransitionsFromJournalTree(directory, options),
      options,
    );
  }

  add(transition: ActiveWorldTransition) {
    this.transitions.push(transition);
    if (this.transitions.length > this.maximumTransitions) {
      this.transitions.splice(0, this.transitions.length - this.maximumTransitions);
    }
  }

  size() {
    return this.transitions.length;
  }

  predict(input: {
    belief: ActiveWorldBeliefSnapshot;
    action: ScreenHandSemanticAction;
    label: string;
  }): SemanticWorldPrediction {
    const evidence = this.transitions
      .filter((transition) => transition.action.action.type === input.action.type)
      .map((transition) => ({
        transition,
        similarity: transitionSimilarity(transition, input),
      }))
      .filter((value) => value.similarity >= this.minimumSimilarity)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, this.maximumEvidence);
    if (!evidence.length) return emptyPrediction();

    const weight = evidence.reduce((sum, value) => sum + value.similarity, 0);
    const weighted = (predicate: (transition: ActiveWorldTransition) => boolean) =>
      evidence.reduce(
        (sum, value) => sum + (predicate(value.transition) ? value.similarity : 0),
        0,
      ) / weight;
    const successful = (transition: ActiveWorldTransition) =>
      transition.action.status === "completed" && transition.verification.freshFrame;
    const latencyEvidence = evidence
      .map(({ transition, similarity }) => ({
        value: transition.postcondition && transition.action.startedAt
          ? Math.max(0, transition.postcondition.observedAt - transition.action.startedAt)
          : transition.action.elapsedMs ?? null,
        similarity,
      }))
      .filter((value): value is { value: number; similarity: number } =>
        value.value !== null && Number.isFinite(value.value)
      );
    const screenWeights = new Map<string, number>();
    for (const value of evidence) {
      const kind = value.transition.postcondition?.screenKind;
      if (!kind) continue;
      screenWeights.set(kind, (screenWeights.get(kind) ?? 0) + value.similarity);
    }
    const predictedScreenKinds = [...screenWeights.entries()]
      .map(([kind, kindWeight]) => ({
        kind,
        probability: rounded(kindWeight / Math.max(1e-9, [...screenWeights.values()]
          .reduce((sum, value) => sum + value, 0))),
      }))
      .sort((left, right) => right.probability - left.probability)
      .slice(0, 5);
    const effectiveSamples = effectiveSampleSize(evidence);
    const coverage = clamp01(effectiveSamples / 8);
    const averageSimilarity = weight / evidence.length;
    return {
      sampleCount: evidence.length,
      effectiveSamples: rounded(effectiveSamples),
      successProbability: rounded(weighted(successful)),
      visualChangeProbability: rounded(weighted((transition) =>
        transition.verification.visualChanged === true
      )),
      semanticChangeProbability: rounded(weighted((transition) =>
        transition.verification.semanticChanged === true
      )),
      expectedLatencyMs: latencyEvidence.length
        ? rounded(weightedMean(latencyEvidence))
        : null,
      uncertainty: rounded(clamp01(1 - coverage * averageSimilarity)),
      predictedScreenKinds,
      evidenceTransitionIds: evidence.map((value) => value.transition.transitionId),
    };
  }

  /**
   * Predicts the next atomic tap location from verified transitions before the
   * next full visual-planning pass. The result is Shadow-only; controlled or
   * destructive effects never receive a speculative target.
   */
  predictTarget(input: {
    deviceId: string;
    screenKind: string;
    tokens: string[];
    label: string;
    viewport: { width: number; height: number };
    sideEffect: "none" | "reversible" | "external" | "destructive";
    evaluatedAt?: number;
  }): SemanticTargetPrediction {
    const base = {
      mode: "shadow" as const,
      evaluatedAt: input.evaluatedAt ?? Date.now(),
      wouldMoveHardware: false as const,
    };
    const empty = (
      reason: Exclude<SemanticTargetPrediction["reason"], "predicted-shadow-only">,
    ): SemanticTargetPrediction => ({
      ...base,
      eligible: false,
      reason,
      sampleCount: 0,
      effectiveSamples: 0,
      confidence: 0,
      uncertainty: 1,
      targetErrorP95Pixels: null,
      candidate: null,
      evidenceTransitionIds: [],
    });
    if (input.sideEffect === "external" || input.sideEffect === "destructive") {
      return empty("side-effect-not-safe");
    }
    if (
      !Number.isFinite(input.viewport.width) || input.viewport.width <= 0 ||
      !Number.isFinite(input.viewport.height) || input.viewport.height <= 0
    ) return empty("evidence-insufficient");

    const contextTokens = new Set(input.tokens.map(normalizedToken).filter(Boolean));
    const requestedLabel = labelTokens(input.label);
    const bestByRun = new Map<string, TargetEvidence>();
    for (const transition of this.transitions) {
      const action = transition.action.action;
      const precondition = transition.precondition;
      if (
        action.type !== "tap" || transition.action.status !== "completed" ||
        !transition.verification.freshFrame || !precondition ||
        precondition.screenKind !== input.screenKind ||
        action.viewport.width <= 0 || action.viewport.height <= 0
      ) continue;
      const labelSimilarity = jaccard(requestedLabel, labelTokens(transition.action.label));
      if (labelSimilarity < 0.45) continue;
      const tokenSimilarity = contextTokens.size
        ? jaccard(contextTokens, new Set(precondition.tokens.map(normalizedToken).filter(Boolean)))
        : 0.5;
      const similarity = clamp01(
        0.05 + labelSimilarity * 0.6 + tokenSimilarity * 0.25 +
        (transition.deviceId === input.deviceId ? 0.1 : 0),
      );
      if (similarity < 0.5) continue;
      const evidence: TargetEvidence = {
        transition,
        similarity,
        normalizedPoint: {
          x: action.point.x / action.viewport.width,
          y: action.point.y / action.viewport.height,
        },
      };
      if (
        !Number.isFinite(evidence.normalizedPoint.x) ||
        !Number.isFinite(evidence.normalizedPoint.y) ||
        evidence.normalizedPoint.x < 0 || evidence.normalizedPoint.x > 1 ||
        evidence.normalizedPoint.y < 0 || evidence.normalizedPoint.y > 1
      ) continue;
      const previous = bestByRun.get(transition.runId);
      if (!previous || previous.similarity < similarity) {
        bestByRun.set(transition.runId, evidence);
      }
    }
    const evidence = [...bestByRun.values()]
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, this.maximumEvidence);
    if (!evidence.length) return empty("evidence-insufficient");

    const weight = evidence.reduce((sum, value) => sum + value.similarity, 0);
    const normalizedPoint = {
      x: evidence.reduce(
        (sum, value) => sum + value.normalizedPoint.x * value.similarity,
        0,
      ) / weight,
      y: evidence.reduce(
        (sum, value) => sum + value.normalizedPoint.y * value.similarity,
        0,
      ) / weight,
    };
    const errors = evidence.map((value) => Math.hypot(
      (value.normalizedPoint.x - normalizedPoint.x) * input.viewport.width,
      (value.normalizedPoint.y - normalizedPoint.y) * input.viewport.height,
    )).sort((left, right) => left - right);
    const targetErrorP95Pixels = percentile(errors, 0.95);
    const effectiveSamples = effectiveSampleSize(evidence);
    const coverage = clamp01(effectiveSamples / 5);
    const averageSimilarity = weight / evidence.length;
    const stability = 1 - clamp01((targetErrorP95Pixels ?? 24) / 24);
    const confidence = clamp01(coverage * 0.55 + averageSimilarity * 0.25 + stability * 0.2);
    const candidate = {
      point: {
        x: rounded(normalizedPoint.x * input.viewport.width),
        y: rounded(normalizedPoint.y * input.viewport.height),
      },
      normalizedPoint: {
        x: rounded(normalizedPoint.x),
        y: rounded(normalizedPoint.y),
      },
      viewport: { ...input.viewport },
    };
    const common = {
      ...base,
      sampleCount: evidence.length,
      effectiveSamples: rounded(effectiveSamples),
      confidence: rounded(confidence),
      uncertainty: rounded(1 - confidence),
      targetErrorP95Pixels,
      candidate,
      evidenceTransitionIds: evidence.map((value) => value.transition.transitionId),
    };
    if (evidence.length < 3 || effectiveSamples < 2.5) {
      return { ...common, eligible: false, reason: "evidence-insufficient" };
    }
    if (targetErrorP95Pixels === null || targetErrorP95Pixels > 12) {
      return { ...common, eligible: false, reason: "target-unstable" };
    }
    if (confidence < 0.72) {
      return { ...common, eligible: false, reason: "confidence-low" };
    }
    return { ...common, eligible: true, reason: "predicted-shadow-only" };
  }
}

type TargetEvidence = {
  transition: ActiveWorldTransition;
  similarity: number;
  normalizedPoint: { x: number; y: number };
};

export async function loadTransitionsFromJournalDirectory(
  directory: string,
  options: { maximumFiles?: number } = {},
) {
    const transitions: ActiveWorldTransition[] = [];
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return transitions;
      throw error;
    }
    const maximumFiles = boundedInteger(options.maximumFiles, 1, 10_000, 250);
    const paths = names
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .slice(-maximumFiles)
      .map((name) => resolve(directory, name));
    for (const path of paths) {
      try {
        const records = await readTransitionJournal(path);
        for (const record of records) {
          if (record.event.type === "transition") transitions.push(record.event.transition);
        }
      } catch {
        // One corrupt or concurrently written run must not disable experience
        // retrieval from the remaining verified journals.
      }
    }
    return transitions;
}

export async function loadTransitionsFromJournalTree(
  directory: string,
  options: { maximumFiles?: number } = {},
) {
  const maximumFiles = boundedInteger(options.maximumFiles, 1, 10_000, 1_000);
  const pending = [resolve(directory)];
  const paths: string[] = [];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT" && current === resolve(directory)) return [];
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".transitions.jsonl")) paths.push(path);
      if (paths.length > 10_000) {
        throw new Error("Transition journal tree exceeds the 10,000-file safety limit.");
      }
    }
  }
  const transitions: ActiveWorldTransition[] = [];
  for (const path of paths.sort().slice(-maximumFiles)) {
    try {
      const records = await readTransitionJournal(path);
      for (const record of records) {
        if (record.event.type === "transition") transitions.push(record.event.transition);
      }
    } catch {
      // A partial concurrent run cannot prevent loading the remaining verified
      // transitions. Malformed records are never added as model evidence.
    }
  }
  return transitions;
}

function transitionSimilarity(
  transition: ActiveWorldTransition,
  input: {
    belief: ActiveWorldBeliefSnapshot;
    action: ScreenHandSemanticAction;
    label: string;
  },
) {
  const precondition = transition.precondition;
  let score = 0.2;
  if (precondition && input.belief.screen?.kind === precondition.screenKind) score += 0.25;
  score += 0.2 * jaccard(
    labelTokens(input.label),
    labelTokens(transition.action.label),
  );
  score += 0.2 * jaccard(
    beliefTokens(input.belief),
    new Set(precondition?.tokens ?? []),
  );
  if (actionRegion(input.action) === actionRegion(transition.action.action)) score += 0.15;
  return clamp01(score);
}

function actionRegion(action: ScreenHandSemanticAction) {
  if (
    action.type === "tap" || action.type === "long_press" ||
    action.type === "hover_move" || action.type === "touch_down" ||
    action.type === "touch_move"
  ) {
    return `point:${bucket(action.point.x / action.viewport.width, 4)}:` +
      `${bucket(action.point.y / action.viewport.height, 6)}`;
  }
  if (action.type === "swipe") {
    const dx = action.end.x - action.start.x;
    const dy = action.end.y - action.start.y;
    return Math.abs(dx) > Math.abs(dy)
      ? `swipe:${dx >= 0 ? "right" : "left"}`
      : `swipe:${dy >= 0 ? "down" : "up"}`;
  }
  if (action.type === "phone_key") return `key:${action.key}`;
  return action.type;
}

function beliefTokens(belief: ActiveWorldBeliefSnapshot) {
  const sequence = belief.screen?.sequence ?? 0;
  return new Set(belief.elements
    .filter((element) => element.lastSeenSequence === sequence)
    .map((element) => element.normalizedText)
    .filter(Boolean));
}

function labelTokens(value: string) {
  return new Set(value.normalize("NFKC").toLocaleLowerCase("en-US")
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter(Boolean));
}

function normalizedToken(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

function bucket(value: number, count: number) {
  return Math.max(0, Math.min(count - 1, Math.floor(clamp01(value) * count)));
}

function effectiveSampleSize(values: WeightedTransition[]) {
  const weight = values.reduce((sum, value) => sum + value.similarity, 0);
  const squared = values.reduce((sum, value) => sum + value.similarity ** 2, 0);
  return squared > 0 ? weight ** 2 / squared : 0;
}

function percentile(sorted: number[], quantile: number) {
  if (!sorted.length) return null;
  return rounded(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]);
}

function weightedMean(values: Array<{ value: number; similarity: number }>) {
  const weight = values.reduce((sum, value) => sum + value.similarity, 0);
  return values.reduce(
    (sum, value) => sum + value.value * value.similarity,
    0,
  ) / weight;
}

function emptyPrediction(): SemanticWorldPrediction {
  return {
    sampleCount: 0,
    effectiveSamples: 0,
    successProbability: null,
    visualChangeProbability: null,
    semanticChangeProbability: null,
    expectedLatencyMs: null,
    uncertainty: 1,
    predictedScreenKinds: [],
    evidenceTransitionIds: [],
  };
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
    ? Number(value)
    : fallback;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
}
