import sharp from "sharp";

import {
  homographyFromFourPoints,
  projectPoint,
  type Point,
} from "../agent/homography";

export type PhysicalHomeButtonEvidence = {
  version: 1;
  mode: "shadow";
  status: "detected" | "not_detected" | "unobservable";
  reason:
    | "centered-circular-button"
    | "no-unambiguous-circular-button"
    | "button-region-outside-camera";
  point: Point | null;
  normalizedPoint: { x: number; belowScreenWidths: number } | null;
  radiusScreenWidths: number | null;
  confidence: number;
  score: number;
  runnerUpScore: number | null;
  contrast: number;
  angularCoverage: number;
  polarity: number;
  circularity: number;
  evaluatedCandidates: number;
  wouldMoveHardware: false;
  actionReady: false;
};

type Raster = {
  data: Buffer;
  width: number;
  height: number;
};

type Candidate = {
  u: number;
  v: number;
  radius: number;
  point: Point;
  score: number;
  contrast: number;
  angularCoverage: number;
  polarity: number;
  uniformity: number;
  circularity: number;
  strengthScore: number;
  centerScore: number;
  depthScore: number;
};

const SEARCH_MIN_BELOW_SCREEN_WIDTHS = 0.035;
const SEARCH_MAX_BELOW_SCREEN_WIDTHS = 0.245;
const MINIMUM_RADIUS_SCREEN_WIDTHS = 0.03;
const MAXIMUM_RADIUS_SCREEN_WIDTHS = 0.08;
const MINIMUM_SCORE = 0.72;
const MINIMUM_SCORE_MARGIN = 0.08;
const MINIMUM_CONTRAST = 10;
const MINIMUM_ANGULAR_COVERAGE = 0.62;
const MINIMUM_POLARITY = 0.58;
const MINIMUM_CIRCULARITY = 0.76;

/**
 * Looks only below the detected display for a centered circular physical
 * button. Geometry is evaluated in phone-plane coordinates so perspective does
 * not turn a real circle into an arbitrary camera-space ellipse. Detection is
 * Shadow-only and cannot authorize a press.
 */
