import { randomUUID } from "node:crypto";

import type { ScreenHandSemanticAction } from "../action-contract";
import type { AgentActionResult } from "../general-agent-client";
import type { ScreenObservation } from "../general-agent-contract";
import { ActiveWorldBeliefState } from "./belief-state";
import { TransitionJournal, type TransitionJournalWriter } from "./transition-journal";
import type {
  ActiveWorldActionSnapshot,
  ActiveWorldBeliefSnapshot,
  ActiveWorldCriticDecision,
  ActiveWorldObservationSnapshot,
  ActiveWorldSessionSummary,
  ActiveWorldSpeculativeHoverDecision,
} from "./types";

export type ActiveWorldSessionOptions = {
  runId: string;
  deviceId: string;
  goal: string;
  mode: "dry_run" | "execute";
  journalPath: string;
  startedAt?: number;
  captureSensitiveText?: boolean;
  journalWriter?: TransitionJournalWriter;
  onTransition?: (transition: import("./types").ActiveWorldTransition) => void;
};

export type ActiveWorldActionStarted = {
  executionId: string;
  label: string;
  action: ScreenHandSemanticAction;
  startedAt: number;
};

export type ActiveWorldActionCompleted = ActiveWorldActionStarted & {
  completedAt: number;
  result: AgentActionResult;
};

export type ActiveWorldActionFailed = ActiveWorldActionStarted & {
  completedAt: number;
  error: unknown;
};

export type ActiveWorldObservedState = {
  kind: string;
  confidence: number;
  observation: ScreenObservation;
  detectedAt: number;
};

type PendingTransition = {
  action: ActiveWorldActionSnapshot;
  precondition: ActiveWorldObservationSnapshot | null;
};

export class ActiveWorldSession {
  private readonly belief = new ActiveWorldBeliefState();
  private readonly pending = new Map<string, PendingTransition>();
  private latestObservation: ActiveWorldObservationSnapshot | null = null;
  private observations = 0;
  private actions = 0;
  private transitions = 0;
  private verifiedTransitions = 0;
  private speculations = 0;
  private eligibleSpeculations = 0;
  private criticEvaluations = 0;
  private criticAccepted = 0;
  private criticRejected = 0;
  private criticBarriers = 0;
  private finished = false;

  private constructor(
    private readonly options: ActiveWorldSessionOptions,
    private readonly journal: TransitionJournal,
  ) {}

  static async open(options: ActiveWorldSessionOptions) {
    const journal = new TransitionJournal(options.journalPath, options.journalWriter);
    await journal.initialize();
    const session = new ActiveWorldSession(options, journal);
    journal.record({
      type: "run_started",
      runId: options.runId,
      deviceId: options.deviceId,
      goal: options.goal,
      mode: options.mode,
      startedAt: options.startedAt ?? Date.now(),
    });
    return session;
  }

  observe(state: ActiveWorldObservedState) {
    if (this.finished) return;
    const updated = this.belief.observe({
      screenKind: state.kind,
      screenConfidence: state.confidence,
      observation: state.observation,
      observedAt: state.detectedAt,
    });
    this.latestObservation = updated.observation;
    this.observations += 1;
    this.journal.record({
      type: "observation",
      runId: this.options.runId,
      observation: updated.observation,
      belief: updated.belief,
    });
    for (const pending of [...this.pending.values()]) {
      if (
        pending.action.status !== "completed" ||
        updated.observation.sequence <= pending.action.beforeSequence
      ) continue;
      this.recordTransition(
        pending,
        updated.observation,
        "fresh-post-action-observation",
      );
      this.pending.delete(pending.action.executionId);
    }
  }

  actionStarted(event: ActiveWorldActionStarted) {
    if (this.finished) return;
    const redacted = recordedAction(event.action, this.options.captureSensitiveText === true);
    const action: ActiveWorldActionSnapshot = {
      executionId: event.executionId,
      label: event.label,
      action: redacted.action,
      sensitiveTextRedacted: redacted.sensitiveTextRedacted,
      startedAt: event.startedAt,
      beforeSequence: actionFrameSequence(event.action) ?? this.latestObservation?.sequence ?? 0,
      status: "executing",
    };
    this.actions += 1;
    this.pending.set(event.executionId, {
      action,
      precondition: this.latestObservation,
    });
    this.belief.actionStarted(
      event.executionId,
      event.label,
      event.action.type,
      event.startedAt,
    );
    this.journal.record({
      type: "action_started",
      runId: this.options.runId,
      action,
    });
  }

  actionCompleted(event: ActiveWorldActionCompleted) {
    if (this.finished) return;
    const pending = this.pending.get(event.executionId);
    if (!pending) return;
    pending.action = {
      ...pending.action,
      status: "completed",
      completedAt: event.completedAt,
      elapsedMs: event.result.elapsedMs,
      receiptId: event.result.receipt.id,
    };
    this.belief.actionFinished(event.executionId, "completed", event.completedAt);
    this.journal.record({
      type: "action_completed",
      runId: this.options.runId,
      action: pending.action,
    });
  }

