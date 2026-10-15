import {
  homographyFromFourPoints,
  projectPoint,
  type Homography,
  type Point,
} from "../homography";
import {
  candidatePoints,
  detectLuminousScreenCandidate,
  rankScreenCandidate,
  type ScreenQuad,
  type VisionScreenCandidate,
} from "../vision-screen";

export type PhonePlaneFrame = {
  bytes: Buffer;
  width: number;
  height: number;
  sequence: number;
  capturedAt: number;
};

export type PhonePlaneDetector = (
  imageBytes: Buffer,
  expectedScreenAspectRatio: number,
) => Promise<VisionScreenCandidate | null>;

export type PhonePlaneTrackStatus = "tracking" | "coasting" | "unsafe";

export type PhonePlaneTrackReason =
  | "observed"
  | "relocated-confirmed"
  | "screen-temporarily-hidden"
  | "screen-not-found"
  | "frame-size-changed"
  | "candidate-confidence-low"
  | "candidate-geometry-invalid"
  | "reference-drift-excessive"
  | "relocation-unconfirmed"
  | "detector-error";

export type PhonePlaneTrack = {
  status: PhonePlaneTrackStatus;
  reason: PhonePlaneTrackReason;
  sequence: number;
  capturedAt: number;
  observedAt: number;
  detectorElapsedMs: number;
  confidence: number;
  candidateScore: number;
  points: ScreenQuad | null;
  rawPoints: ScreenQuad | null;
  cameraFromScreen: Homography | null;
  meanReferenceDriftPx: number | null;
  maximumReferenceDriftPx: number | null;
  meanInterframeJumpPx: number | null;
  lostFrames: number;
  relocated: boolean;
  safeForFeedForward: boolean;
  safeForCorrection: boolean;
  error?: string;
};

export type PhonePlaneTrackerOptions = {
  frame: { width: number; height: number };
  screen: { width: number; height: number };
  referencePoints: ScreenQuad;
  detector?: PhonePlaneDetector;
  minimumConfidence?: number;
  maximumMeanReferenceDriftRatio?: number;
  maximumCornerReferenceDriftRatio?: number;
  maximumInterframeJumpRatio?: number;
  smoothingAlpha?: number;
  maximumCoastingFrames?: number;
  relocationConfirmationFrames?: number;
};

type RelocationCandidate = {
  points: ScreenQuad;
  streak: number;
};

/**
 * Tracks the physical phone plane directly from raw camera frames. It is a
 * passive observer: no method in this class can issue a hardware action.
 */
export class PhonePlaneTracker {
  private readonly detector: PhonePlaneDetector;
  private readonly minimumConfidence: number;
  private readonly maximumMeanReferenceDriftPx: number;
  private readonly maximumCornerReferenceDriftPx: number;
  private readonly maximumInterframeJumpPx: number;
  private readonly smoothingAlpha: number;
  private readonly maximumCoastingFrames: number;
  private readonly relocationConfirmationFrames: number;
  private trackedPoints: ScreenQuad | null = null;
  private lastTrack: PhonePlaneTrack | null = null;
  private relocationCandidate: RelocationCandidate | null = null;
  private lostFrames = 0;

  constructor(private readonly options: PhonePlaneTrackerOptions) {
    const diagonal = Math.hypot(options.frame.width, options.frame.height);
    this.detector = options.detector ?? detectLuminousScreenCandidate;
    this.minimumConfidence = boundedRatio(options.minimumConfidence, 0.82);
    this.maximumMeanReferenceDriftPx = diagonal * boundedRatio(
      options.maximumMeanReferenceDriftRatio,
      0.06,
    );
    this.maximumCornerReferenceDriftPx = diagonal * boundedRatio(
      options.maximumCornerReferenceDriftRatio,
      0.09,
    );
    this.maximumInterframeJumpPx = diagonal * boundedRatio(
      options.maximumInterframeJumpRatio,
      0.025,
    );
    this.smoothingAlpha = boundedRatio(options.smoothingAlpha, 0.65);
    this.maximumCoastingFrames = boundedInteger(
      options.maximumCoastingFrames,
      0,
      120,
      4,
    );
    this.relocationConfirmationFrames = boundedInteger(
      options.relocationConfirmationFrames,
      2,
      10,
      2,
    );
  }