export async function detectPhysicalHomeButton(input: {
  imageBytes: Buffer;
  frame: { width: number; height: number };
  screenPoints: [Point, Point, Point, Point];
  screenAspectRatio: number;
}): Promise<PhysicalHomeButtonEvidence> {
  if (!input.imageBytes.length) throw new Error("Physical Home detection needs an image.");
  if (
    !Number.isInteger(input.frame.width) || input.frame.width <= 0 ||
    !Number.isInteger(input.frame.height) || input.frame.height <= 0 ||
    !Number.isFinite(input.screenAspectRatio) ||
    input.screenAspectRatio < 0.3 || input.screenAspectRatio > 0.8
  ) throw new Error("Physical Home detection geometry is invalid.");
  const decoded = await sharp(input.imageBytes)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== input.frame.width ||
    decoded.info.height !== input.frame.height
  ) throw new Error("Physical Home image dimensions do not match the frame.");
  const raster = {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
  };
  const screenHeightInWidths = 1 / input.screenAspectRatio;
  const phoneToCamera = homographyFromFourPoints(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: screenHeightInWidths },
      { x: 0, y: screenHeightInWidths },
    ],
    input.screenPoints,
  );
  const searchCorners = [
    { x: 0.36, y: screenHeightInWidths + SEARCH_MIN_BELOW_SCREEN_WIDTHS },
    { x: 0.64, y: screenHeightInWidths + SEARCH_MIN_BELOW_SCREEN_WIDTHS },
    { x: 0.64, y: screenHeightInWidths + SEARCH_MAX_BELOW_SCREEN_WIDTHS },
    { x: 0.36, y: screenHeightInWidths + SEARCH_MAX_BELOW_SCREEN_WIDTHS },
  ].map((point) => projectPoint(phoneToCamera, point));
  if (searchCorners.filter((point) => insideFrame(point, raster, 1)).length < 3) {
    return emptyEvidence("unobservable", "button-region-outside-camera");
  }

  const candidates: Candidate[] = [];
  for (let u = 0.42; u <= 0.58 + 1e-9; u += 0.01) {
    for (
      let below = SEARCH_MIN_BELOW_SCREEN_WIDTHS;
      below <= SEARCH_MAX_BELOW_SCREEN_WIDTHS + 1e-9;
      below += 0.01
    ) {
      for (
        let radius = MINIMUM_RADIUS_SCREEN_WIDTHS;
        radius <= MAXIMUM_RADIUS_SCREEN_WIDTHS + 1e-9;
        radius += 0.005
      ) {
        const candidate = evaluateCandidate({
          raster,
          phoneToCamera,
          u,
          v: screenHeightInWidths + below,
          radius,
          below,
        });
        if (candidate) candidates.push(candidate);
      }
    }
  }
  if (candidates.length < 100) {
    return emptyEvidence(
      "unobservable",
      "button-region-outside-camera",
      candidates.length,
    );
  }
  candidates.sort((left, right) => right.score - left.score);
  const refined = candidates.slice(0, 96).map((candidate) =>
    refineCircularity(candidate, raster, phoneToCamera)
  ).filter((candidate): candidate is Candidate => candidate !== null);
  if (!refined.length) {
    return emptyEvidence(
      "unobservable",
      "button-region-outside-camera",
      candidates.length,
    );
  }
  refined.sort((left, right) => right.score - left.score);
  const best = refined[0];
  const runnerUp = refined.find((candidate) => Math.hypot(
    candidate.u - best.u,
    candidate.v - best.v,
  ) > Math.max(candidate.radius, best.radius) * 1.8);
  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  const detected =
    best.score >= MINIMUM_SCORE &&
    margin >= MINIMUM_SCORE_MARGIN &&
    best.contrast >= MINIMUM_CONTRAST &&
    best.angularCoverage >= MINIMUM_ANGULAR_COVERAGE &&
    best.polarity >= MINIMUM_POLARITY &&
    best.circularity >= MINIMUM_CIRCULARITY &&
    best.centerScore >= 0.72;
  if (!detected) {
    return {
      ...emptyEvidence("not_detected", "no-unambiguous-circular-button"),
      confidence: rounded(best.score),
      score: rounded(best.score),
      runnerUpScore: runnerUp ? rounded(runnerUp.score) : null,
      contrast: rounded(best.contrast),
      angularCoverage: rounded(best.angularCoverage),
      polarity: rounded(best.polarity),
      circularity: rounded(best.circularity),
      evaluatedCandidates: candidates.length,
    };
  }
  return {
    version: 1,
    mode: "shadow",
    status: "detected",
    reason: "centered-circular-button",
    point: roundedPoint(best.point),
    normalizedPoint: {
      x: rounded(best.u),
      belowScreenWidths: rounded(best.v - screenHeightInWidths),
    },
    radiusScreenWidths: rounded(best.radius),
    confidence: rounded(best.score),
    score: rounded(best.score),
    runnerUpScore: runnerUp ? rounded(runnerUp.score) : null,
    contrast: rounded(best.contrast),
    angularCoverage: rounded(best.angularCoverage),
    polarity: rounded(best.polarity),
    circularity: rounded(best.circularity),
    evaluatedCandidates: candidates.length,
    wouldMoveHardware: false,
    actionReady: false,
  };
}

function evaluateCandidate(input: {
  raster: Raster;
  phoneToCamera: ReturnType<typeof homographyFromFourPoints>;
  u: number;
  v: number;
  radius: number;
  below: number;
}): Candidate | null {
  const inner: number[] = [];
  const ring: number[] = [];
  const outer: number[] = [];
  for (let index = 0; index < 48; index += 1) {
    const angle = index / 48 * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const samples = [0.68, 1, 1.32].map((scale) => {
      const cameraPoint = projectPoint(input.phoneToCamera, {
        x: input.u + (cosine * input.radius * scale),
        y: input.v + (sine * input.radius * scale),
      });
      return sampleBilinear(input.raster, cameraPoint);
    });
    if (samples.some((value) => value === null)) return null;
    inner.push(samples[0] as number);
    ring.push(samples[1] as number);
    outer.push(samples[2] as number);
  }
  const diskSignals = inner.map((value, index) => value - outer[index]);
  const ringSignals = ring.map((value, index) =>
    value - ((inner[index] + outer[index]) / 2)
  );
  const diskStrength = Math.abs(mean(diskSignals));
  const ringStrength = Math.abs(mean(ringSignals)) * 1.45;
  const signals = ringStrength > diskStrength ? ringSignals : diskSignals;
  const contrast = Math.max(diskStrength, ringStrength);
  const averageAbsolute = mean(signals.map(Math.abs));
  const polarity = averageAbsolute > 1e-6
    ? Math.abs(mean(signals)) / averageAbsolute
    : 0;
  const dominantSign = Math.sign(mean(signals));
  const signalThreshold = Math.max(4, contrast * 0.42);
  const angularCoverage = signals.filter((value) =>
    Math.sign(value) === dominantSign && Math.abs(value) >= signalThreshold
  ).length / signals.length;
  const signalMean = mean(signals);
  const standardDeviation = Math.sqrt(mean(signals.map((value) =>
    (value - signalMean) ** 2
  )));
  const uniformity = clamp01(
    1 - standardDeviation / Math.max(8, averageAbsolute * 1.6),
  );
  const strengthScore = clamp01((contrast - 6) / 28);
  const centerScore = clamp01(1 - Math.abs(input.u - 0.5) / 0.11);
  const depthScore = clamp01(1 - Math.abs(input.below - 0.135) / 0.14);
  const score =
    (strengthScore * 0.39) +
    (angularCoverage * 0.23) +
    (polarity * 0.18) +
    (uniformity * 0.13) +
    (centerScore * 0.05) +
    (depthScore * 0.02);
  return {
    u: input.u,
    v: input.v,
    radius: input.radius,
    point: projectPoint(input.phoneToCamera, { x: input.u, y: input.v }),
    score,
    contrast,
    angularCoverage,
    polarity,
    uniformity,
    circularity: 0,
    strengthScore,
    centerScore,
    depthScore,
  };
}

