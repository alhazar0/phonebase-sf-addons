import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ActiveWorldSession } from "../active-world/session";
import type { ActiveWorldSessionSummary } from "../active-world/types";
import { ScreenHandGeneralAgentClient } from "../general-agent-client";
import { shutdownVisionOcrDaemon } from "../vision-ocr";
import { RealtimeActionScheduler } from "./action-scheduler";
import { RealtimeFrameHub } from "./frame-hub";
import { LatencyRecorder } from "./latency-recorder";
import {
  RealtimePerceptionStream,
  type RealtimePerceptionStreamSummary,
} from "./perception-stream";
import { RealtimeScreenPerception } from "./screen-state";
import {
  RealtimeVisualServoShadowStream,
  type RealtimeVisualServoShadowSummary,
} from "./visual-servo-stream";
import {
  InstagramProfileInspectionSkill,
  type InstagramProfileInspectionResult,
} from "./instagram-skill";
import {
  compileInstagramProfileTask,
  isInstagramProfileInspectionGoal,
  type InstagramProfileInspectionProgram,
} from "./instagram-task";
import {
  TikTokRealtimeSkill,
  type RealtimeSkillEvent,
  type TikTokSkillResult,
} from "./tiktok-skill";
import { compileRealtimeTask, type RealtimeTaskProgram } from "./task-program";

export type RealtimeAgentRunOptions = {
  deviceId: string;
  apiUrl?: string;
  mode: "dry_run" | "execute";
  accessMode?: "full_access" | "read_only";
  timeoutMs?: number;
  artifactDirectory?: string;
  onEvent?: (event: RealtimeSkillEvent) => void;
  keepVisionOcrWarm?: boolean;
  continuousPerception?: boolean;
  visualServoShadow?: boolean;
};

export type RealtimeAgentRunResult = {
  runId: string;
  status: "planned" | "completed" | "failed" | "timed_out";
  goal: string;
  mode: "dry_run" | "execute";
  accessMode: "full_access" | "read_only";
  program: RealtimeTaskProgram | InstagramProfileInspectionProgram;
  startedAt: number;
  completedAt: number;
  initialScreen?: {
    kind: string;
    confidence: number;
    sequence: number;
    ocrMs: number;
  };
  skill?: TikTokSkillResult | InstagramProfileInspectionResult;
  error?: string;
  events: RealtimeSkillEvent[];
  metrics: ReturnType<LatencyRecorder["snapshot"]>;
  perceptionStream?: RealtimePerceptionStreamSummary;
  visualServoShadow?: RealtimeVisualServoShadowSummary;
  activeWorld?: ActiveWorldSessionSummary;
};