  async update(frame: PhonePlaneFrame): Promise<PhonePlaneTrack> {
    const startedAt = performance.now();
    if (
      frame.width !== this.options.frame.width ||
      frame.height !== this.options.frame.height
    ) {
      return this.remember(this.unsafeTrack(
        frame,
        "frame-size-changed",
        performance.now() - startedAt,
      ));
    }

    let candidate: VisionScreenCandidate | null;
    try {
      candidate = await this.detector(
        frame.bytes,
        this.options.screen.width / this.options.screen.height,
      );
    } catch (error) {
      return this.missingTrack(
        frame,
        performance.now() - startedAt,
        "detector-error",
        errorMessage(error),
      );
    }
    const elapsedMs = performance.now() - startedAt;
    if (!candidate) {
      return this.missingTrack(frame, elapsedMs, "screen-not-found");
    }

    const ranked = rankScreenCandidate({
      candidate,
      imageWidth: frame.width,
      imageHeight: frame.height,
      expectedPoints: this.options.referencePoints,
      expectedScreenAspectRatio: this.options.screen.width / this.options.screen.height,
    });
    const rawPoints = candidatePoints(candidate);
    const referenceDistances = pointDistances(rawPoints, this.options.referencePoints);
    const meanReferenceDriftPx = mean(referenceDistances);
    const maximumReferenceDriftPx = Math.max(...referenceDistances);
    const base = {
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
      observedAt: Date.now(),
      detectorElapsedMs: rounded(elapsedMs),
      confidence: rounded(ranked.confidence),
      candidateScore: rounded(ranked.score),
      rawPoints,
      meanReferenceDriftPx: rounded(meanReferenceDriftPx),
      maximumReferenceDriftPx: rounded(maximumReferenceDriftPx),
    };
    if (ranked.confidence < this.minimumConfidence) {
      return this.remember(this.unsafeTrack(
        frame,
        "candidate-confidence-low",
        elapsedMs,
        base,
      ));
    }
    if (!validGeometry(rawPoints, this.options.referencePoints, ranked.aspectRatio,
      this.options.screen.width / this.options.screen.height)) {
      return this.remember(this.unsafeTrack(
        frame,
        "candidate-geometry-invalid",
        elapsedMs,
        base,
      ));
    }
    if (
      meanReferenceDriftPx > this.maximumMeanReferenceDriftPx ||
      maximumReferenceDriftPx > this.maximumCornerReferenceDriftPx
    ) {
      return this.remember(this.unsafeTrack(
        frame,
        "reference-drift-excessive",
        elapsedMs,
        base,
      ));
    }

    const meanInterframeJumpPx = this.trackedPoints
      ? mean(pointDistances(rawPoints, this.trackedPoints))
      : null;
    let relocated = false;
    if (
      this.trackedPoints &&
      meanInterframeJumpPx !== null &&
      meanInterframeJumpPx > this.maximumInterframeJumpPx
    ) {
      const pendingJump = this.relocationCandidate
        ? mean(pointDistances(rawPoints, this.relocationCandidate.points))
        : Number.POSITIVE_INFINITY;
      this.relocationCandidate = pendingJump <= this.maximumInterframeJumpPx
        ? { points: rawPoints, streak: this.relocationCandidate!.streak + 1 }
        : { points: rawPoints, streak: 1 };
      if (this.relocationCandidate.streak < this.relocationConfirmationFrames) {
        return this.remember(this.unsafeTrack(
          frame,
          "relocation-unconfirmed",
          elapsedMs,
          { ...base, meanInterframeJumpPx: rounded(meanInterframeJumpPx) },
        ));
      }
      this.trackedPoints = cloneQuad(rawPoints);
      this.relocationCandidate = null;
      relocated = true;
    } else {
      this.relocationCandidate = null;
      this.trackedPoints = this.trackedPoints
        ? blendQuad(this.trackedPoints, rawPoints, this.smoothingAlpha)
        : cloneQuad(rawPoints);
    }
    this.lostFrames = 0;
    const points = cloneQuad(this.trackedPoints);
    const track: PhonePlaneTrack = {
      status: "tracking",
      reason: relocated ? "relocated-confirmed" : "observed",
      ...base,
      points,
      cameraFromScreen: cameraFromScreen(points, this.options.screen),
      meanInterframeJumpPx: meanInterframeJumpPx === null
        ? null
        : rounded(meanInterframeJumpPx),
      lostFrames: 0,
      relocated,
      safeForFeedForward: true,
      safeForCorrection: true,
    };
    return this.remember(track);
  }

  latest(): PhonePlaneTrack | null {
    return this.lastTrack;
  }

  projectScreenPoint(point: Point): Point {
    const matrix = this.lastTrack?.cameraFromScreen;
    if (!matrix || !this.lastTrack?.safeForFeedForward) {
      throw new Error("The phone plane is not safe for camera feed-forward projection.");
    }
    if (
      point.x < 0 || point.x > this.options.screen.width ||
      point.y < 0 || point.y > this.options.screen.height
    ) throw new Error("The requested screen point is outside the canonical phone viewport.");
    return roundedPoint(projectPoint(matrix, point));
  }

