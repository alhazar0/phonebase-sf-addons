import type { ScreenHandGeneralAgentClient } from "../general-agent-client";
import type { ContactDepthShadowInput } from "../active-world/contact-depth-shadow";
import {
  VisualServoShadowCoordinator,
  type VisualServoKinematics,
  type VisualServoShadowObservation,
  type VisualServoShadowSummary,
} from "../active-world/visual-servo-shadow";
import type { RealtimeActionLifecycleEvent } from "./action-scheduler";
import type { RealtimeFrameHub, RealtimeFramePacket } from "./frame-hub";
import type { LatencyRecorder } from "./latency-recorder";
import {
  bindRealtimeContactAnchorToProfile,
  loadRealtimeContactAnchor,
  type RealtimeContactAnchorLoadResult,
} from "./contact-anchor-loader";

export type RealtimeVisualServoShadowOptions = {
  kinematicsPollIntervalMs?: number;
  frameWaitTimeoutMs?: number;
  contactAnchorLoader?: (
    deviceId: string,
  ) => Promise<RealtimeContactAnchorLoadResult>;
};

export type RealtimeVisualServoShadowSummary = VisualServoShadowSummary & {
  initialized: boolean;
  running: boolean;
  skippedFrames: number;
  waitTimeouts: number;
  kinematicsReads: number;
  kinematicsErrors: number;
  observationErrors: number;
  contactAnchor: RealtimeContactAnchorLoadResult | {
    status: "not-loaded";
    reason: "stream-not-initialized";
  };
  error?: string;
  lastObservation?: {
    sequence: number;
    planeStatus: string;
    tipStatus: string | null;
    correctionStatus: string | null;
    correctionReason: string | null;
    contactDepthSampled: boolean;
    contactDepthEligible: boolean;
  };
};

/** Runs passive camera servo estimation beside the action scheduler. */
export class RealtimeVisualServoShadowStream {
  private readonly kinematicsPollIntervalMs: number;
  private readonly frameWaitTimeoutMs: number;
  private readonly contactAnchorLoader: NonNullable<
    RealtimeVisualServoShadowOptions["contactAnchorLoader"]
  >;
  private coordinator: VisualServoShadowCoordinator | null = null;
  private controller: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private removeParentAbort: (() => void) | null = null;
  private kinematics: VisualServoKinematics | null = null;
  private nextKinematicsReadAt = 0;
  private lastSequence = 0;
  private skippedFrames = 0;
  private waitTimeouts = 0;
  private kinematicsReads = 0;
  private kinematicsErrors = 0;
  private observationErrors = 0;
  private lastError: string | undefined;
  private lastObservation: VisualServoShadowObservation | null = null;
  private contactAnchor: RealtimeVisualServoShadowSummary["contactAnchor"] = {
    status: "not-loaded",
    reason: "stream-not-initialized",
  };

  constructor(
    private readonly frames: RealtimeFrameHub,
    private readonly client: ScreenHandGeneralAgentClient,
    private readonly metrics: LatencyRecorder,
    options: RealtimeVisualServoShadowOptions = {},
  ) {
    this.kinematicsPollIntervalMs = boundedInteger(
      options.kinematicsPollIntervalMs,
      20,
      2_000,
      50,
    );
    this.frameWaitTimeoutMs = boundedInteger(
      options.frameWaitTimeoutMs,
      50,
      30_000,
      1_000,
    );
    this.contactAnchorLoader = options.contactAnchorLoader ??
      ((deviceId) => loadRealtimeContactAnchor(deviceId));
  }

