import type { ScreenHandActionType } from "../action-contract";
import type { ScreenObservation } from "../general-agent-contract";
import type {
  ActiveWorldBeliefSnapshot,
  ActiveWorldObservationSnapshot,
  ActiveWorldTrackedElement,
} from "./types";

export type ActiveWorldBeliefObservation = {
  screenKind: string;
  screenConfidence: number;
  observation: ScreenObservation;
  observedAt?: number;
};

export type ActiveWorldBeliefOptions = {
  maximumTrackedElements?: number;
  maximumMissingObservations?: number;
  kindSwitchFrames?: number;
};

type MutableTrackedElement = ActiveWorldTrackedElement & {
  lastSeenObservation: number;
};

export class ActiveWorldBeliefState {
  private readonly maximumTrackedElements: number;
  private readonly maximumMissingObservations: number;
  private readonly kindSwitchFrames: number;
  private readonly elements = new Map<string, MutableTrackedElement>();
  private revision = 0;
  private observationCount = 0;
  private nextElementId = 1;
  private updatedAt = 0;
  private viewport: ActiveWorldBeliefSnapshot["viewport"] = null;
  private screen: ActiveWorldBeliefSnapshot["screen"] = null;
  private motion: ActiveWorldBeliefSnapshot["motion"] = null;
  private keyboardVisible = false;
  private uncertainty = 1;
  private lastAction: ActiveWorldBeliefSnapshot["lastAction"] = null;

  constructor(options: ActiveWorldBeliefOptions = {}) {
    this.maximumTrackedElements = boundedInteger(
      options.maximumTrackedElements,
      16,
      2_048,
      256,
    );
    this.maximumMissingObservations = boundedInteger(
      options.maximumMissingObservations,
      1,
      100,
      8,
    );
    this.kindSwitchFrames = boundedInteger(options.kindSwitchFrames, 1, 10, 2);
  }

  observe(input: ActiveWorldBeliefObservation) {
    const snapshot = observationSnapshot(input);
    this.observationCount += 1;
    this.revision += 1;
    this.updatedAt = snapshot.observedAt;
    this.viewport = { ...snapshot.viewport };
    this.motion = {
      changeRatio: snapshot.changeRatio,
      changeKind: snapshot.changeKind,
    };
    this.keyboardVisible = snapshot.keyboardVisible;
    this.updateScreen(snapshot);
    this.updateElements(snapshot);
    this.uncertainty = beliefUncertainty(
      this.screen?.confidence ?? 0,
      snapshot.averageTextConfidence,
      this.screen?.stableFrames ?? 0,
      snapshot.screenKind === "unknown",
    );
    return { observation: snapshot, belief: this.snapshot() };
  }

  actionStarted(
    executionId: string,
    label: string,
    type: ScreenHandActionType,
    startedAt: number,
  ) {
    this.revision += 1;
    this.updatedAt = Math.max(this.updatedAt, startedAt);
    this.lastAction = {
      executionId,
      label,
      type,
      status: "executing",
      startedAt,
    };
  }

  actionFinished(
    executionId: string,
    status: "completed" | "failed",
    completedAt: number,
    error?: string,
  ) {
    if (!this.lastAction || this.lastAction.executionId !== executionId) return;
    this.revision += 1;
    this.updatedAt = Math.max(this.updatedAt, completedAt);
    this.lastAction = {
      ...this.lastAction,
      status,
      completedAt,
      ...(error ? { error } : {}),
    };
  }

  snapshot(): ActiveWorldBeliefSnapshot {
    return {
      revision: this.revision,
      observationCount: this.observationCount,
      updatedAt: this.updatedAt,
      viewport: this.viewport ? { ...this.viewport } : null,
      screen: this.screen ? { ...this.screen } : null,
      motion: this.motion ? { ...this.motion } : null,
      keyboardVisible: this.keyboardVisible,
      uncertainty: this.uncertainty,
      elements: [...this.elements.values()]
        .sort((left, right) => (
          right.lastSeenSequence - left.lastSeenSequence ||
          left.center.y - right.center.y ||
          left.center.x - right.center.x
        ))
        .slice(0, this.maximumTrackedElements)
        .map(trackedElementSnapshot),
      lastAction: this.lastAction ? { ...this.lastAction } : null,
    };
  }

