import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ScreenHandSemanticAction } from "./action-contract";
import { evaluateActionCandidate } from "./active-world/action-critic";
import { ActiveWorldSession } from "./active-world/session";
import { SemanticWorldModel } from "./active-world/semantic-world-model";
import { evaluateSpeculativeHover } from "./active-world/speculative-hover";
import { FileAgentMemory, type AgentMemory } from "./agent-memory";
import { signaturesDiffer } from "./fast-intent";
import type {
  AgentPlan,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  GeneralAgentIntent,
  ScreenObservation,
} from "./general-agent-contract";
import { GENERAL_AGENT_PROTOCOL_VERSION } from "./general-agent-contract";
import type {
  AgentActionResult,
  GeneralAgentDeviceClient,
} from "./general-agent-client";
import {
  interpretGeneralGoal,
  observationUsesNonLatinKeyboard,
  locateAppIcon,
  locateTextInObservation,
  locateVisualAffordance,
  parseVisualAffordanceDescriptor,
  swipePoints,
} from "./general-intent";
import { ScreenObserver, type AgentFrame } from "./screen-observer";
import type {
  VisionModelPlanner,
  VisionModelProposal,
} from "./vision-model-planner";
import {
  assertRealtimePhoneKeyAllowed,
  assertRealtimeTapAllowed,
  assertRealtimeTextInputAllowed,
} from "./realtime/action-safety";
import {
  planPopupAction,
  type PopupDecision,
  type PopupPolicy,
} from "./realtime/popup-guardian";
import { LatencyRecorder } from "./realtime/latency-recorder";

export type PlannerState = {
  requestedHome: boolean;
  homePageSwipes: number;
  fieldFocused: boolean;
  appSearchOpened: boolean;
  appSearchTyped: boolean;
  keyboardLanguageSwitches: number;
};

export type PlanDecision =
  | { type: "action"; plan: AgentPlan }
  | { type: "completed"; reason: string; confidence: number }
  | { type: "blocked"; reason: string };

export type GeneralMobileAgentOptions = {
  observer?: ScreenObserver;
  memory?: AgentMemory;
  modelPlanner?: VisionModelPlanner;
  minimumActionConfidence?: number;
  verificationTimeoutMs?: number;
  now?: () => number;
  activeWorld?: {
    artifactDirectory: string;
    captureSensitiveText?: boolean;
  };
  worldModel?: SemanticWorldModel;
  accessMode?: "full_access" | "read_only";
  popupPolicy?: PopupPolicy;
};

export class GeneralMobileAgent {
  private readonly observer: ScreenObserver;
  private readonly memory: AgentMemory;
  private readonly modelPlanner: VisionModelPlanner | null;
  private readonly minimumActionConfidence: number;
  private readonly verificationTimeoutMs: number;
  private readonly now: () => number;
  private readonly activeWorldOptions: GeneralMobileAgentOptions["activeWorld"];
  private readonly worldModel: SemanticWorldModel;
  private readonly accessMode: "full_access" | "read_only";
  private readonly popupPolicy: PopupPolicy;