  async initialize(signal?: AbortSignal) {
    if (this.coordinator) return this.lastObservation;
    const packet = requirePacket(this.frames.latest());
    const points = packet.metadata.imagePoints;
    if (!packet.metadata.rectified || !points || points.length !== 4) {
      throw new Error("Visual servo requires a camera frame with four trusted phone corners.");
    }
    const [calibration, device, contactAnchor] = await Promise.all([
      this.client.getCalibration(signal),
      this.client.getDevice(signal),
      this.contactAnchorLoader(this.client.deviceId),
    ]);
    if (!calibration) throw new Error("Visual servo requires an active calibration profile.");
    if (
      calibration.frame.width !== packet.metadata.rawWidth ||
      calibration.frame.height !== packet.metadata.rawHeight
    ) throw new Error("Visual servo calibration does not match the raw camera resolution.");
    const boundContactAnchor = bindRealtimeContactAnchorToProfile(
      contactAnchor,
      calibration,
    );
    this.contactAnchor = boundContactAnchor;
    const hardware = contactDepthHardware(device);
    this.coordinator = new VisualServoShadowCoordinator({
      calibration,
      frame: {
        width: packet.metadata.rawWidth,
        height: packet.metadata.rawHeight,
      },
      referencePoints: [points[0], points[1], points[2], points[3]],
      ...(boundContactAnchor.status === "ready"
        ? {
            contactAnchor: {
              artifact: boundContactAnchor.artifact,
              stationPlaneSha256: boundContactAnchor.stationPlaneSha256,
            },
          }
        : {}),
      ...(hardware
        ? { contactDepthHardware: hardware }
        : {}),
    });
    this.kinematics = deviceKinematics(device);
    this.kinematicsReads = 1;
    this.nextKinematicsReadAt = Date.now() + this.kinematicsPollIntervalMs;
    this.lastSequence = packet.metadata.sequence;
    this.lastObservation = await this.observePacket(packet);
    return this.lastObservation;
  }

  start(parentSignal?: AbortSignal) {
    if (!this.coordinator) throw new Error("Visual servo Shadow stream must be initialized first.");
    if (this.runPromise) return;
    const controller = new AbortController();
    this.controller = controller;
    if (parentSignal) {
      const onAbort = () => controller.abort(parentSignal.reason);
      if (parentSignal.aborted) onAbort();
      else parentSignal.addEventListener("abort", onAbort, { once: true });
      this.removeParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
    }
    this.runPromise = this.run(controller.signal).catch((error) => {
      if (!controller.signal.aborted) this.lastError = errorMessage(error);
    });
  }

  async stop() {
    this.controller?.abort(new Error("Visual servo Shadow stream stopped."));
    await this.runPromise;
    this.removeParentAbort?.();
    this.removeParentAbort = null;
    this.controller = null;
    this.runPromise = null;
    return this.summary();
  }

  actionStarted(event: RealtimeActionLifecycleEvent) {
    this.coordinator?.beginAction(event);
  }

  actionFinished(executionId: string) {
    this.coordinator?.finishAction(executionId);
  }

  summary(): RealtimeVisualServoShadowSummary {
    const coordinator = this.coordinator?.summary() ?? emptyCoordinatorSummary();
    return {
      ...coordinator,
      initialized: this.coordinator !== null,
      running: this.runPromise !== null && this.controller?.signal.aborted !== true,
      skippedFrames: this.skippedFrames,
      waitTimeouts: this.waitTimeouts,
      kinematicsReads: this.kinematicsReads,
      kinematicsErrors: this.kinematicsErrors,
      observationErrors: this.observationErrors,
      contactAnchor: this.contactAnchor,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.lastObservation
        ? {
            lastObservation: {
              sequence: this.lastObservation.sequence,
              planeStatus: this.lastObservation.plane.status,
              tipStatus: this.lastObservation.tip?.status ?? null,
              correctionStatus: this.lastObservation.correction?.status ?? null,
              correctionReason: this.lastObservation.correction?.reason ?? null,
              contactDepthSampled: this.lastObservation.contactDepthSample !== null,
              contactDepthEligible:
                this.lastObservation.contactDepthSample?.eligibleForContactEstimate ?? false,
            },
          }
        : {}),
    };
  }

  private async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.frames.waitForFrame(this.lastSequence, this.frameWaitTimeoutMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (isFrameWaitTimeout(error)) {
          this.waitTimeouts += 1;
          continue;
        }
        throw error;
      }
      const packet = requirePacket(this.frames.latest());
      if (packet.metadata.sequence <= this.lastSequence) continue;
      this.skippedFrames += Math.max(0, packet.metadata.sequence - this.lastSequence - 1);
      this.lastSequence = packet.metadata.sequence;
      if (Date.now() >= this.nextKinematicsReadAt) await this.refreshKinematics(signal);
      try {
        this.lastObservation = await this.observePacket(packet);
      } catch (error) {
        this.observationErrors += 1;
        this.metrics.record("visual_servo", "shadow-observation-error", 0, {
          sequence: packet.metadata.sequence,
          error: errorMessage(error),
        });
      }
    }
  }

  private async refreshKinematics(signal: AbortSignal) {
    this.nextKinematicsReadAt = Date.now() + this.kinematicsPollIntervalMs;
    try {
      this.kinematics = deviceKinematics(await this.client.getDevice(signal));
      this.kinematicsReads += 1;
    } catch (error) {
      this.kinematicsErrors += 1;
      this.metrics.record("visual_servo", "kinematics-read-error", 0, {
        error: errorMessage(error),
      });
    }
  }

  private async observePacket(packet: RealtimeFramePacket) {
    if (!this.coordinator) throw new Error("Visual servo Shadow coordinator is unavailable.");
    const startedAt = performance.now();
    const observation = await this.coordinator.observe({
      bytes: packet.bytes,
      width: packet.metadata.rawWidth,
      height: packet.metadata.rawHeight,
      sequence: packet.metadata.sequence,
      capturedAt: packet.metadata.capturedAt,
    }, this.kinematics);
    this.metrics.record(
      "visual_servo",
      "shadow-observe",
      performance.now() - startedAt,
      {
        sequence: packet.metadata.sequence,
        planeStatus: observation.plane.status,
        tipStatus: observation.tip?.status ?? null,
        correctionStatus: observation.correction?.status ?? null,
        contactDepthSampled: observation.contactDepthSample !== null,
        contactDepthEligible:
          observation.contactDepthSample?.eligibleForContactEstimate ?? false,
        wouldMoveHardware: false,
      },
    );
    return observation;
  }
}

