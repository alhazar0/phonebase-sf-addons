import type { ScreenHandSemanticAction } from "../action-contract";
import {
  calibratedScreenPoint,
  type ScreenHandCalibrationProfile,
} from "../calibration-profile";
import {
  homographyFromFourPoints,
  projectPoint,
  type Point,
} from "../homography";
import type { ScreenQuad } from "../vision-screen";
import {
  PhonePlaneTracker,
  type PhonePlaneDetector,
  type PhonePlaneFrame,
  type PhonePlaneTrack,
} from "./phone-plane-tracker";
import {
  evaluateTargetIntersectionContactDepthShadow,
  type CameraContactTargetSample,
  type CameraZTrajectorySample,
  type ContactDepthShadowInput,
  type ContactDepthShadowResult,
} from "./contact-depth-shadow";
import {
  StylusTipTracker,
  type StylusTipTrack,
} from "./stylus-tip-tracker";
import {
  ToolContactAnchorProjector,
  type ToolContactAnchorArtifact,
  type ToolContactAnchorProjectionReason,
} from "./tool-contact-anchor";
import {
  evaluateVisualServoCorrection,
  type VisualServoCorrection,
} from "./visual-servo-controller";

export type VisualServoKinematics = {
  point: Point;
  /** Absolute controller-space Z. Null means the bridge did not expose it. */
  physicalZMm: number | null;
  observedAt: number;
  safeForTemplateCalibration: boolean;
};

export type VisualServoContactDepthSample = {
  executionId: string;
  sequence: number;
  physicalZMm: number;
  markerPoint: Point;
  markerConfidence: number;
  targetCameraPoint: Point;
  targetConfidence: number;
  frameAgeMs: number;
  kinematicsAgeMs: number;
  /** The tracker follows a tool-template anchor, not the conductive endpoint.
   * A station-bound tool-contact artifact must project it to the real tip. */
  markerPointReference: "tracked-template-anchor-camera-point";
  contactTipCameraPoint: Point | null;
  contactTipPointReference: "absolute-contact-camera-point" | null;
  contactTipConfidence: number | null;
  contactAnchorReason: ToolContactAnchorProjectionReason | "anchor-not-configured";
  eligibleForContactEstimate: boolean;
  wouldMoveHardware: false;
};

export type VisualServoShadowObservation = {
  sequence: number;
  plane: PhonePlaneTrack;
  planeUpdated: boolean;
  tip: StylusTipTrack | null;
  templateCalibrated: boolean;
  correction: VisualServoCorrection | null;
  activeTarget: {
    executionId: string;
    label: string;
    point: Point;
    machinePoint: Point;
    sourceFrameSequence: number;
  } | null;
  contactDepthSample: VisualServoContactDepthSample | null;
  wouldMoveHardware: false;
};

export type VisualServoShadowSummary = {
  observations: number;
  planeUpdates: number;
  planeUnsafe: number;
  tipTracks: number;
  tipUnsafe: number;
  templatesCalibrated: number;
  correctionsProposed: number;
  correctionsSettled: number;
  correctionHolds: number;
  contactDepthActionsObserved: number;
  contactDepthSamples: number;
  anchoredContactDepthSamples: number;
  contactDepthEvaluations: number;
  contactAnchorConfigured: boolean;
  lastContactDepthEvaluation: {
    executionId: string;
    result: ContactDepthShadowResult;
  } | null;
  averagePlaneMs: number;
  averageTipMs: number;
  activeTarget: boolean;
  lastSequence: number;
};

export type VisualServoShadowOptions = {
  calibration: ScreenHandCalibrationProfile;
  frame: { width: number; height: number };
  referencePoints: ScreenQuad;
  planeIntervalMs?: number;
  maximumKinematicsAgeMs?: number;
  maximumContactSampleXyErrorMm?: number;
  minimumContactSampleZDeltaMm?: number;
  contactAnchor?: {
    artifact: ToolContactAnchorArtifact;
    stationPlaneSha256: string;
  };
  contactDepthHardware?: ContactDepthShadowInput["hardware"];
  planeDetector?: PhonePlaneDetector;
};

/**
 * Coordinates the slow phone-plane loop and fast stylus loop, then evaluates
 * bounded corrections in Shadow mode. It deliberately has no motor client.
 */