function refineCircularity(
  candidate: Candidate,
  raster: Raster,
  phoneToCamera: ReturnType<typeof homographyFromFourPoints>,
): Candidate | null {
  const radialScales = [
    0.45, 0.55, 0.65, 0.75, 0.85, 0.95,
    1.05, 1.15, 1.25, 1.35, 1.45, 1.55,
  ];
  const transitionRadii: number[] = [];
  for (let index = 0; index < 48; index += 1) {
    const angle = index / 48 * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const radialValues = radialScales.map((scale) => {
      const cameraPoint = projectPoint(phoneToCamera, {
        x: candidate.u + (cosine * candidate.radius * scale),
        y: candidate.v + (sine * candidate.radius * scale),
      });
      return sampleBilinear(raster, cameraPoint);
    });
    if (radialValues.some((value) => value === null)) return null;
    let strongestIndex = 0;
    let strongestDifference = Number.NEGATIVE_INFINITY;
    for (let radialIndex = 0; radialIndex < radialValues.length - 1; radialIndex += 1) {
      const difference = Math.abs(
        (radialValues[radialIndex + 1] as number) -
        (radialValues[radialIndex] as number),
      );
      if (difference > strongestDifference) {
        strongestDifference = difference;
        strongestIndex = radialIndex;
      }
    }
    transitionRadii.push(
      (radialScales[strongestIndex] + radialScales[strongestIndex + 1]) / 2,
    );
  }
  const transitionMean = mean(transitionRadii);
  const transitionDeviation = Math.sqrt(mean(transitionRadii.map((value) =>
    (value - transitionMean) ** 2
  )));
  const circularity = clamp01(1 - transitionDeviation / 0.16);
  return {
    ...candidate,
    circularity,
    score:
      (candidate.strengthScore * 0.31) +
      (candidate.angularCoverage * 0.18) +
      (candidate.polarity * 0.14) +
      (candidate.uniformity * 0.10) +
      (circularity * 0.20) +
      (candidate.centerScore * 0.05) +
      (candidate.depthScore * 0.02),
  };
}

function sampleBilinear(raster: Raster, point: Point): number | null {
  if (!insideFrame(point, raster, 1)) return null;
  const x0 = Math.floor(point.x);
  const y0 = Math.floor(point.y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const dx = point.x - x0;
  const dy = point.y - y0;
  const at = (x: number, y: number) => raster.data[(y * raster.width) + x];
  return (
    (at(x0, y0) * (1 - dx) * (1 - dy)) +
    (at(x1, y0) * dx * (1 - dy)) +
    (at(x0, y1) * (1 - dx) * dy) +
    (at(x1, y1) * dx * dy)
  );
}

function insideFrame(point: Point, raster: Pick<Raster, "width" | "height">, margin: number) {
  return point.x >= margin && point.x < raster.width - margin &&
    point.y >= margin && point.y < raster.height - margin;
}

function emptyEvidence(
  status: "not_detected" | "unobservable",
  reason: "no-unambiguous-circular-button" | "button-region-outside-camera",
  evaluatedCandidates = 0,
): PhysicalHomeButtonEvidence {
  return {
    version: 1,
    mode: "shadow",
    status,
    reason,
    point: null,
    normalizedPoint: null,
    radiusScreenWidths: null,
    confidence: 0,
    score: 0,
    runnerUpScore: null,
    contrast: 0,
    angularCoverage: 0,
    polarity: 0,
    circularity: 0,
    evaluatedCandidates,
    wouldMoveHardware: false,
    actionReady: false,
  };
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundedPoint(point: Point) {
  return { x: rounded(point.x), y: rounded(point.y) };
}