  constructor(
    private readonly client: GeneralAgentDeviceClient,
    options: GeneralMobileAgentOptions = {},
  ) {
    this.observer = options.observer ?? new ScreenObserver();
    this.memory = options.memory ?? new FileAgentMemory();
    this.modelPlanner = options.modelPlanner ?? null;
    this.minimumActionConfidence = options.minimumActionConfidence ?? 0.42;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 4_500;
    this.now = options.now ?? Date.now;
    this.activeWorldOptions = options.activeWorld;
    this.worldModel = options.worldModel ?? new SemanticWorldModel();
    this.accessMode = options.accessMode ?? "read_only";
    this.popupPolicy = options.popupPolicy ?? {};
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const runId = `agent-${randomUUID()}`;
    const startedAt = this.now();
    const latency = new LatencyRecorder(this.now);
    const deadline = startedAt + request.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("The general agent run timed out.")),
      request.timeoutMs,
    );
    const events: AgentRunEvent[] = [];
    const metrics = {
      observations: 0,
      ocrRuns: 0,
      ocrCacheHits: 0,
      actions: 0,
      recoveries: 0,
      observationMs: [] as number[],
      ocrMs: [] as number[],
      modelMs: [] as number[],
      actionReceiptMs: [] as number[],
    };
    const state: PlannerState = {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: false,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    };
    const intent = latency.measureSync(
      "planning",
      "interpret-goal",
      () => interpretGeneralGoal(request.goal),
      { goalLength: request.goal.length },
    );
    let lastObservation: ScreenObservation | undefined;
    let steps = 0;
    let consecutiveErrors = 0;
    const executionCounts = new Map<string, number>();
    const modelHistory: string[] = [];
    let activeWorld: ActiveWorldSession | undefined;

    const event = (
      phase: AgentRunEvent["phase"],
      message: string,
      data?: Record<string, unknown>,
      durationMs?: number,
    ) => {
      events.push({ at: this.now(), phase, step: steps, message, data, durationMs });
      if (events.length > 200) events.shift();
    };
    const finish = async (
      status: AgentRunResult["status"],
      reason: string,
      plan?: AgentPlan,
    ): Promise<AgentRunResult> => {
      clearTimeout(timeout);
      latency.recordDecision("terminal-decision", { status, reason });
      const activeWorldSummary = activeWorld
        ? await latency.measure(
            "runtime",
            "active-world-finish",
            () => activeWorld!.finish(status),
          )
        : undefined;
      const completedAt = this.now();
      const runtimeTiming = latency.snapshot();
      return {
        protocolVersion: GENERAL_AGENT_PROTOCOL_VERSION,
        runId,
        request,
        intent,
        status,
        reason,
        steps,
        startedAt,
        completedAt,
        metrics: {
          totalMs: Math.max(0, completedAt - startedAt),
          observations: metrics.observations,
          ocrRuns: metrics.ocrRuns,
          ocrCacheHits: metrics.ocrCacheHits,
          actions: metrics.actions,
          recoveries: metrics.recoveries,
          averageObservationMs: roundedAverage(metrics.observationMs),
          averageOcrMs: roundedAverage(metrics.ocrMs),
          modelRuns: metrics.modelMs.length,
          averageModelMs: roundedAverage(metrics.modelMs),
          actionReceiptMs: metrics.actionReceiptMs,
          runtimeTiming,
        },
        ...(plan ? { plan } : {}),
        ...(lastObservation
          ? { lastObservation: serializableObservation(lastObservation) }
          : {}),
        events,
        ...(activeWorldSummary ? { activeWorld: activeWorldSummary } : {}),
      };
    };

    try {
      if (this.activeWorldOptions) {
        try {
          const journalPath = resolve(
            this.activeWorldOptions.artifactDirectory,
            `${runId}.transitions.jsonl`,
          );
          activeWorld = await latency.measure("runtime", "active-world-open", () =>
            ActiveWorldSession.open({
              runId,
              deviceId: request.deviceId,
              goal: request.goal,
              mode: request.mode,
              journalPath,
              startedAt,
              captureSensitiveText: this.activeWorldOptions?.captureSensitiveText,
              onTransition: (transition) => this.worldModel.add(transition),
            }));
          event("remember", "Active World transition journal is ready.", { journalPath });
          event("remember", "Semantic transition experience is ready.", {
            transitions: this.worldModel.size(),
            mode: "shadow",
          });
        } catch (error) {
          event("remember", "Active World journal is unavailable; continuing safely.", {
            error: errorMessage(error),
          });
        }
      }
      event("understand", `Parsed goal as ${intent.type}.`, { intent });
      while (steps < request.maxSteps && this.now() < deadline) {
        steps += 1;
        try {
          event("observe", "Fetching the latest canonical phone frame.");
          const frame = await latency.measure(
            "frame_transport",
            "fetch-canonical-frame",
            () => this.client.getScreenshot(controller.signal),
          );
          recordFrameAge(latency, frame, this.now());
          const observation = await latency.measure(
            "perception",
            "observe-screen",
            () => this.observer.observe(frame, controller.signal),
            { sequence: frame.sequence },
          );
          latency.recordSample("ocr", "screen-ocr", observation.ocrElapsedMs, {
            sequence: observation.sequence,
            cacheHit: observation.ocrCacheHit,
            strategy: observation.ocrStrategy ?? "legacy",
          });
          lastObservation = observation;
          observeActiveWorld(activeWorld, observation, this.now());
          recordObservationMetrics(metrics, observation);
          event("observe", `Observed ${observation.scene.kind}.`, {
            sequence: observation.sequence,
            changeKind: observation.changeKind,
            elementCount: observation.elements.length,
            sceneConfidence: observation.scene.confidence,
            ocrCacheHit: observation.ocrCacheHit,
            ocrStrategy: observation.ocrStrategy ?? "legacy",
            ocrRegionCount: observation.ocrRegionCount ?? 0,
            changedRegionCount: observation.changedRegions?.length ?? 0,
            sceneGraphNodes: observation.sceneGraph?.nodes.length ?? 0,
            visualAffordanceCount: observation.visualAffordances?.length ?? 0,
            affordanceCacheHit: observation.affordanceCacheHit ?? false,
            affordanceElapsedMs: observation.affordanceElapsedMs ?? 0,
            overlayActive: observation.sceneGraph?.overlay.active ?? false,
          }, observation.observationElapsedMs);
          latency.markDecisionEvidence("screen-observation", {
            sequence: observation.sequence,
            sceneKind: observation.scene.kind,
            confidence: observation.scene.confidence,
          });

          event("plan", "Selecting the next safe visual primitive.");
          const popup = planPopupAction({ observation }, this.popupPolicy);
          let decision = popup
            ? planPopupRecovery(popup, observation)
            : observation.scene.kind === "screen_off"
              ? wakeScreenPlan(observation)
            : intent.type === "unknown"
              ? { type: "blocked" as const, reason: intent.reason }
              : planAgentStep(intent, observation, state);
          if (popup) {
            event("recover", `Popup guardian selected ${popup.label}.`, {
              category: popup.category,
              operation: popup.operation,
              confidence: popup.confidence,
              source: "local_scene_graph",
            });
          }
          if (
            decision.type === "blocked" &&
            this.modelPlanner &&
            shouldEscalateToVisionModel(intent, observation)
          ) {
            const modelStartedAt = this.now();
            event("plan", "The local fast path was inconclusive; requesting one visual model primitive.", {
              localReason: decision.reason,
            });
            const proposal = await this.modelPlanner.plan({
              goal: request.goal,
              step: steps,
              frame,
              observation,
              accessMode: this.accessMode,
              history: modelHistory,
              signal: controller.signal,
            });
            const modelElapsedMs = Math.max(0, this.now() - modelStartedAt);
            metrics.modelMs.push(modelElapsedMs);
            decision = planVisionModelProposal(proposal, observation);
            event("plan", proposal.rationale, {
              source: "vision_model",
              operation: proposal.operation,
              confidence: proposal.confidence,
            }, modelElapsedMs);
          }
          if (
            decision.type === "action" &&
            decision.plan.action.type === "input_text" &&
            observationUsesNonLatinKeyboard(observation)
          ) {
            decision = prepareKeyboardPlan();
            event("plan", "The visible keyboard must switch to Latin input before typing.", {
              source: "keyboard_guard",
            });
          }
          if (decision.type === "completed") {
            if (decision.confidence < this.minimumActionConfidence) {
              return finish(
                "blocked",
                `The model completion confidence ${decision.confidence.toFixed(2)} is below the ` +
                  `${this.minimumActionConfidence.toFixed(2)} threshold.`,
              );
            }
            return finish("completed", decision.reason);
          }
          if (decision.type === "blocked") {
            return finish("blocked", decision.reason);
          }
          const plan = decision.plan;
          event("plan", plan.rationale, {
            kind: plan.kind,
            confidence: plan.confidence,
            actionType: plan.action.type,
          });
          if (activeWorld) {
            const belief = activeWorld.beliefSnapshot();
            const speculation = evaluateSpeculativeHover({
              label: plan.label,
              action: plan.action,
              planConfidence: plan.confidence,
              belief,
              evaluatedAt: this.now(),
            });
            activeWorld.recordSpeculativeHover(speculation);
            event(
              "plan",
              speculation.eligible
                ? "Shadow pre-hover accepted; no hardware command was sent."
                : `Shadow pre-hover rejected: ${speculation.reason}.`,
              {
                shadowOnly: true,
                eligible: speculation.eligible,
                reason: speculation.reason,
                frameLag: speculation.frameLag,
                beliefUncertainty: speculation.beliefUncertainty,
                ...(speculation.candidate
                  ? { candidate: speculation.candidate }
                  : {}),
              },
            );
            const prediction = this.worldModel.predict({
              belief,
              action: plan.action,
              label: plan.label,
            });
            const critic = evaluateActionCandidate({
              label: plan.label,
              action: plan.action,
              planConfidence: plan.confidence,
              belief,
              prediction,
              evaluatedAt: this.now(),
            });
            activeWorld.recordCriticEvaluation(critic);
            event(
              "plan",
              critic.accepted
                ? `Shadow critic accepted the candidate${critic.requiresBarrier ? " with an irreversible-action barrier" : ""}.`
                : `Shadow critic rejected the candidate: ${critic.reason}.`,
              {
                shadowOnly: true,
                critic: true,
                accepted: critic.accepted,
                reason: critic.reason,
                score: critic.score,
                requiresBarrier: critic.requiresBarrier,
                sideEffectRisk: critic.sideEffectRisk,
                prediction: critic.prediction,
                wouldChangeExecution: false,
              },
            );
          }
          if (plan.confidence < this.minimumActionConfidence) {
            return finish(
              "blocked",
              `The best action confidence ${plan.confidence.toFixed(2)} is below the ` +
                `${this.minimumActionConfidence.toFixed(2)} execution threshold.`,
              plan,
            );
          }
          if (request.mode === "dry_run") {
            return finish("planned", "Dry run produced a plan without moving hardware.", plan);
          }

          assertGeneralPlanAllowed(
            plan,
            observation,
            this.accessMode,
            request.goal,
          );

          const executionKey = planExecutionKey(plan, observation);
          const executionCount = executionCounts.get(executionKey) ?? 0;
          const executionLimit = planExecutionLimit(plan);
          if (executionCount >= executionLimit) {
            return finish(
              "blocked",
              `${plan.label} did not reach its verified state after ${executionLimit} physical attempt${executionLimit === 1 ? "" : "s"}.`,
              plan,
            );
          }
          executionCounts.set(executionKey, executionCount + 1);

          latency.recordDecision("select-action", {
            label: plan.label,
            kind: plan.kind,
            actionType: plan.action.type,
            confidence: plan.confidence,
          });
          event("act", `Executing ${plan.label}.`, { action: plan.action });
          const actionStartedAt = this.now();
          const executionId = `action-${randomUUID()}`;
          activeWorld?.actionStarted({
            executionId,
            label: plan.label,
            action: plan.action,
            startedAt: actionStartedAt,
          });
          let result: AgentActionResult;
          try {
            result = await latency.measure(
              "action",
              plan.label,
              () => this.client.executeAction(plan.action, controller.signal, {
                idempotencyKey: executionId,
              }),
              { executionId, actionType: plan.action.type },
            );
            latency.recordSample(
              "physical_motion",
              plan.label,
              receiptMotionMs(result),
              {
                executionId,
                receiptId: result.receipt.id,
                actionType: plan.action.type,
                clientElapsedMs: result.elapsedMs,
              },
            );
            activeWorld?.actionCompleted({
              executionId,
              label: plan.label,
              action: plan.action,
              startedAt: actionStartedAt,
              completedAt: this.now(),
              result,
            });
          } catch (error) {
            activeWorld?.actionFailed({
              executionId,
              label: plan.label,
              action: plan.action,
              startedAt: actionStartedAt,
              completedAt: this.now(),
              error,
            });
            throw error;
          }
          metrics.actions += 1;
          metrics.actionReceiptMs.push(result.elapsedMs);
          event("act", `Hardware receipt ${result.receipt.status}.`, {
            receiptId: result.receipt.id,
          }, result.elapsedMs);

          const after = plan.requiresVisualChange
            ? await this.verifyPlanOutcome(
                plan,
                observation,
                controller.signal,
                event,
                metrics,
                latency,
                (after) => observeActiveWorld(activeWorld, after, this.now()),
              )
            : observation;
          const verified = latency.measureSync(
            "verification",
            "final-plan-outcome",
            () => after === observation || planOutcomeVerified(plan, observation, after),
            { beforeSequence: observation.sequence, afterSequence: after.sequence },
          );
          await latency.measure("runtime", "record-agent-memory", () => this.memory.record({
            runId,
            deviceId: request.deviceId,
            goal: request.goal,
            intentType: intent.type,
            actionType: plan.action.type,
            beforeFingerprint: observation.fingerprint,
            afterFingerprint: after === observation ? null : after.fingerprint,
            success: verified,
            confidence: plan.confidence,
            elapsedMs: this.now() - actionStartedAt,
            recordedAt: new Date(this.now()).toISOString(),
          }));
          if (!verified) {
            throw new AgentVerificationError(
              `The hardware completed ${plan.label}, but the camera could not verify the intended UI state.`,
            );
          }
          lastObservation = after;
          modelHistory.push(
            `${plan.label} -> verified ${after.scene.kind} frame ${after.sequence}`,
          );
          if (modelHistory.length > 12) modelHistory.shift();
          consecutiveErrors = 0;
          updatePlannerState(state, plan);
          if (plan.kind === "popup_guardian") {
            metrics.recoveries += 1;
            latency.record("recovery", "popup-guardian", this.now() - actionStartedAt, {
              label: plan.label,
              beforeSequence: observation.sequence,
              afterSequence: after.sequence,
            });
            event("recover", "The interruption cleared; resuming the original task.", {
              sequence: after.sequence,
            });
          }
          event("remember", "Stored the verified visual transition.", {
            before: observation.fingerprint,
            after: after.fingerprint,
          });
          if (plan.completesGoal) {
            return finish("completed", `Verified goal completion via ${plan.label}.`, plan);
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          latency.recordDecision("failed-decision", { error: errorMessage(error) });
          if (error instanceof AgentVerificationError) {
            event("recover", error.message, { verificationFailure: true });
            continue;
          }
          consecutiveErrors += 1;
          event("recover", errorMessage(error), { consecutiveErrors });
          if (request.mode === "dry_run") {
            return finish(
              "failed",
              `Dry run could not observe the device: ${errorMessage(error)}`,
            );
          }
          if (consecutiveErrors < 3) continue;
          const recovered = await this.recover(
            controller.signal,
            event,
            metrics,
            latency,
            activeWorld,
          );
          consecutiveErrors = 0;
          state.requestedHome = false;
          state.homePageSwipes = 0;
          state.fieldFocused = false;
          state.appSearchOpened = false;
          state.appSearchTyped = false;
          state.keyboardLanguageSwitches = 0;
          if (!recovered) {
            return finish("failed", "Three consecutive failures occurred and visual recovery failed.");
          }
        }
      }
      if (this.now() >= deadline) return finish("timed_out", "The run exceeded its deadline.");
      return finish("blocked", `The goal was not verified within ${request.maxSteps} steps.`);
    } catch (error) {
      return finish(
        controller.signal.aborted ? "timed_out" : "failed",
        errorMessage(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async verifyPlanOutcome(
    plan: AgentPlan,
    before: ScreenObservation,
    signal: AbortSignal,
    event: (
      phase: AgentRunEvent["phase"],
      message: string,
      data?: Record<string, unknown>,
      durationMs?: number,
    ) => void,
    metrics: {
      observations: number;
      ocrRuns: number;
      ocrCacheHits: number;
      observationMs: number[];
      ocrMs: number[];
    },
    latency: LatencyRecorder,
    onObservation?: (observation: ScreenObservation) => void,
  ) {
    return latency.measure("phone_animation", `verify:${plan.label}`, async () => {
      const startedAt = this.now();
      const deadline = startedAt + this.verificationTimeoutMs;
      let sequence = before.sequence;
      let after = before;
      let settledWrongStateFrames = 0;
      let firstVerifiedAt: number | null = null;
      const minimumSettleMs = minimumVerificationSettleMs(plan);
      while (this.now() < deadline) {
        const frame = await this.client.waitForNewScreenshot(
          sequence,
          Math.max(200, deadline - this.now()),
          signal,
        );
        recordFrameAge(latency, frame, this.now());
        sequence = frame.sequence;
        after = await latency.measure(
          "perception",
          "observe-verification-frame",
          () => this.observer.observe(frame, signal),
          { sequence },
        );
        latency.recordSample("ocr", "verification-ocr", after.ocrElapsedMs, {
          sequence,
          cacheHit: after.ocrCacheHit,
          strategy: after.ocrStrategy ?? "legacy",
        });
        onObservation?.(after);
        recordObservationMetrics(metrics, after);
        const outcomeVerified = latency.measureSync(
          "verification",
          "plan-outcome-predicate",
          () => planOutcomeVerified(plan, before, after),
          { beforeSequence: before.sequence, afterSequence: after.sequence },
        );
        if (outcomeVerified) {
          firstVerifiedAt ??= this.now();
          if (this.now() - firstVerifiedAt < minimumSettleMs) continue;
          event("verify", "Verified the intended post-action screen state.", {
            beforeSequence: before.sequence,
            afterSequence: after.sequence,
            changeRatio: after.changeRatio,
          }, this.now() - startedAt);
          latency.markDecisionEvidence("verified-plan-outcome", {
            sequence: after.sequence,
            sceneKind: after.scene.kind,
          });
          return after;
        }
        firstVerifiedAt = null;
        const settledWrongState = latency.measureSync(
          "verification",
          "wrong-state-predicate",
          () => requiresSpecificOutcome(plan) &&
            observationChanged(before, after) &&
            after.changeKind === "stable",
          { beforeSequence: before.sequence, afterSequence: after.sequence },
        );
        if (settledWrongState) {
          settledWrongStateFrames += 1;
          if (settledWrongStateFrames >= 1) {
            event("verify", "The screen changed but settled in the wrong UI state; replanning immediately.", {
              beforeSequence: before.sequence,
              afterSequence: after.sequence,
              observedScene: after.scene.kind,
            }, this.now() - startedAt);
            latency.markDecisionEvidence("settled-wrong-state", {
              sequence: after.sequence,
              sceneKind: after.scene.kind,
            });
            return after;
          }
        }
      }
      event("verify", "The intended post-action screen state was not detected.", {
        beforeSequence: before.sequence,
        lastSequence: after.sequence,
      }, this.now() - startedAt);
      latency.markDecisionEvidence("verification-timeout", {
        sequence: after.sequence,
        sceneKind: after.scene.kind,
      });
      return after;
    }, {
      beforeSequence: before.sequence,
      timeoutMs: this.verificationTimeoutMs,
      planKind: plan.kind,
    });
  }

  private async recover(
    signal: AbortSignal,
    event: (phase: AgentRunEvent["phase"], message: string, data?: Record<string, unknown>) => void,
    metrics: { actions: number; recoveries: number; actionReceiptMs: number[] },
    latency: LatencyRecorder,
    activeWorld?: ActiveWorldSession,
  ) {
    const action: ScreenHandSemanticAction = { type: "phone_key", key: "back" };
    const executionId = `action-${randomUUID()}`;
    const startedAt = this.now();
    try {
      event("recover", "Attempting one camera-safe Back gesture after three failures.");
      activeWorld?.actionStarted({
        executionId,
        label: "recover-back",
        action,
        startedAt,
      });
      const result = await latency.measure(
        "action",
        "recover-back",
        () => this.client.executeAction(action, signal),
        { executionId, actionType: action.type },
      );
      latency.recordSample("physical_motion", "recover-back", receiptMotionMs(result), {
        executionId,
        receiptId: result.receipt.id,
        clientElapsedMs: result.elapsedMs,
      });
      activeWorld?.actionCompleted({
        executionId,
        label: "recover-back",
        action,
        startedAt,
        completedAt: this.now(),
        result,
      });
      metrics.actions += 1;
      metrics.recoveries += 1;
      metrics.actionReceiptMs.push(result.elapsedMs);
      latency.record("recovery", "recover-back", this.now() - startedAt, {
        executionId,
        receiptId: result.receipt.id,
      });
      return true;
    } catch (error) {
      latency.record("recovery", "recover-back", this.now() - startedAt, {
        executionId,
        error: errorMessage(error),
      });
      activeWorld?.actionFailed({
        executionId,
        label: "recover-back",
        action,
        startedAt,
        completedAt: this.now(),
        error,
      });
      event("recover", `Back recovery failed: ${errorMessage(error)}`);
      return false;
    }
  }
}

function recordFrameAge(latency: LatencyRecorder, frame: AgentFrame, observedAt: number) {
  const ageMs = observedAt - frame.capturedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) return;
  latency.recordSample("frame_transport", "camera-to-agent", ageMs, {
    sequence: frame.sequence,
    capturedAt: frame.capturedAt,
    observedAt,
  });
}

function receiptMotionMs(result: AgentActionResult) {
  const receipt = result.receipt;
  const elapsed = Number(receipt.elapsedMs ?? receipt.durationMs);
  if (Number.isFinite(elapsed) && elapsed >= 0) return elapsed;
  if (
    Number.isFinite(receipt.createdAt) &&
    Number.isFinite(receipt.completedAt) &&
    Number(receipt.completedAt) >= Number(receipt.createdAt)
  ) {
    return Number(receipt.completedAt) - Number(receipt.createdAt);
  }
  return result.elapsedMs;
}

function shouldEscalateToVisionModel(
  intent: GeneralAgentIntent,
  observation: ScreenObservation,
) {
  if (
    intent.type === "tap_affordance" &&
    intent.descriptor.symbol !== undefined &&
    observation.scene.kind === "home_grid"
  ) {
    // Home tiles contain arbitrary logo artwork. Once the scene layer has
    // removed those shapes and no requested system symbol remains, a remote
    // model must not reinterpret the same logos into a physical target.
    return false;
  }
  return true;
}

function minimumVerificationSettleMs(plan: AgentPlan) {
  // System search results reflow from Suggestions into Top Hit after the query
  // first appears. Acting on that first transitional frame can target a row
  // that moves before the stylus arrives. Keep the camera loop live for one
  // short animation window; no fixed sleep is added to unrelated actions.
  return plan.kind === "search_app" ? 350 : 0;
}

function observeActiveWorld(
  activeWorld: ActiveWorldSession | undefined,
  observation: ScreenObservation,
  detectedAt: number,
) {
  activeWorld?.observe({
    kind: observation.scene.kind,
    confidence: observation.scene.confidence,
    observation,
    detectedAt,
  });
}

class AgentVerificationError extends Error {}

export function planVisionModelProposal(
  proposal: VisionModelProposal,
  observation: ScreenObservation,
): PlanDecision {
  if (proposal.operation === "complete") {
    return {
      type: "completed",
      reason: `The visual model verified the goal from the current camera frame: ${proposal.rationale}`,
      confidence: proposal.confidence,
    };
  }
  if (proposal.operation === "blocked") {
    return { type: "blocked", reason: proposal.rationale };
  }
  const viewport = observation.viewport;
  const context = { viewport, frameSequence: observation.sequence };
  let action: ScreenHandSemanticAction;
  if (proposal.operation === "tap") {
    const grounded = proposal.target
      ? locateTextInObservation(proposal.target, observation) ??
        locateModelAffordance(proposal.target, observation)
      : null;
    action = {
      type: "tap",
      point: grounded?.point ?? normalizedPoint(proposal.x, proposal.y, viewport),
      ...context,
    };
  } else if (proposal.operation === "swipe") {
    action = {
      type: "swipe",
      start: normalizedPoint(proposal.startX, proposal.startY, viewport),
      end: normalizedPoint(proposal.endX, proposal.endY, viewport),
      durationMs: 420,
      ...context,
    };
  } else if (proposal.operation === "input_text") {
    action = { type: "input_text", text: proposal.text ?? "" };
  } else if (proposal.operation === "wait") {
    action = { type: "wait", durationMs: proposal.durationMs ?? 0 };
  } else {
    action = { type: "phone_key", key: proposal.operation };
  }
  return actionPlan({
    kind: "model",
    action,
    label: proposal.target
      ? `${proposal.operation} “${proposal.target}”`
      : `model ${proposal.operation}`,
    rationale: proposal.rationale,
    confidence: proposal.confidence,
    completesGoal: false,
    requiresVisualChange: proposal.operation !== "wait",
  });
}

export function planAgentStep(
  intent: GeneralAgentIntent,
  observation: ScreenObservation,
  state: PlannerState,
): PlanDecision {
  if (observation.scene.kind === "screen_off") return wakeScreenPlan(observation);
  const touchContext = {
    viewport: observation.viewport,
    frameSequence: observation.sequence,
  };
  if (intent.type === "navigate") {
    if (intent.key === "home" && observation.scene.kind === "home_grid") {
      return {
        type: "completed",
        reason: "The camera already verifies a Home icon grid.",
        confidence: observation.scene.homeGridScore,
      };
    }
    if (intent.key === "home" && observation.scene.kind === "app_switcher") {
      return dismissAppSwitcherPlan(observation, touchContext, true);
    }
    if (intent.key === "home" && observation.scene.kind === "app_library") {
      const points = swipePoints("right", observation.viewport);
      return actionPlan({
        kind: "leave_app_library",
        action: { type: "swipe", ...points, ...touchContext, durationMs: 360 },
        label: "leave App Library for Home",
        rationale: "A rightward page gesture returns from App Library to a normal Home icon page.",
        confidence: 0.98,
        completesGoal: true,
        requiresVisualChange: true,
      });
    }
    return actionPlan({
      kind: "navigate",
      action: { type: "phone_key", key: intent.key },
      label: `${intent.key} navigation`,
      rationale: `The goal directly requests the ${intent.key} system navigation primitive.`,
      confidence: 0.99,
      completesGoal: true,
      requiresVisualChange: intent.key !== "enter",
    });
  }
  if (intent.type === "scroll") {
    const points = swipePoints(intent.direction, observation.viewport);
    return actionPlan({
      kind: "scroll",
      action: {
        type: "swipe",
        ...points,
        ...touchContext,
        durationMs: 420,
      },
      label: `scroll ${intent.direction}`,
      rationale: "The requested direction maps to a viewport-relative physical swipe.",
      confidence: 0.98,
      completesGoal: true,
      requiresVisualChange: true,
    });
  }
  if (intent.type === "tap_affordance") {
    const target = locateVisualAffordance(intent.descriptor, observation);
    if (!target) {
      return {
        type: "blocked",
        reason: "The requested unlabeled control was not found at the described screen position.",
      };
    }
    return actionPlan({
      kind: "tap_affordance",
      action: { type: "tap", point: target.point, ...touchContext },
      label: `tap ${target.label}`,
      rationale: "A local visual hit area matched the user's explicit role and screen-position description.",
      confidence: target.confidence,
      completesGoal: true,
      requiresVisualChange: true,
    });
  }
  if (intent.type === "tap_text") {
    const target = locateTextInObservation(intent.text, observation);
    if (!target) {
      return { type: "blocked", reason: `Visible text “${intent.text}” was not found.` };
    }
    return actionPlan({
      kind: "tap_text",
      action: { type: "tap", point: target.point, ...touchContext },
      label: `tap visible text “${target.label}”`,
      rationale: "OCR found the requested label in the current camera frame.",
      confidence: target.confidence,
      completesGoal: true,
      requiresVisualChange: true,
    });
  }
  if (intent.type === "input_text") {
    if (observationUsesNonLatinKeyboard(observation)) {
      return prepareKeyboardPlan();
    }
    if (observation.scene.keyboardVisible || state.fieldFocused) {
      return actionPlan({
        kind: "input_text",
        action: { type: "input_text", text: intent.text },
        label: `type ${intent.text.length} characters`,
        rationale: "The target field was focused and the keyboard is ready for calibrated entry.",
        confidence: observation.scene.keyboardVisible ? 0.92 : 0.62,
        completesGoal: true,
        requiresVisualChange: true,
      });
    }
    const field = locateInputField(intent.field, observation);
    if (!field) {
      return { type: "blocked", reason: `Input field “${intent.field}” was not found.` };
    }
    return actionPlan({
      kind: "focus_field",
      action: { type: "tap", point: field.point, ...touchContext },
      label: `focus field “${field.label}”`,
      rationale: "OCR found the requested input field; focus it before physical typing.",
      confidence: field.confidence,
      completesGoal: false,
      requiresVisualChange: true,
    });
  }
  if (intent.type === "open_app") {
    const visibleSystemResult = isSystemAppSearch(observation)
      ? locateAppSearchResult(intent.appName, observation)
      : null;
    if (visibleSystemResult) {
      return actionPlan({
        kind: "open_app_result",
        action: { type: "tap", point: visibleSystemResult.point, ...touchContext },
        label: `open search result “${visibleSystemResult.label}”`,
        rationale: "The requested app is already a visible system-search result; reuse it without typing again.",
        confidence: visibleSystemResult.confidence,
        completesGoal: true,
        requiresVisualChange: true,
      });
    }
    if (isSystemAppSearch(observation) && observation.scene.keyboardVisible) {
      return actionPlan({
        kind: "search_app",
        action: { type: "input_text", text: intent.appName },
        label: `search for app “${intent.appName}”`,
        rationale: "System app search is already open and has no matching result yet.",
        confidence: 0.94,
        completesGoal: false,
        requiresVisualChange: true,
      });
    }
    if (observation.scene.kind === "app_switcher") {
      return dismissAppSwitcherPlan(observation, touchContext);
    }
    if (state.appSearchOpened) {
      if (!state.appSearchTyped) {
        if (!observation.scene.keyboardVisible) {
          return {
            type: "blocked",
            reason: "The Home search control was tapped, but a stable keyboard was not verified.",
          };
        }
        return actionPlan({
          kind: "search_app",
          action: { type: "input_text", text: intent.appName },
          label: `search for app “${intent.appName}”`,
          rationale: "Home search is open; use the calibrated physical keyboard instead of traversing pages.",
          confidence: 0.94,
          completesGoal: false,
          requiresVisualChange: true,
        });
      }
      const result = locateAppSearchResult(intent.appName, observation);
      if (!result) {
        return {
          type: "blocked",
          reason: `Home search did not expose an unambiguous result for “${intent.appName}”.`,
        };
      }
      return actionPlan({
        kind: "open_app_result",
        action: { type: "tap", point: result.point, ...touchContext },
        label: `open search result “${result.label}”`,
        rationale: "OCR found the requested app below the Home search field.",
        confidence: result.confidence,
        completesGoal: true,
        requiresVisualChange: true,
      });
    }
    if (observation.scene.kind === "app_library") {
      return actionPlan({
        kind: "open_app_search",
        action: {
          type: "tap",
          point: {
            x: observation.viewport.width * 0.5,
            y: observation.viewport.height * 0.105,
          },
          ...touchContext,
        },
        label: "open App Library search",
        rationale: "App Library exposes a universal app index at the top of the current page.",
        confidence: 0.98,
        completesGoal: false,
        requiresVisualChange: true,
      });
    }
    if (observation.scene.kind !== "home_grid") {
      if (state.requestedHome) {
        return {
          type: "blocked",
          reason: "The system Home gesture completed, but a home-screen icon grid was not verified.",
        };
      }
      return actionPlan({
        kind: "reach_home",
        action: { type: "phone_key", key: "home" },
        label: "go to the system Home screen",
        rationale: "Opening an arbitrary app starts from a visually verified home icon grid.",
        confidence: 0.96,
        completesGoal: false,
        requiresVisualChange: true,
      });
    }
    const app = locateAppIcon(intent.appName, observation);
    if (app) {
      return actionPlan({
        kind: "open_app",
        action: { type: "tap", point: app.point, ...touchContext },
        label: `open app “${app.label}”`,
        rationale: "The requested label was located in a repeated home-screen grid; the icon center is directly above it.",
        confidence: app.confidence,
        completesGoal: true,
        requiresVisualChange: true,
      });
    }
    return actionPlan({
      kind: "open_app_search",
      action: {
        type: "tap",
        point: {
          x: observation.viewport.width * 0.5,
          y: observation.viewport.height * (1_300 / 1_560),
        },
        ...touchContext,
      },
      label: "open system app search",
      rationale: `The app is not on the visible Home page; system search avoids slow and ambiguous page traversal.`,
      confidence: Math.max(0.82, observation.scene.homeGridScore),
      completesGoal: false,
      requiresVisualChange: true,
    });
  }
  return { type: "blocked", reason: intent.reason };
}

function locateModelAffordance(target: string, observation: ScreenObservation) {
  const descriptor = parseVisualAffordanceDescriptor(target);
  return descriptor ? locateVisualAffordance(descriptor, observation) : null;
}

export function planPopupRecovery(
  popup: PopupDecision,
  observation: ScreenObservation,
): PlanDecision {
  const action: ScreenHandSemanticAction = popup.operation === "tap" && popup.target
    ? {
        type: "tap",
        point: {
          x: popup.target.x * observation.viewport.width,
          y: popup.target.y * observation.viewport.height,
        },
        viewport: observation.viewport,
        frameSequence: observation.sequence,
      }
    : { type: "phone_key", key: "back" };
  return actionPlan({
    kind: "popup_guardian",
    action,
    label: `dismiss ${popup.category} popup via ${popup.label}`,
    rationale: popup.rationale,
    confidence: popup.confidence,
    completesGoal: false,
    requiresVisualChange: true,
  });
}

function locateInputField(fieldName: string, observation: ScreenObservation) {
  const located = locateTextInObservation(fieldName, observation);
  if (normalizeLabel(fieldName) !== "search") return located;
  if (located && located.point.x <= observation.viewport.width * 0.72) return located;

  // Search pages frequently expose a right-aligned “Search” submit button
  // while the editable field itself contains a query or suggestion. Treating
  // that button as the field submits the page and dismisses the keyboard.
  // The bar occupies the same top toolbar row, so reuse its y coordinate but
  // target the editable center-left region.
  const topRowY = located?.point.y ?? observation.elements
    .filter((element) =>
      element.center.y >= observation.viewport.height * 0.065 &&
      element.center.y <= observation.viewport.height * 0.16
    )
    .sort((left, right) =>
      right.bounds.width - left.bounds.width || left.center.y - right.center.y
    )[0]?.center.y;
  if (topRowY === undefined) return null;
  return {
    label: "Search field",
    point: {
      x: observation.viewport.width * 0.4,
      y: topRowY,
    },
    confidence: located ? Math.min(0.94, located.confidence) : 0.78,
  };
}

function actionPlan(plan: AgentPlan): PlanDecision {
  return { type: "action", plan };
}

function prepareKeyboardPlan(): PlanDecision {
  return actionPlan({
    kind: "prepare_keyboard",
    action: { type: "phone_key", key: "keyboard_next" },
    label: "switch keyboard to Latin input",
    rationale: "The focused keyboard exposes non-Latin candidates; use its verified language key before calibrated text entry.",
    confidence: 0.96,
    completesGoal: false,
    requiresVisualChange: true,
  });
}

function updatePlannerState(state: PlannerState, plan: AgentPlan) {
  if (plan.kind === "reach_home") state.requestedHome = true;
  if (plan.kind === "search_home_page") state.homePageSwipes += 1;
  if (plan.kind === "focus_field") state.fieldFocused = true;
  if (plan.kind === "open_app_search") state.appSearchOpened = true;
  if (plan.kind === "search_app") state.appSearchTyped = true;
  if (plan.kind === "prepare_keyboard") state.keyboardLanguageSwitches += 1;
}

function observationChanged(before: ScreenObservation, after: ScreenObservation) {
  return before.fingerprint !== after.fingerprint && (
    (after.changeRatio ?? 0) >= 0.018 ||
    signaturesDiffer(before.textSignature, after.textSignature)
  );
}

export function planOutcomeVerified(
  plan: AgentPlan,
  before: ScreenObservation,
  after: ScreenObservation,
) {
  const changed = observationChanged(before, after);
  if (!changed) return false;
  if (plan.kind === "popup_guardian") {
    return !planPopupAction({ observation: after });
  }
  if (plan.kind === "wake_screen") return after.scene.kind !== "screen_off";
  if (plan.action.type === "input_text") {
    return typedTextIsVisible(plan.action.text, after);
  }
  if (
    plan.kind === "reach_home" ||
    (plan.action.type === "phone_key" && plan.action.key === "home")
  ) {
    return after.scene.kind === "home_grid" && after.scene.homeGridScore >= 0.42;
  }
  if (plan.kind === "open_app") {
    return before.scene.kind === "home_grid" &&
      (after.scene.kind === "text_ui" || after.scene.kind === "keyboard");
  }
  if (plan.kind === "open_app_result") return after.scene.kind === "text_ui";
  if (plan.kind === "dismiss_app_switcher") {
    return after.scene.kind === "home_grid" && after.scene.homeGridScore >= 0.42;
  }
  if (plan.kind === "leave_app_library") return after.scene.kind === "home_grid";
  if (plan.kind === "focus_field" || plan.kind === "open_app_search") {
    return after.scene.keyboardVisible;
  }
  if (plan.kind === "prepare_keyboard") {
    return after.scene.keyboardVisible && !observationUsesNonLatinKeyboard(after);
  }
  return true;
}

function requiresSpecificOutcome(plan: AgentPlan) {
  return plan.kind === "wake_screen" || plan.kind === "reach_home" || plan.kind === "focus_field" ||
    plan.kind === "open_app_search" ||
    plan.kind === "prepare_keyboard" ||
    plan.kind === "dismiss_app_switcher" || plan.kind === "leave_app_library" ||
    plan.action.type === "input_text" ||
    (plan.action.type === "phone_key" && plan.action.key === "home");
}

function typedTextIsVisible(text: string, observation: ScreenObservation) {
  const expected = normalizeLabel(text);
  if (!expected) return false;
  const visibleItems = observation.elements
    .filter((element) =>
      element.confidence >= 0.3 &&
      (
        element.center.y < observation.viewport.height * 0.18 ||
        (
          element.center.y > observation.viewport.height * 0.52 &&
          element.center.y < observation.viewport.height * 0.72
        )
      )
    )
    .sort((left, right) =>
      left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left
    )
    .map((element) => normalizeLabel(element.text))
    .filter(Boolean);
  if (visibleItems.some((item) => item.includes(expected))) return true;
  const joined = visibleItems.join("");
  if (joined.includes(expected)) return true;

  // Only likely editor bands are considered above. Search/profile results can
  // repeat the requested word elsewhere on screen and must never serve as
  // proof that the physical keyboard entered the requested characters.
  // Long fields often scroll horizontally after entry. In that case the final
  // 10 characters remain visible even though the beginning has left the frame.
  // Ten characters is deliberately long enough to avoid accepting a random
  // suggestion or a keyboard label as proof of successful physical typing.
  if (expected.length >= 14) {
    const suffix = expected.slice(-10);
    return visibleItems.some((item) => item.includes(suffix)) || joined.includes(suffix);
  }
  return false;
}

export function planExecutionKey(plan: AgentPlan, observation: ScreenObservation) {
  if (plan.kind === "model") {
    return `${plan.kind}:${plan.label}:${JSON.stringify(plan.action)}:${observation.fingerprint}`;
  }
  if (plan.kind === "popup_guardian") {
    return `${plan.kind}:${plan.label}:${observation.fingerprint}`;
  }
  return `${plan.kind}:${plan.action.type}`;
}

function planExecutionLimit(plan: AgentPlan) {
  if (
    plan.kind === "reach_home" ||
    (plan.kind === "navigate" && plan.action.type === "phone_key" && plan.action.key === "home")
  ) return 1;
  if (plan.kind === "search_home_page") return 2;
  if (plan.kind === "prepare_keyboard") return 2;
  return 1;
}

function locateAppSearchResult(appName: string, observation: ScreenObservation) {
  const wanted = normalizeLabel(appName);
  const candidates = observation.elements
    .filter((element) => {
      const label = normalizeLabel(element.text);
      return element.confidence >= 0.35 &&
        element.center.y >= observation.viewport.height * 0.13 &&
        element.center.y <= observation.viewport.height * 0.58 &&
        (label === wanted || label.includes(wanted) || wanted.includes(label));
    })
    .sort((left, right) => {
      const leftExact = normalizeLabel(left.text) === wanted ? 1 : 0;
      const rightExact = normalizeLabel(right.text) === wanted ? 1 : 0;
      return rightExact - leftExact || left.center.y - right.center.y;
    });
  const result = candidates[0];
  const isTopHit = Boolean(result) &&
    result.center.y <= observation.viewport.height * 0.3 &&
    observation.elements.some((element) => /top hit|最佳匹配/i.test(element.text));
  const isSuggestionGrid = Boolean(result) &&
    result.center.y <= observation.viewport.height * 0.34 &&
    observation.elements.some((element) => /suggestions|建议/i.test(element.text));
  return result ? {
    label: result.text,
    point: {
      x: result.center.x,
      y: isTopHit || isSuggestionGrid
        ? Math.max(0, result.center.y - observation.viewport.height * 0.055)
        : result.center.y,
    },
    confidence: result.confidence,
  } : null;
}

function normalizeLabel(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function isSystemAppSearch(observation: ScreenObservation) {
  if (!observation.scene.keyboardVisible) return false;
  const text = observation.elements
    .map((element) => element.text.normalize("NFKC").toLocaleLowerCase("en-US"))
    .join(" ");
  return /(?:top hit|suggestions|siri suggestions|search in app|app library|最佳匹配|建议)/.test(text);
}

function dismissAppSwitcherPlan(
  observation: ScreenObservation,
  touchContext: { viewport: ScreenObservation["viewport"]; frameSequence: number },
  completesGoal = false,
): PlanDecision {
  return actionPlan({
    kind: "dismiss_app_switcher",
    action: {
      type: "tap",
      point: {
        x: observation.viewport.width * 0.9,
        y: observation.viewport.height * 0.92,
      },
      ...touchContext,
    },
    label: "dismiss iOS App Switcher",
    rationale: "The camera sees scaled app cards; tapping verified empty background returns to the underlying Home page.",
    confidence: 0.94,
    completesGoal,
    requiresVisualChange: true,
  });
}

function wakeScreenPlan(observation: ScreenObservation): PlanDecision {
  return actionPlan({
    kind: "wake_screen",
    action: {
      type: "tap",
      point: {
        x: observation.viewport.width * 0.5,
        y: observation.viewport.height * 0.5,
      },
      viewport: observation.viewport,
      frameSequence: observation.sequence,
    },
    label: "wake sleeping screen",
    rationale: "The camera viewport is uniformly dark with no visible UI; one reversible center tap requests wake-up.",
    confidence: 0.99,
    completesGoal: false,
    requiresVisualChange: true,
  });
}

function recordObservationMetrics(
  metrics: {
    observations: number;
    ocrRuns: number;
    ocrCacheHits: number;
    observationMs: number[];
    ocrMs: number[];
  },
  observation: ScreenObservation,
) {
  metrics.observations += 1;
  metrics.observationMs.push(observation.observationElapsedMs);
  if (observation.ocrCacheHit) metrics.ocrCacheHits += 1;
  else {
    metrics.ocrRuns += 1;
    metrics.ocrMs.push(observation.ocrElapsedMs);
  }
}

function serializableObservation(observation: ScreenObservation) {
  return {
    ...observation,
    textSignature: [...observation.textSignature],
  };
}

function roundedAverage(values: number[]) {
  if (!values.length) return 0;
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length * 10,
  ) / 10;
}

function normalizedPoint(
  x: number | null,
  y: number | null,
  viewport: ScreenObservation["viewport"],
) {
  if (x === null || y === null) {
    throw new Error("The visual model omitted required normalized coordinates.");
  }
  return {
    x: Math.round(x * viewport.width * 100) / 100,
    y: Math.round(y * viewport.height * 100) / 100,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function assertGeneralPlanAllowed(
  plan: AgentPlan,
  observation: ScreenObservation,
  accessMode: "full_access" | "read_only",
  goal: string,
) {
  const policy = { mode: accessMode, app: "generic" as const };
  if (plan.action.type === "tap" || plan.action.type === "long_press") {
    assertRealtimeTapAllowed(policy, {
      x: plan.action.point.x / observation.viewport.width,
      y: plan.action.point.y / observation.viewport.height,
    }, plan.label);
  } else if (plan.action.type === "input_text") {
    assertRealtimeTextInputAllowed(policy, plan.label);
  } else if (plan.action.type === "phone_key") {
    assertRealtimePhoneKeyAllowed(policy, plan.action.key, plan.label);
  }
  if (accessMode !== "full_access") return;
  const mutation = mutationKind(plan.label);
  if (!mutation || goalAuthorizesMutation(goal, mutation)) return;
  throw new Error(
    `The visual planner proposed ${mutation}, but the user's goal did not request that external effect.`,
  );
}

function mutationKind(label: string) {
  const normalized = label.normalize("NFKC").toLocaleLowerCase("en-US");
  if (/like|heart|点赞/u.test(normalized)) return "like";
  if (/follow|subscribe|关注/u.test(normalized)) return "follow";
  if (/comment|评论/u.test(normalized)) return "comment";
  if (/send|message|reply|发送|私信|回复/u.test(normalized)) return "send";
  if (/share|分享/u.test(normalized)) return "share";
  if (/publish|post|发布/u.test(normalized)) return "publish";
  if (/delete|remove|删除/u.test(normalized)) return "delete";
  return null;
}

function goalAuthorizesMutation(goal: string, mutation: string) {
  const normalized = goal.normalize("NFKC").toLocaleLowerCase("en-US");
  const patterns: Record<string, RegExp> = {
    like: /like|heart|点赞/u,
    follow: /follow|subscribe|关注/u,
    comment: /comment|评论|留言/u,
    send: /send|message|reply|chat|发送|私信|回复|聊天/u,
    share: /share|分享/u,
    publish: /publish|post|upload|发布|发作品|上传/u,
    delete: /delete|remove|删除/u,
  };
  return patterns[mutation]?.test(normalized) === true;
}