export class VisualServoShadowCoordinator {
  private readonly phonePlane: PhonePlaneTracker;
  private readonly stylusTip: StylusTipTracker;
  private readonly planeIntervalMs: number;
  private readonly maximumKinematicsAgeMs: number;
  private readonly maximumContactSampleXyErrorMm: number;
  private readonly minimumContactSampleZDeltaMm: number;
  private readonly contactAnchorProjector: ToolContactAnchorProjector | null;
  private activeTarget: VisualServoShadowObservation["activeTarget"] = null;
  private contactDepthTrace: {
    executionId: string;
    lastPhysicalZMm: number | null;
    approachOpen: boolean;
    trajectory: CameraZTrajectorySample[];
    targets: CameraContactTargetSample[];
  } | null = null;
  private lastPlaneCapturedAt = Number.NEGATIVE_INFINITY;
  private observations = 0;
  private planeUpdates = 0;
  private planeUnsafe = 0;
  private tipTracks = 0;
  private tipUnsafe = 0;
  private templatesCalibrated = 0;
  private correctionsProposed = 0;
  private correctionsSettled = 0;
  private correctionHolds = 0;
  private contactDepthActionsObserved = 0;
  private contactDepthSamples = 0;
  private anchoredContactDepthSamples = 0;
  private contactDepthEvaluations = 0;
  private lastContactDepthEvaluation: VisualServoShadowSummary[
    "lastContactDepthEvaluation"
  ] = null;
  private planeDurations: number[] = [];
  private tipDurations: number[] = [];
  private lastSequence = 0;

  constructor(private readonly options: VisualServoShadowOptions) {
    this.planeIntervalMs = boundedNumber(options.planeIntervalMs, 10, 2_000, 50);
    this.maximumKinematicsAgeMs = boundedNumber(
      options.maximumKinematicsAgeMs,
      20,
      2_000,
      120,
    );
    this.maximumContactSampleXyErrorMm = boundedNumber(
      options.maximumContactSampleXyErrorMm,
      0.1,
      10,
      1,
    );
    this.minimumContactSampleZDeltaMm = boundedNumber(
      options.minimumContactSampleZDeltaMm,
      0.01,
      2,
      0.05,
    );
    this.contactAnchorProjector = options.contactAnchor
      ? new ToolContactAnchorProjector(options.contactAnchor.artifact)
      : null;
    this.phonePlane = new PhonePlaneTracker({
      frame: options.frame,
      screen: options.calibration.screen,
      referencePoints: options.referencePoints,
      detector: options.planeDetector,
    });
    this.stylusTip = new StylusTipTracker({ frame: options.frame });
  }

  beginAction(input: {
    executionId: string;
    label: string;
    action: ScreenHandSemanticAction;
  }) {
    this.activeTarget = null;
    this.contactDepthTrace = null;
    if (input.action.type !== "tap" && input.action.type !== "long_press") return;
    const point = scalePoint(
      input.action.point,
      input.action.viewport,
      this.options.calibration.screen,
    );
    this.activeTarget = {
      executionId: input.executionId,
      label: input.label,
      point,
      machinePoint: calibratedScreenPoint(this.options.calibration, point),
      sourceFrameSequence: input.action.frameSequence,
    };
    this.contactDepthTrace = {
      executionId: input.executionId,
      lastPhysicalZMm: null,
      approachOpen: true,
      trajectory: [],
      targets: [],
    };
    this.contactDepthActionsObserved += 1;
  }

  finishAction(executionId: string) {
    if (this.activeTarget?.executionId === executionId) {
      if (
        this.contactDepthTrace?.trajectory.length &&
        this.options.contactDepthHardware
      ) {
        this.lastContactDepthEvaluation = {
          executionId,
          result: evaluateTargetIntersectionContactDepthShadow({
            trajectory: this.contactDepthTrace.trajectory,
            targets: this.contactDepthTrace.targets,
            hardware: this.options.contactDepthHardware,
          }),
        };
        this.contactDepthEvaluations += 1;
      }
      this.activeTarget = null;
      this.contactDepthTrace = null;
    }
  }