  reset() {
    this.trackedPoints = null;
    this.lastTrack = null;
    this.relocationCandidate = null;
    this.lostFrames = 0;
  }

  private missingTrack(
    frame: PhonePlaneFrame,
    detectorElapsedMs: number,
    terminalReason: "screen-not-found" | "detector-error",
    error?: string,
  ) {
    this.lostFrames += 1;
    if (this.trackedPoints && this.lostFrames <= this.maximumCoastingFrames) {
      const points = cloneQuad(this.trackedPoints);
      return this.remember({
        status: "coasting",
        reason: "screen-temporarily-hidden",
        sequence: frame.sequence,
        capturedAt: frame.capturedAt,
        observedAt: Date.now(),
        detectorElapsedMs: rounded(detectorElapsedMs),
        confidence: rounded((this.lastTrack?.confidence ?? 0) * (0.82 ** this.lostFrames)),
        candidateScore: this.lastTrack?.candidateScore ?? 0,
        points,
        rawPoints: null,
        cameraFromScreen: cameraFromScreen(points, this.options.screen),
        meanReferenceDriftPx: this.lastTrack?.meanReferenceDriftPx ?? null,
        maximumReferenceDriftPx: this.lastTrack?.maximumReferenceDriftPx ?? null,
        meanInterframeJumpPx: null,
        lostFrames: this.lostFrames,
        relocated: false,
        safeForFeedForward: true,
        safeForCorrection: false,
        ...(error ? { error } : {}),
      });
    }
    return this.remember(this.unsafeTrack(
      frame,
      terminalReason,
      detectorElapsedMs,
      error ? { error } : undefined,
    ));
  }

  private unsafeTrack(
    frame: PhonePlaneFrame,
    reason: Exclude<PhonePlaneTrackReason, "observed" | "relocated-confirmed" | "screen-temporarily-hidden">,
    detectorElapsedMs: number,
    detail: Partial<PhonePlaneTrack> = {},
  ): PhonePlaneTrack {
    return {
      status: "unsafe",
      reason,
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
      observedAt: Date.now(),
      detectorElapsedMs: rounded(detectorElapsedMs),
      confidence: 0,
      candidateScore: 0,
      points: null,
      rawPoints: null,
      cameraFromScreen: null,
      meanReferenceDriftPx: null,
      maximumReferenceDriftPx: null,
      meanInterframeJumpPx: null,
      lostFrames: this.lostFrames,
      relocated: false,
      safeForFeedForward: false,
      safeForCorrection: false,
      ...detail,
    };
  }

  private remember(track: PhonePlaneTrack) {
    this.lastTrack = track;
    return track;
  }
}

function cameraFromScreen(
  points: ScreenQuad,
  screen: { width: number; height: number },
) {
  return homographyFromFourPoints([
    { x: 0, y: 0 },
    { x: screen.width, y: 0 },
    { x: screen.width, y: screen.height },
    { x: 0, y: screen.height },
  ], points);
}

function validGeometry(
  points: ScreenQuad,
  reference: ScreenQuad,
  aspectRatio: number,
  expectedAspectRatio: number,
) {
  if (!points.flatMap((point) => [point.x, point.y]).every(Number.isFinite)) return false;
  const referenceArea = Math.abs(quadArea(reference));
  const area = Math.abs(quadArea(points));
  const areaScale = referenceArea > 0 ? area / referenceArea : 0;
  return Math.sign(quadArea(points)) === Math.sign(quadArea(reference)) &&
    areaScale >= 0.72 && areaScale <= 1.35 &&
    aspectRatio >= expectedAspectRatio * 0.8 &&
    aspectRatio <= expectedAspectRatio * 1.2;
}

function quadArea(points: ScreenQuad) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + (point.x * next.y) - (next.x * point.y);
  }, 0) / 2;
}

function pointDistances(left: ScreenQuad, right: ScreenQuad) {
  return left.map((point, index) => Math.hypot(
    point.x - right[index].x,
    point.y - right[index].y,
  ));
}

function blendQuad(previous: ScreenQuad, current: ScreenQuad, alpha: number): ScreenQuad {
  return previous.map((point, index) => ({
    x: point.x * (1 - alpha) + current[index].x * alpha,
    y: point.y * (1 - alpha) + current[index].y * alpha,
  })) as ScreenQuad;
}

function cloneQuad(points: ScreenQuad): ScreenQuad {
  return points.map((point) => ({ ...point })) as ScreenQuad;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
    ? Number(value)
    : fallback;
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

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundedPoint(point: Point) {
  return { x: rounded(point.x), y: rounded(point.y) };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
