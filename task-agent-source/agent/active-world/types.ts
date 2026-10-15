import type { ScreenHandSemanticAction } from "../action-contract";

export const ACTIVE_WORLD_SCHEMA_VERSION = "screenhand.active-world.v1" as const;

export type ActiveWorldObservedElement = {
  id: string;
  role: "text";
  text: string;
  normalizedText: string;
  confidence: number;
  center: { x: number; y: number };
  bounds: { left: number; top: number; width: number; height: number };
};

export type ActiveWorldObservationSnapshot = {
  sequence: number;
  capturedAt: number;
  observedAt: number;
  viewport: { width: number; height: number };
  screenKind: string;
  sceneKind: string;
  screenConfidence: number;
  sceneConfidence: number;
  fingerprint: string;
  changeRatio: number | null;
  changeKind: "first" | "stable" | "minor" | "major";
  keyboardVisible: boolean;
  averageTextConfidence: number;
  ocrElapsedMs: number;
  observationElapsedMs: number;
  tokens: string[];
  elements: ActiveWorldObservedElement[];
};

export type ActiveWorldTrackedElement = ActiveWorldObservedElement & {
  firstSeenSequence: number;
  lastSeenSequence: number;
  seenCount: number;
};

export type ActiveWorldBeliefSnapshot = {
  revision: number;
  observationCount: number;
  updatedAt: number;
  viewport: { width: number; height: number } | null;
  screen: {
    kind: string;
    confidence: number;
    candidateKind: string | null;
    candidateStreak: number;
    stableFrames: number;
    unknownStreak: number;
    sequence: number;
    capturedAt: number;
    fingerprint: string;
  } | null;
  motion: {
    changeRatio: number | null;
    changeKind: "first" | "stable" | "minor" | "major";
  } | null;
  keyboardVisible: boolean;
  uncertainty: number;
  elements: ActiveWorldTrackedElement[];
  lastAction: {
    executionId: string;
    label: string;
    type: ScreenHandSemanticAction["type"];
    status: "executing" | "completed" | "failed";
    startedAt: number;
    completedAt?: number;
    error?: string;
  } | null;
};

export type ActiveWorldActionSnapshot = {
  executionId: string;
  label: string;
  action: ScreenHandSemanticAction;
  sensitiveTextRedacted: boolean;
  startedAt: number;
  beforeSequence: number;
  completedAt?: number;
  elapsedMs?: number;
  receiptId?: string;
  status: "executing" | "completed" | "failed";
  error?: string;
};

export type ActiveWorldSpeculativeHoverReason =
  | "eligible-shadow-only"
  | "action-not-tap"
  | "belief-unavailable"
  | "action-in-progress"
  | "plan-confidence-low"
  | "belief-uncertain"
  | "screen-confidence-low"
  | "screen-moving"
  | "future-frame"
  | "stale-frame"
  | "viewport-mismatch"
  | "target-out-of-range"
  | "target-near-edge";

export type ActiveWorldSpeculativeHoverDecision = {
  mode: "shadow";
  evaluatedAt: number;
  label: string;
  actionType: ScreenHandSemanticAction["type"];
  eligible: boolean;
  wouldMoveHardware: false;
  reason: ActiveWorldSpeculativeHoverReason;
  planConfidence: number;
  beliefRevision: number;
  beliefUncertainty: number;
  beliefSequence: number | null;
  actionFrameSequence: number | null;
  frameLag: number | null;
  candidate?: {
    point: { x: number; y: number };
    normalizedPoint: { x: number; y: number };
    viewport: { width: number; height: number };
    frameSequence: number;
  };
};

export type ActiveWorldCriticReason =
  | "accepted"
  | "accepted-requires-barrier"
  | "action-in-progress"
  | "belief-unavailable"
  | "belief-uncertain"
  | "future-frame"
  | "stale-frame"
  | "plan-confidence-low"
  | "verified-history-poor"
  | "critic-score-low";

export type ActiveWorldCriticDecision = {
  mode: "shadow";
  evaluatedAt: number;
  label: string;
  actionType: ScreenHandSemanticAction["type"];
  accepted: boolean;
  requiresBarrier: boolean;
  sideEffectRisk: "low" | "medium" | "high";
  wouldChangeExecution: false;
  reason: ActiveWorldCriticReason;
  score: number;
  planConfidence: number;
  beliefRevision: number;
  beliefUncertainty: number;
  beliefSequence: number | null;
  actionFrameSequence: number | null;
  frameLag: number | null;
  prediction: {
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
};

export type ActiveWorldTransition = {
  transitionId: string;
  runId: string;
  deviceId: string;
  action: ActiveWorldActionSnapshot;
  precondition: ActiveWorldObservationSnapshot | null;
  postcondition: ActiveWorldObservationSnapshot | null;
  verification: {
    freshFrame: boolean;
    visualChanged: boolean | null;
    semanticChanged: boolean | null;
    postSequenceDelta: number | null;
    reason: "fresh-post-action-observation" | "action-failed" | "run-ended-before-observation";
  };
};

export type ActiveWorldJournalEvent =
  | {
      type: "run_started";
      runId: string;
      deviceId: string;
      goal: string;
      mode: "dry_run" | "execute";
      startedAt: number;
    }
  | {
      type: "observation";
      runId: string;
      observation: ActiveWorldObservationSnapshot;
      belief: ActiveWorldBeliefSnapshot;
    }
  | {
      type: "action_started" | "action_completed" | "action_failed";
      runId: string;
      action: ActiveWorldActionSnapshot;
    }
  | {
      type: "transition";
      runId: string;
      transition: ActiveWorldTransition;
    }
  | {
      type: "speculative_hover";
      runId: string;
      decision: ActiveWorldSpeculativeHoverDecision;
    }
  | {
      type: "critic_evaluation";
      runId: string;
      decision: ActiveWorldCriticDecision;
    }
  | {
      type: "run_finished";
      runId: string;
      status: string;
      completedAt: number;
      belief: ActiveWorldBeliefSnapshot;
    };

export type ActiveWorldJournalRecord = {
  schemaVersion: typeof ACTIVE_WORLD_SCHEMA_VERSION;
  sequence: number;
  recordedAt: number;
  event: ActiveWorldJournalEvent;
};

export type ActiveWorldSessionSummary = {
  journalPath: string;
  observations: number;
  actions: number;
  transitions: number;
  verifiedTransitions: number;
  unresolvedTransitions: number;
  speculations: number;
  eligibleSpeculations: number;
  criticEvaluations: number;
  criticAccepted: number;
  criticRejected: number;
  criticBarriers: number;
  journalRecords: number;
  journalWriteErrors: number;
  journalError?: string;
  belief: ActiveWorldBeliefSnapshot;
};