  async observe(
    frame: PhonePlaneFrame,
    kinematics: VisualServoKinematics | null,
  ): Promise<VisualServoShadowObservation> {
    const shouldUpdatePlane = !this.phonePlane.latest()?.safeForFeedForward ||
      frame.capturedAt - this.lastPlaneCapturedAt >= this.planeIntervalMs;
    let plane = this.phonePlane.latest();
    if (shouldUpdatePlane || !plane) {
      plane = await this.phonePlane.update(frame);
      this.lastPlaneCapturedAt = frame.capturedAt;
      this.planeUpdates += 1;
      this.planeDurations.push(plane.detectorElapsedMs);
      if (plane.status === "unsafe") this.planeUnsafe += 1;
    }
    this.observations += 1;
    this.lastSequence = Math.max(this.lastSequence, frame.sequence);

    let templateCalibrated = false;
    let tip: StylusTipTrack | null = null;
    const predicted = plane.points && kinematics
      ? projectMachinePoint(
          kinematics.point,
          this.options.calibration.controlMachinePoints ??
            this.options.calibration.machinePoints,
          plane.points,
        )
      : this.stylusTip.latest()?.point ?? null;
    if (
      predicted &&
      !this.stylusTip.isCalibrated() &&
      kinematics?.safeForTemplateCalibration &&
      plane.safeForCorrection
    ) {
      await this.stylusTip.calibrate(frame, predicted);
      this.templatesCalibrated += 1;
      templateCalibrated = true;
    } else if (predicted && this.stylusTip.isCalibrated()) {
      tip = await this.stylusTip.update(frame, predicted);
      this.tipDurations.push(tip.elapsedMs);
      if (tip.status === "tracking") this.tipTracks += 1;
      else this.tipUnsafe += 1;
    }

    let correction: VisualServoCorrection | null = null;
    const kinematicsAgeMs = kinematics
      ? Math.max(0, Date.now() - kinematics.observedAt)
      : Number.POSITIVE_INFINITY;
    const frameAgeMs = Math.max(0, Date.now() - frame.capturedAt);
    const targetCameraPoint = this.activeTarget && plane.points
      ? this.phonePlane.projectScreenPoint(this.activeTarget.point)
      : null;
    if (
      this.activeTarget &&
      plane.points &&
      tip?.point &&
      kinematics &&
      kinematicsAgeMs <= this.maximumKinematicsAgeMs
    ) {
      correction = evaluateVisualServoCorrection({
        phonePoints: plane.points,
        controlMachinePoints: this.options.calibration.controlMachinePoints ??
          this.options.calibration.machinePoints,
        targetCameraPoint: targetCameraPoint!,
        observedTipCameraPoint: tip.point,
        currentMachinePoint: kinematics.point,
        safeMachineBounds: this.options.calibration.safeMachineBounds,
        phoneConfidence: plane.confidence,
        tipConfidence: tip.confidence,
        frameAgeMs,
        occluded: tip.occluded,
      });
      if (correction.status === "correct") this.correctionsProposed += 1;
      else if (correction.status === "settled") this.correctionsSettled += 1;
      else this.correctionHolds += 1;
    }

    const contactDepthSample = this.contactDepthSample({
      frame,
      plane,
      tip,
      kinematics,
      kinematicsAgeMs,
      frameAgeMs,
      targetCameraPoint,
    });

    return {
      sequence: frame.sequence,
      plane,
      planeUpdated: shouldUpdatePlane,
      tip,
      templateCalibrated,
      correction,
      activeTarget: this.activeTarget ? { ...this.activeTarget } : null,
      contactDepthSample,
      wouldMoveHardware: false,
    };
  }

  summary(): VisualServoShadowSummary {
    return {
      observations: this.observations,
      planeUpdates: this.planeUpdates,
      planeUnsafe: this.planeUnsafe,
      tipTracks: this.tipTracks,
      tipUnsafe: this.tipUnsafe,
      templatesCalibrated: this.templatesCalibrated,
      correctionsProposed: this.correctionsProposed,
      correctionsSettled: this.correctionsSettled,
      correctionHolds: this.correctionHolds,
      contactDepthActionsObserved: this.contactDepthActionsObserved,
      contactDepthSamples: this.contactDepthSamples,
      anchoredContactDepthSamples: this.anchoredContactDepthSamples,
      contactDepthEvaluations: this.contactDepthEvaluations,
      contactAnchorConfigured: this.contactAnchorProjector !== null,
      lastContactDepthEvaluation: this.lastContactDepthEvaluation
        ? {
            executionId: this.lastContactDepthEvaluation.executionId,
            result: { ...this.lastContactDepthEvaluation.result },
          }
        : null,
      averagePlaneMs: rounded(mean(this.planeDurations)),
      averageTipMs: rounded(mean(this.tipDurations)),
      activeTarget: this.activeTarget !== null,
      lastSequence: this.lastSequence,
    };
  }