  private updateScreen(observation: ActiveWorldObservationSnapshot) {
    const observedKind = observation.screenKind || "unknown";
    const confidence = clamp01(observation.screenConfidence);
    if (!this.screen) {
      this.screen = {
        kind: observedKind,
        confidence,
        candidateKind: null,
        candidateStreak: 0,
        stableFrames: 1,
        unknownStreak: observedKind === "unknown" ? 1 : 0,
        sequence: observation.sequence,
        capturedAt: observation.capturedAt,
        fingerprint: observation.fingerprint,
      };
      return;
    }

    const previous = this.screen;
    const sameFingerprint = previous.fingerprint === observation.fingerprint;
    const unknownStreak = observedKind === "unknown" ? previous.unknownStreak + 1 : 0;
    if (observedKind === previous.kind) {
      this.screen = {
        ...previous,
        confidence: rounded(ema(previous.confidence, confidence, 0.35)),
        candidateKind: null,
        candidateStreak: 0,
        stableFrames: sameFingerprint || observation.changeKind === "stable"
          ? previous.stableFrames + 1
          : Math.max(1, previous.stableFrames - 1),
        unknownStreak,
        sequence: observation.sequence,
        capturedAt: observation.capturedAt,
        fingerprint: observation.fingerprint,
      };
      return;
    }

    const candidateStreak = previous.candidateKind === observedKind
      ? previous.candidateStreak + 1
      : 1;
    const switchImmediately = previous.kind === "unknown" || previous.confidence < 0.4;
    if (switchImmediately || candidateStreak >= this.kindSwitchFrames) {
      this.screen = {
        kind: observedKind,
        confidence,
        candidateKind: null,
        candidateStreak: 0,
        stableFrames: 1,
        unknownStreak,
        sequence: observation.sequence,
        capturedAt: observation.capturedAt,
        fingerprint: observation.fingerprint,
      };
      return;
    }

    this.screen = {
      ...previous,
      confidence: rounded(previous.confidence * 0.92),
      candidateKind: observedKind,
      candidateStreak,
      stableFrames: 0,
      unknownStreak,
      sequence: observation.sequence,
      capturedAt: observation.capturedAt,
      fingerprint: observation.fingerprint,
    };
  }

  private updateElements(observation: ActiveWorldObservationSnapshot) {
    const matched = new Set<string>();
    for (const observed of observation.elements) {
      const existing = closestElement(observed, this.elements.values(), matched);
      if (existing) {
        matched.add(existing.id);
        existing.text = observed.text;
        existing.confidence = rounded(ema(existing.confidence, observed.confidence, 0.45));
        existing.center = blendPoint(existing.center, observed.center, 0.55);
        existing.bounds = blendBounds(existing.bounds, observed.bounds, 0.55);
        existing.lastSeenSequence = observation.sequence;
        existing.lastSeenObservation = this.observationCount;
        existing.seenCount += 1;
        continue;
      }
      const id = `ui-${this.nextElementId++}`;
      matched.add(id);
      this.elements.set(id, {
        ...observed,
        id,
        center: { ...observed.center },
        bounds: { ...observed.bounds },
        firstSeenSequence: observation.sequence,
        lastSeenSequence: observation.sequence,
        lastSeenObservation: this.observationCount,
        seenCount: 1,
      });
    }

    for (const [id, element] of this.elements) {
      if (
        this.observationCount - element.lastSeenObservation >
        this.maximumMissingObservations
      ) this.elements.delete(id);
    }
    if (this.elements.size <= this.maximumTrackedElements * 2) return;
    const oldest = [...this.elements.values()].sort((left, right) =>
      left.lastSeenObservation - right.lastSeenObservation
    );
    for (const element of oldest.slice(0, this.elements.size - this.maximumTrackedElements)) {
      this.elements.delete(element.id);
    }
  }
}