export class RealtimeMobileAgent {
  async run(goal: string, options: RealtimeAgentRunOptions): Promise<RealtimeAgentRunResult> {
    const runId = `realtime-${randomUUID()}`;
    const startedAt = Date.now();
    const accessMode = options.accessMode ?? "full_access";
    const metrics = new LatencyRecorder();
    const instagramInspection = isInstagramProfileInspectionGoal(goal);
    const program = metrics.measureSync("planning", "compile-task", () =>
      instagramInspection
        ? compileInstagramProfileTask(goal)
        : compileRealtimeTask(goal), {
      goalLength: goal.length,
      taskFamily: instagramInspection ? "instagram-profile-inspection" : "realtime-task",
    });
    const events: RealtimeSkillEvent[] = [];
    const emit = (
      phase: string,
      label: string,
      detail?: Record<string, unknown>,
    ) => {
      const event = { at: Date.now(), phase, label, ...(detail ? { detail } : {}) };
      events.push(event);
      options.onEvent?.(event);
    };
    const controller = new AbortController();
    const browseDurationMs = "browseDurationMs" in program ? program.browseDurationMs : 0;
    const timeoutMs = options.timeoutMs ?? Math.max(60_000, browseDurationMs + 120_000);
    const timeout = setTimeout(
      () => controller.abort(new Error(`Realtime agent timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
    const frames = new RealtimeFrameHub({
      deviceId: options.deviceId,
      controlPlaneUrl: options.apiUrl,
      modelLongEdge: 1_024,
      onFrame: (packet) => metrics.recordSample(
        "frame_transport",
        "camera-to-runtime",
        packet.transportLatencyMs,
        {
          sequence: packet.metadata.sequence,
          capturedAt: packet.metadata.capturedAt,
          receivedAt: packet.receivedAt,
          source: packet.metadata.source,
          role: packet.metadata.role,
        },
      ),
    });

    let initialScreen: RealtimeAgentRunResult["initialScreen"];
    let skill: TikTokSkillResult | InstagramProfileInspectionResult | undefined;
    let activeWorld: ActiveWorldSession | undefined;
    let activeWorldSummary: ActiveWorldSessionSummary | undefined;
    let perceptionStream: RealtimePerceptionStream | undefined;
    let perceptionStreamSummary: RealtimePerceptionStreamSummary | undefined;
    let visualServoShadow: RealtimeVisualServoShadowStream | undefined;
    let visualServoShadowSummary: RealtimeVisualServoShadowSummary | undefined;
    let status: RealtimeAgentRunResult["status"] = "failed";
    let error: string | undefined;
    try {
      try {
        activeWorld = await metrics.measure("runtime", "active-world-open", () =>
          ActiveWorldSession.open({
            runId,
            deviceId: options.deviceId,
            goal,
            mode: options.mode,
            startedAt,
            journalPath: resolve(
              options.artifactDirectory ?? "build/runtime",
              `${runId}.transitions.jsonl`,
            ),
          }));
        emit("memory", "active-world-ready", {
          journalPath: resolve(
            options.artifactDirectory ?? "build/runtime",
            `${runId}.transitions.jsonl`,
          ),
        });
      } catch (cause) {
        emit("memory", "active-world-disabled", { error: errorMessage(cause) });
      }
      await metrics.measure("transport", "connect-live-camera", () => frames.start(controller.signal));
      const client = new ScreenHandGeneralAgentClient(options.deviceId, options.apiUrl);
      if (options.visualServoShadow !== false) {
        try {
          visualServoShadow = new RealtimeVisualServoShadowStream(frames, client, metrics);
          const visualServo = await visualServoShadow.initialize(controller.signal);
          const visualServoStatus = visualServoShadow.summary();
          emit("visual_servo", "shadow-ready", {
            sequence: visualServo?.sequence ?? null,
            planeStatus: visualServo?.plane.status ?? null,
            templateCalibrated: visualServo?.templateCalibrated ?? false,
            contactAnchorStatus: visualServoStatus.contactAnchor.status,
            contactAnchorReason: visualServoStatus.contactAnchor.reason,
            wouldMoveHardware: false,
          });
        } catch (cause) {
          visualServoShadow = undefined;
          emit("visual_servo", "shadow-disabled", { error: errorMessage(cause) });
        }
      }
      const perception = new RealtimeScreenPerception(
        frames,
        metrics,
        undefined,
        undefined,
        (state) => activeWorld?.observe(state),
      );
      const actions = new RealtimeActionScheduler(
        client,
        frames,
        metrics,
        instagramInspection
          ? { mode: accessMode, app: "instagram" }
          : { mode: "full_access", app: "tiktok" },
        activeWorld
          ? {
              onStarted: (event) => {
                activeWorld?.actionStarted(event);
                visualServoShadow?.actionStarted(event);
              },
              onCompleted: (event) => {
                activeWorld?.actionCompleted(event);
                visualServoShadow?.actionFinished(event.executionId);
              },
              onFailed: (event) => {
                activeWorld?.actionFailed(event);
                visualServoShadow?.actionFinished(event.executionId);
              },
            }
          : visualServoShadow
            ? {
                onStarted: (event) => visualServoShadow?.actionStarted(event),
                onCompleted: (event) => visualServoShadow?.actionFinished(event.executionId),
                onFailed: (event) => visualServoShadow?.actionFinished(event.executionId),
              }
            : undefined,
      );
      const initial = await perception.observeLatest();
      initialScreen = {
        kind: initial.kind,
        confidence: initial.confidence,
        sequence: initial.observation.sequence,
        ocrMs: initial.observation.ocrElapsedMs,
      };
      emit("perception", "runtime-ready", initialScreen);

      if (options.mode === "dry_run") {
        status = "planned";
      } else {
        if (options.continuousPerception !== false) {
          perceptionStream = new RealtimePerceptionStream(frames, perception, metrics);
          perceptionStream.start(controller.signal);
          emit("perception", "continuous-perception-started", {
            afterSequence: initial.observation.sequence,
          });
        }
        if (visualServoShadow) {
          visualServoShadow.start(controller.signal);
          emit("visual_servo", "shadow-started", { wouldMoveHardware: false });
        }
        const context = {
          frames,
          perception,
          actions,
          metrics,
          signal: controller.signal,
          emit,
          artifactDirectory: options.artifactDirectory,
        };
        skill = instagramInspection
          ? await new InstagramProfileInspectionSkill(context).run(
              program as InstagramProfileInspectionProgram,
            )
          : await new TikTokRealtimeSkill(context).run(program as RealtimeTaskProgram);
        status = "completed";
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      status = controller.signal.aborted ? "timed_out" : "failed";
      emit("error", status, { error });
    } finally {
      clearTimeout(timeout);
      if (perceptionStream) {
        perceptionStreamSummary = await metrics.measure(
          "runtime",
          "continuous-perception-stop",
          () => perceptionStream!.stop(),
        );
        emit("perception", "continuous-perception-finished", {
          observations: perceptionStreamSummary.observations,
          skippedFrames: perceptionStreamSummary.skippedFrames,
          lastObservedSequence: perceptionStreamSummary.lastObservedSequence,
          waitTimeouts: perceptionStreamSummary.waitTimeouts,
          ...(perceptionStreamSummary.error
            ? { error: perceptionStreamSummary.error }
            : {}),
        });
      }
      if (visualServoShadow) {
        visualServoShadowSummary = await metrics.measure(
          "runtime",
          "visual-servo-shadow-stop",
          () => visualServoShadow!.stop(),
        );
        emit("visual_servo", "shadow-finished", {
          observations: visualServoShadowSummary.observations,
          planeUpdates: visualServoShadowSummary.planeUpdates,
          tipTracks: visualServoShadowSummary.tipTracks,
          correctionsProposed: visualServoShadowSummary.correctionsProposed,
          correctionHolds: visualServoShadowSummary.correctionHolds,
          contactAnchorStatus: visualServoShadowSummary.contactAnchor.status,
          contactAnchorReason: visualServoShadowSummary.contactAnchor.reason,
          contactDepthSamples: visualServoShadowSummary.contactDepthSamples,
          anchoredContactDepthSamples:
            visualServoShadowSummary.anchoredContactDepthSamples,
          contactDepthEvaluations: visualServoShadowSummary.contactDepthEvaluations,
          contactDepthResult:
            visualServoShadowSummary.lastContactDepthEvaluation?.result.reason ?? null,
          wouldMoveHardware: false,
          ...(visualServoShadowSummary.error
            ? { error: visualServoShadowSummary.error }
            : {}),
        });
      }
      if (activeWorld) {
        activeWorldSummary = await metrics.measure(
          "runtime",
          "active-world-finish",
          () => activeWorld!.finish(status),
        );
        emit("memory", "active-world-finished", {
          observations: activeWorldSummary.observations,
          transitions: activeWorldSummary.transitions,
          verifiedTransitions: activeWorldSummary.verifiedTransitions,
          journalWriteErrors: activeWorldSummary.journalWriteErrors,
        });
      }
      frames.close();
      if (!options.keepVisionOcrWarm) {
        await metrics.measure("runtime", "vision-ocr-shutdown", shutdownVisionOcrDaemon);
      }
    }

    return {
      runId,
      status,
      goal,
      mode: options.mode,
      accessMode,
      program,
      startedAt,
      completedAt: Date.now(),
      ...(initialScreen ? { initialScreen } : {}),
      ...(skill ? { skill } : {}),
      ...(error ? { error } : {}),
      events,
      metrics: metrics.snapshot(),
      ...(perceptionStreamSummary
        ? { perceptionStream: perceptionStreamSummary }
        : {}),
      ...(visualServoShadowSummary
        ? { visualServoShadow: visualServoShadowSummary }
        : {}),
      ...(activeWorldSummary ? { activeWorld: activeWorldSummary } : {}),
    };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