  private contactDepthSample(input: {
    frame: PhonePlaneFrame;
    plane: PhonePlaneTrack;
    tip: StylusTipTrack | null;
    kinematics: VisualServoKinematics | null;
    kinematicsAgeMs: number;
    frameAgeMs: number;
    targetCameraPoint: Point | null;
  }): VisualServoContactDepthSample | null {
    const active = this.activeTarget;
    const trace = this.contactDepthTrace;
    const physicalZMm = input.kinematics?.physicalZMm;
    if (
      !active || !trace || trace.executionId !== active.executionId ||
      !trace.approachOpen || !input.plane.safeForCorrection ||
      input.tip?.status !== "tracking" || !input.tip.point || input.tip.occluded ||
      !input.kinematics || input.kinematicsAgeMs > this.maximumKinematicsAgeMs ||
      physicalZMm === null || !Number.isFinite(physicalZMm) ||
      !input.targetCameraPoint
    ) return null;
    const xyErrorMm = distance(input.kinematics.point, active.machinePoint);
    if (xyErrorMm > this.maximumContactSampleXyErrorMm) return null;
    const minimumZ = Math.min(
      this.options.calibration.tap.hoverZ,
      this.options.calibration.tap.touchZ,
    );
    const maximumZ = Math.max(
      this.options.calibration.tap.hoverZ,
      this.options.calibration.tap.touchZ,
    );
    if (physicalZMm < minimumZ - 0.05 || physicalZMm > maximumZ + 0.05) return null;
    if (trace.lastPhysicalZMm !== null) {
      if (physicalZMm < trace.lastPhysicalZMm - this.minimumContactSampleZDeltaMm) {
        trace.approachOpen = false;
        return null;
      }
      if (physicalZMm < trace.lastPhysicalZMm + this.minimumContactSampleZDeltaMm) {
        return null;
      }
    }
    trace.lastPhysicalZMm = physicalZMm;
    this.contactDepthSamples += 1;
    const anchor = this.contactAnchorProjector && this.options.contactAnchor
      ? this.contactAnchorProjector.project({
          deviceId: this.options.calibration.deviceId,
          stationPlaneSha256: this.options.contactAnchor.stationPlaneSha256,
          sourceProfileId: this.options.calibration.id,
          frame: this.options.frame,
          machinePoint: input.kinematics.point,
          physicalZMm,
          markerCameraPoint: input.tip.point,
          markerConfidence: input.tip.confidence,
          frameAgeMs: input.frameAgeMs,
        })
      : null;
    const anchored = anchor?.status === "anchored" &&
      anchor.contactTipCameraPoint !== null && anchor.pointReference !== null &&
      anchor.eligibleForContactDepthEstimate;
    if (anchored) {
      trace.trajectory.push({
        sequence: input.frame.sequence,
        commandedZMm: physicalZMm,
        markerPoint: { ...anchor.contactTipCameraPoint! },
        markerPointReference: anchor.pointReference!,
        markerConfidence: anchor.confidence,
        frameAgeMs: input.frameAgeMs,
      });
      trace.targets.push({
        sequence: input.frame.sequence,
        targetPoint: { ...input.targetCameraPoint },
        confidence: input.plane.confidence,
        frameAgeMs: input.frameAgeMs,
      });
      this.anchoredContactDepthSamples += 1;
    }
    return {
      executionId: active.executionId,
      sequence: input.frame.sequence,
      physicalZMm: rounded(physicalZMm),
      markerPoint: { ...input.tip.point },
      markerConfidence: input.tip.confidence,
      targetCameraPoint: { ...input.targetCameraPoint },
      targetConfidence: input.plane.confidence,
      frameAgeMs: rounded(input.frameAgeMs),
      kinematicsAgeMs: rounded(input.kinematicsAgeMs),
      markerPointReference: "tracked-template-anchor-camera-point",
      contactTipCameraPoint: anchor?.contactTipCameraPoint
        ? { ...anchor.contactTipCameraPoint }
        : null,
      contactTipPointReference: anchor?.pointReference ?? null,
      contactTipConfidence: anchor?.status === "anchored" ? anchor.confidence : null,
      contactAnchorReason: anchor?.reason ?? "anchor-not-configured",
      eligibleForContactEstimate: Boolean(anchored),
      wouldMoveHardware: false,
    };
  }
}

function projectMachinePoint(
  point: Point,
  machinePoints: ScreenQuad,
  cameraPoints: ScreenQuad,
) {
  return projectPoint(homographyFromFourPoints(machinePoints, cameraPoints), point);
}

function scalePoint(
  point: Point,
  source: { width: number; height: number },
  destination: { width: number; height: number },
) {
  return {
    x: point.x / source.width * destination.width,
    y: point.y / source.height * destination.height,
  };
}

function mean(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isFinite(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