export function deviceKinematics(
  device: Awaited<ReturnType<ScreenHandGeneralAgentClient["getDevice"]>>,
): VisualServoKinematics | null {
  const state = device.state?.grbl;
  const x = Number(state?.x);
  const y = Number(state?.y);
  const z = Number(state?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return {
    point: { x, y },
    physicalZMm: typeof state?.physicalZ === "number" &&
        Number.isFinite(state.physicalZ)
      ? state.physicalZ
      : null,
    observedAt: Date.now(),
    safeForTemplateCalibration: state?.state === "Idle" &&
      Math.abs(z) <= 0.05 &&
      !state.activeOperation &&
      !state.liveTouch,
  };
}

function requirePacket(packet: RealtimeFramePacket | null) {
  if (!packet) throw new Error("Realtime camera has not produced a raw frame.");
  return packet;
}

function isFrameWaitTimeout(error: unknown) {
  return error instanceof Error && /No camera frame newer than .* arrived within/u.test(
    error.message,
  );
}

function emptyCoordinatorSummary(): VisualServoShadowSummary {
  return {
    observations: 0,
    planeUpdates: 0,
    planeUnsafe: 0,
    tipTracks: 0,
    tipUnsafe: 0,
    templatesCalibrated: 0,
    correctionsProposed: 0,
    correctionsSettled: 0,
    correctionHolds: 0,
    contactDepthActionsObserved: 0,
    contactDepthSamples: 0,
    anchoredContactDepthSamples: 0,
    contactDepthEvaluations: 0,
    contactAnchorConfigured: false,
    lastContactDepthEvaluation: null,
    averagePlaneMs: 0,
    averageTipMs: 0,
    activeTarget: false,
    lastSequence: 0,
  };
}

function contactDepthHardware(
  device: Awaited<ReturnType<ScreenHandGeneralAgentClient["getDevice"]>>,
): ContactDepthShadowInput["hardware"] | null {
  const profile = device.state?.grbl?.tapProfile;
  const hoverZMm = profile?.hoverZ;
  const minimumTouchZMm = profile?.minimumTouchZ;
  const maximumTouchZMm = profile?.maximumTouchZ;
  if (
    typeof hoverZMm !== "number" || !Number.isFinite(hoverZMm) ||
    typeof minimumTouchZMm !== "number" || !Number.isFinite(minimumTouchZMm) ||
    typeof maximumTouchZMm !== "number" || !Number.isFinite(maximumTouchZMm) ||
    hoverZMm >= minimumTouchZMm || minimumTouchZMm > maximumTouchZMm
  ) return null;
  return { hoverZMm, minimumTouchZMm, maximumTouchZMm };
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