  actionFailed(event: ActiveWorldActionFailed) {
    if (this.finished) return;
    const pending = this.pending.get(event.executionId);
    if (!pending) return;
    const error = errorMessage(event.error);
    pending.action = {
      ...pending.action,
      status: "failed",
      completedAt: event.completedAt,
      error,
    };
    this.belief.actionFinished(event.executionId, "failed", event.completedAt, error);
    this.journal.record({
      type: "action_failed",
      runId: this.options.runId,
      action: pending.action,
    });
    this.recordTransition(pending, null, "action-failed");
    this.pending.delete(event.executionId);
  }

  beliefSnapshot(): ActiveWorldBeliefSnapshot {
    return this.belief.snapshot();
  }

  recordSpeculativeHover(decision: ActiveWorldSpeculativeHoverDecision) {
    if (this.finished) return;
    this.speculations += 1;
    if (decision.eligible) this.eligibleSpeculations += 1;
    this.journal.record({
      type: "speculative_hover",
      runId: this.options.runId,
      decision,
    });
  }

  recordCriticEvaluation(decision: ActiveWorldCriticDecision) {
    if (this.finished) return;
    this.criticEvaluations += 1;
    if (decision.accepted) this.criticAccepted += 1;
    else this.criticRejected += 1;
    if (decision.requiresBarrier) this.criticBarriers += 1;
    this.journal.record({
      type: "critic_evaluation",
      runId: this.options.runId,
      decision,
    });
  }

  async finish(status: string): Promise<ActiveWorldSessionSummary> {
    if (!this.finished) {
      this.finished = true;
      for (const pending of this.pending.values()) {
        this.recordTransition(pending, null, "run-ended-before-observation");
      }
      this.pending.clear();
      this.journal.record({
        type: "run_finished",
        runId: this.options.runId,
        status,
        completedAt: Date.now(),
        belief: this.belief.snapshot(),
      });
    }
    const journal = await this.journal.flush();
    return {
      journalPath: this.journal.path,
      observations: this.observations,
      actions: this.actions,
      transitions: this.transitions,
      verifiedTransitions: this.verifiedTransitions,
      unresolvedTransitions: this.transitions - this.verifiedTransitions,
      speculations: this.speculations,
      eligibleSpeculations: this.eligibleSpeculations,
      criticEvaluations: this.criticEvaluations,
      criticAccepted: this.criticAccepted,
      criticRejected: this.criticRejected,
      criticBarriers: this.criticBarriers,
      journalRecords: journal.records,
      journalWriteErrors: journal.writeErrors,
      ...(journal.error ? { journalError: journal.error } : {}),
      belief: this.belief.snapshot(),
    };
  }

  private recordTransition(
    pending: PendingTransition,
    postcondition: ActiveWorldObservationSnapshot | null,
    reason: "fresh-post-action-observation" | "action-failed" | "run-ended-before-observation",
  ) {
    const precondition = pending.precondition;
    const freshFrame = Boolean(
      postcondition && postcondition.sequence > pending.action.beforeSequence,
    );
    const visualChanged = precondition && postcondition
      ? precondition.fingerprint !== postcondition.fingerprint
      : null;
    const semanticChanged = precondition && postcondition
      ? precondition.screenKind !== postcondition.screenKind ||
        !sameTokens(precondition.tokens, postcondition.tokens)
      : null;
    this.transitions += 1;
    if (freshFrame) this.verifiedTransitions += 1;
    const transition = {
      transitionId: `transition-${randomUUID()}`,
      runId: this.options.runId,
      deviceId: this.options.deviceId,
      action: pending.action,
      precondition,
      postcondition,
      verification: {
        freshFrame,
        visualChanged,
        semanticChanged,
        postSequenceDelta: postcondition
          ? postcondition.sequence - pending.action.beforeSequence
          : null,
        reason,
      },
    } satisfies import("./types").ActiveWorldTransition;
    this.journal.record({
      type: "transition",
      runId: this.options.runId,
      transition,
    });
    try {
      this.options.onTransition?.(transition);
    } catch {
      // Experience indexing is an optimization and cannot change execution.
    }
  }
}

function recordedAction(
  action: ScreenHandSemanticAction,
  captureSensitiveText: boolean,
): { action: ScreenHandSemanticAction; sensitiveTextRedacted: boolean } {
  if (action.type !== "input_text" || captureSensitiveText) {
    return { action, sensitiveTextRedacted: false };
  }
  return {
    action: { ...action, text: `[REDACTED:${action.text.length}]` },
    sensitiveTextRedacted: true,
  };
}

function actionFrameSequence(action: ScreenHandSemanticAction) {
  return "frameSequence" in action ? action.frameSequence : null;
}

function sameTokens(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((token) => rightSet.has(token));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