function trackedElementSnapshot(
  element: MutableTrackedElement,
): ActiveWorldTrackedElement {
  return {
    id: element.id,
    role: element.role,
    text: element.text,
    normalizedText: element.normalizedText,
    confidence: element.confidence,
    center: { ...element.center },
    bounds: { ...element.bounds },
    firstSeenSequence: element.firstSeenSequence,
    lastSeenSequence: element.lastSeenSequence,
    seenCount: element.seenCount,
  };
}

export function observationSnapshot(
  input: ActiveWorldBeliefObservation,
): ActiveWorldObservationSnapshot {
  const observation = input.observation;
  const width = Math.max(1, observation.viewport.width);
  const height = Math.max(1, observation.viewport.height);
  const elements = observation.elements
    .filter((element) => element.text.trim())
    .slice(0, 256)
    .map((element) => ({
      id: element.id,
      role: element.role,
      text: element.text.trim().slice(0, 512),
      normalizedText: normalizeText(element.text).slice(0, 512),
      confidence: rounded(clamp01(element.confidence)),
      center: {
        x: rounded(clamp01(element.center.x / width)),
        y: rounded(clamp01(element.center.y / height)),
      },
      bounds: {
        left: rounded(clamp01(element.bounds.left / width)),
        top: rounded(clamp01(element.bounds.top / height)),
        width: rounded(clamp01(element.bounds.width / width)),
        height: rounded(clamp01(element.bounds.height / height)),
      },
    }));
  return {
    sequence: observation.sequence,
    capturedAt: observation.capturedAt,
    observedAt: input.observedAt ?? Date.now(),
    viewport: { ...observation.viewport },
    screenKind: input.screenKind || "unknown",
    sceneKind: observation.scene.kind,
    screenConfidence: rounded(clamp01(input.screenConfidence)),
    sceneConfidence: rounded(clamp01(observation.scene.confidence)),
    fingerprint: observation.fingerprint,
    changeRatio: observation.changeRatio === null
      ? null
      : rounded(clamp01(observation.changeRatio)),
    changeKind: observation.changeKind,
    keyboardVisible: observation.scene.keyboardVisible,
    averageTextConfidence: rounded(clamp01(observation.averageTextConfidence)),
    ocrElapsedMs: rounded(Math.max(0, observation.ocrElapsedMs)),
    observationElapsedMs: rounded(Math.max(0, observation.observationElapsedMs)),
    tokens: [...new Set(elements.map((element) => element.normalizedText).filter(Boolean))],
    elements,
  };
}

function closestElement(
  observed: ActiveWorldObservationSnapshot["elements"][number],
  candidates: Iterable<MutableTrackedElement>,
  matched: ReadonlySet<string>,
) {
  let best: MutableTrackedElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (matched.has(candidate.id) || candidate.normalizedText !== observed.normalizedText) continue;
    const distance = Math.hypot(
      candidate.center.x - observed.center.x,
      candidate.center.y - observed.center.y,
    );
    const tolerance = Math.max(
      0.035,
      Math.min(0.12, Math.max(candidate.bounds.width, candidate.bounds.height) * 1.5),
    );
    if (distance <= tolerance && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function beliefUncertainty(
  screenConfidence: number,
  textConfidence: number,
  stableFrames: number,
  observedUnknown: boolean,
) {
  const stability = Math.min(1, stableFrames / 3);
  const confidence = 0.55 * clamp01(screenConfidence) +
    0.25 * clamp01(textConfidence) + 0.2 * stability;
  return rounded(clamp01(1 - confidence + (observedUnknown ? 0.12 : 0)));
}

function normalizeText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blendPoint(
  left: { x: number; y: number },
  right: { x: number; y: number },
  weight: number,
) {
  return {
    x: rounded(ema(left.x, right.x, weight)),
    y: rounded(ema(left.y, right.y, weight)),
  };
}

function blendBounds(
  left: { left: number; top: number; width: number; height: number },
  right: { left: number; top: number; width: number; height: number },
  weight: number,
) {
  return {
    left: rounded(ema(left.left, right.left, weight)),
    top: rounded(ema(left.top, right.top, weight)),
    width: rounded(ema(left.width, right.width, weight)),
    height: rounded(ema(left.height, right.height, weight)),
  };
}

function ema(previous: number, current: number, currentWeight: number) {
  return previous * (1 - currentWeight) + current * currentWeight;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
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
