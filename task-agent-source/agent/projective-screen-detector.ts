import sharp from "sharp";

import { mapImagePointToMachine, type Point } from "./homography";
import type { VisionScreenCandidate } from "./vision-screen";

type EnvelopePoint = {
  independent: number;
  dependent: number;
};

type BoundaryFit = {
  slope: number;
  intercept: number;
  rmse: number;
  maximumError: number;
  inlierCount: number;
  inlierSpan: number;
};

const SAMPLE_WIDTH = 360;
const MINIMUM_AREA_RATIO = 0.12;
const MAXIMUM_AREA_RATIO = 0.72;
const LINE_TOLERANCE_PX = 2.8;

/**
 * Recovers a bright phone display from four independently fitted projective
 * boundaries. Unlike a connected-component rectangle detector, the fit can
 * bridge a dark stylus or robot link that divides the display into two lit
 * regions. It does not use a phone-model aspect prior.
 */
export async function detectProjectiveScreenCandidate(
  imageBytes: Buffer,
): Promise<VisionScreenCandidate | null> {
  if (!imageBytes.length) return null;
  const metadata = await sharp(imageBytes).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (sourceWidth < 160 || sourceHeight < 240) return null;
  const sampleWidth = Math.min(SAMPLE_WIDTH, sourceWidth);
  const sampleHeight = Math.max(
    1,
    Math.round(sampleWidth * sourceHeight / sourceWidth),
  );
  const decoded = await sharp(imageBytes)
    .removeAlpha()
    .resize(sampleWidth, sampleHeight, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  const border = borderPixels(decoded, sampleWidth, sampleHeight);
  const background = quantile(border, 0.5);
  const brightBorder = quantile(border, 0.9);
  if (background > 45 || brightBorder > 85) return null;
  const threshold = Math.max(34, background + 22);
  const mask = Uint8Array.from(decoded, (value) => value >= threshold ? 1 : 0);

  const rows = rowEnvelopes(mask, sampleWidth, sampleHeight);
  const columns = columnEnvelopes(mask, sampleWidth, sampleHeight);
  if (rows.length < sampleHeight * 0.18 || columns.length < sampleWidth * 0.18) {
    return null;
  }
  const left = fitBoundary(
    rows.map((row) => ({ independent: row.axis, dependent: row.minimum })),
    0.45,
  );
  const right = fitBoundary(
    rows.map((row) => ({ independent: row.axis, dependent: row.maximum })),
    0.45,
  );
  const top = fitBoundary(
    columns.map((column) => ({
      independent: column.axis,
      dependent: column.minimum,
    })),
    0.45,
  );
  const bottom = fitBoundary(
    columns.map((column) => ({
      independent: column.axis,
      dependent: column.maximum,
    })),
    0.45,
  );
  if (!left || !right || !top || !bottom) return null;

  const topLeft = intersectVerticalAndHorizontal(left, top);
  const topRight = intersectVerticalAndHorizontal(right, top);
  const bottomRight = intersectVerticalAndHorizontal(right, bottom);
  const bottomLeft = intersectVerticalAndHorizontal(left, bottom);
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  const samplePoints = [topLeft, topRight, bottomRight, bottomLeft] as const;
  if (!validQuad(samplePoints, sampleWidth, sampleHeight)) return null;

  const area = polygonArea(samplePoints);
  const areaRatio = area / (sampleWidth * sampleHeight);
  if (areaRatio < MINIMUM_AREA_RATIO || areaRatio > MAXIMUM_AREA_RATIO) return null;
  const topWidth = distance(topLeft, topRight);
  const bottomWidth = distance(bottomLeft, bottomRight);
  const leftHeight = distance(topLeft, bottomLeft);
  const rightHeight = distance(topRight, bottomRight);
  const averageWidth = (topWidth + bottomWidth) / 2;
  const averageHeight = (leftHeight + rightHeight) / 2;
  const apparentAspect = averageWidth / averageHeight;
  if (
    apparentAspect < 0.2 || apparentAspect > 0.85 ||
    Math.min(topWidth, bottomWidth) / Math.max(topWidth, bottomWidth) < 0.45 ||
    Math.min(leftHeight, rightHeight) / Math.max(leftHeight, rightHeight) < 0.72
  ) return null;

  const spanScore = Math.min(
    left.inlierSpan / averageHeight,
    right.inlierSpan / averageHeight,
    top.inlierSpan / averageWidth,
    bottom.inlierSpan / averageWidth,
  );
  if (spanScore < 0.42) return null;
  const coverage = foregroundCoverage(
    mask,
    sampleWidth,
    sampleHeight,
    samplePoints,
  );
  if (coverage < 0.26) return null;
  const maximumRmse = Math.max(left.rmse, right.rmse, top.rmse, bottom.rmse);
  const maximumError = Math.max(
    left.maximumError,
    right.maximumError,
    top.maximumError,
    bottom.maximumError,
  );
  if (maximumRmse > 2.4 || maximumError > 5.5) return null;

  const lineQuality = clamp01(1 - maximumRmse / 2.4);
  const spanQuality = clamp01((spanScore - 0.42) / 0.4);
  const coverageQuality = clamp01((coverage - 0.26) / 0.48);
  const confidence = clamp01(
    0.72 +
    (lineQuality * 0.1) +
    (spanQuality * 0.1) +
    (coverageQuality * 0.08),
  );
  const scaleX = sourceWidth / sampleWidth;
  const scaleY = sourceHeight / sampleHeight;
  const scaled = (point: Point): Point => ({
    x: rounded(point.x * scaleX),
    y: rounded(point.y * scaleY),
  });
  const [scaledTopLeft, scaledTopRight, scaledBottomRight, scaledBottomLeft] =
    samplePoints.map(scaled) as [Point, Point, Point, Point];
  return {
    confidence: rounded(confidence),
    topLeft: scaledTopLeft,
    topRight: scaledTopRight,
    bottomRight: scaledBottomRight,
    bottomLeft: scaledBottomLeft,
    areaRatio: rounded(areaRatio),
  };
}

/** Scores only detector-internal evidence; no handset aspect prior is used. */
export function projectiveScreenCandidateScore(input: {
  candidate: VisionScreenCandidate;
  imageWidth: number;
  imageHeight: number;
}) {
  if (
    input.imageWidth <= 0 || input.imageHeight <= 0 ||
    !Number.isFinite(input.candidate.areaRatio)
  ) return 0;
  const points = [
    input.candidate.topLeft,
    input.candidate.topRight,
    input.candidate.bottomRight,
    input.candidate.bottomLeft,
  ];
  const center = points.reduce((sum, point) => ({
    x: sum.x + point.x / points.length,
    y: sum.y + point.y / points.length,
  }), { x: 0, y: 0 });
  const centerDistance = Math.hypot(
    (center.x - input.imageWidth / 2) / input.imageWidth,
    (center.y - input.imageHeight / 2) / input.imageHeight,
  );
  const centerScore = clamp01(1 - centerDistance / 0.55);
  const areaScore = clamp01(
    (input.candidate.areaRatio - MINIMUM_AREA_RATIO) / 0.35,
  );
  return rounded(
    (clamp01(input.candidate.confidence) * 0.55) +
    (areaScore * 0.25) +
    (centerScore * 0.2),
  );
}

/**
 * A dark status/navigation bar may move one luminous edge inward while the
 * physical screen is unchanged. Only one aligned edge may use this exception.
 */
export function isSingleEdgeLuminousInset(
  observed: [Point, Point, Point, Point],
  registered: [Point, Point, Point, Point],
) {
  const normalized = observed.map((point) => mapImagePointToMachine({
    imagePoints: registered,
    machinePoints: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  }, point));
  if (normalized.some((point) =>
    !Number.isFinite(point.x) || !Number.isFinite(point.y)
  )) return false;
  const left = (normalized[0].x + normalized[3].x) / 2;
  const right = (normalized[1].x + normalized[2].x) / 2;
  const top = (normalized[0].y + normalized[1].y) / 2;
  const bottom = (normalized[2].y + normalized[3].y) / 2;
  if (
    Math.abs(normalized[0].x - normalized[3].x) > 0.04 ||
    Math.abs(normalized[1].x - normalized[2].x) > 0.04 ||
    Math.abs(normalized[0].y - normalized[1].y) > 0.04 ||
    Math.abs(normalized[2].y - normalized[3].y) > 0.04 ||
    left < -0.03 || left > 0.16 ||
    right < 0.84 || right > 1.03 ||
    top < -0.03 || top > 0.16 ||
    bottom < 0.84 || bottom > 1.03
  ) return false;
  const insetEdges = [
    left > 0.025,
    right < 0.975,
    top > 0.025,
    bottom < 0.975,
  ].filter(Boolean).length;
  return insetEdges <= 1;
}

function rowEnvelopes(mask: Uint8Array, width: number, height: number) {
  const result: Array<{ axis: number; minimum: number; maximum: number }> = [];
  for (let y = 0; y < height; y += 1) {
    let minimum = width;
    let maximum = -1;
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      if (!mask[(y * width) + x]) continue;
      minimum = Math.min(minimum, x);
      maximum = x;
      count += 1;
    }
    const span = maximum - minimum + 1;
    if (
      count >= width * 0.055 &&
      span >= width * 0.16 &&
      count / span >= 0.22
    ) result.push({ axis: y, minimum, maximum });
  }
  return result;
}

function columnEnvelopes(mask: Uint8Array, width: number, height: number) {
  const result: Array<{ axis: number; minimum: number; maximum: number }> = [];
  for (let x = 0; x < width; x += 1) {
    let minimum = height;
    let maximum = -1;
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      if (!mask[(y * width) + x]) continue;
      minimum = Math.min(minimum, y);
      maximum = y;
      count += 1;
    }
    const span = maximum - minimum + 1;
    if (
      count >= height * 0.04 &&
      span >= height * 0.14 &&
      count / span >= 0.18
    ) result.push({ axis: x, minimum, maximum });
  }
  return result;
}

function fitBoundary(
  points: EnvelopePoint[],
  maximumSlope: number,
): BoundaryFit | null {
  if (points.length < 16) return null;
  const sorted = [...points].sort((left, right) =>
    left.independent - right.independent
  );
  const independentSpan =
    sorted.at(-1)!.independent - sorted[0].independent;
  if (independentSpan < 30) return null;
  const lower = sorted.filter((point) =>
    point.independent <= sorted[0].independent + independentSpan * 0.42
  );
  const upper = sorted.filter((point) =>
    point.independent >= sorted[0].independent + independentSpan * 0.58
  );
  const sampledLower = evenlySample(lower, 34);
  const sampledUpper = evenlySample(upper, 34);
  let best: { slope: number; intercept: number; score: number } | null = null;
  for (const first of sampledLower) {
    for (const second of sampledUpper) {
      const delta = second.independent - first.independent;
      if (delta < independentSpan * 0.28) continue;
      const slope = (second.dependent - first.dependent) / delta;
      if (Math.abs(slope) > maximumSlope) continue;
      const intercept = first.dependent - (slope * first.independent);
      let inlierCount = 0;
      let minimumIndependent = Number.POSITIVE_INFINITY;
      let maximumIndependent = Number.NEGATIVE_INFINITY;
      let residualSum = 0;
      for (const point of sorted) {
        const residual = Math.abs(
          point.dependent - ((slope * point.independent) + intercept),
        );
        if (residual > LINE_TOLERANCE_PX) continue;
        inlierCount += 1;
        residualSum += residual;
        minimumIndependent = Math.min(minimumIndependent, point.independent);
        maximumIndependent = Math.max(maximumIndependent, point.independent);
      }
      if (inlierCount < 12) continue;
      const span = maximumIndependent - minimumIndependent;
      const score = inlierCount + (span / independentSpan * 24) -
        (residualSum / inlierCount);
      if (!best || score > best.score) {
        best = { slope, intercept, score };
      }
    }
  }
  if (!best) return null;
  const initialInliers = sorted.filter((point) =>
    Math.abs(point.dependent - (
      (best.slope * point.independent) + best.intercept
    )) <= LINE_TOLERANCE_PX
  );
  const refined = leastSquares(initialInliers);
  const inliers = sorted.filter((point) =>
    Math.abs(point.dependent - (
      (refined.slope * point.independent) + refined.intercept
    )) <= LINE_TOLERANCE_PX * 1.25
  );
  if (inliers.length < 12) return null;
  const final = leastSquares(inliers);
  const errors = inliers.map((point) => Math.abs(
    point.dependent - ((final.slope * point.independent) + final.intercept),
  ));
  return {
    ...final,
    rmse: Math.sqrt(mean(errors.map((error) => error ** 2))),
    maximumError: Math.max(...errors),
    inlierCount: inliers.length,
    inlierSpan: inlierSpan(inliers),
  };
}

function leastSquares(points: EnvelopePoint[]) {
  const meanIndependent = mean(points.map((point) => point.independent));
  const meanDependent = mean(points.map((point) => point.dependent));
  const denominator = points.reduce((sum, point) =>
    sum + ((point.independent - meanIndependent) ** 2), 0
  );
  const slope = denominator <= 1e-9
    ? 0
    : points.reduce((sum, point) => sum +
      ((point.independent - meanIndependent) *
        (point.dependent - meanDependent)), 0) / denominator;
  return {
    slope,
    intercept: meanDependent - (slope * meanIndependent),
  };
}

function intersectVerticalAndHorizontal(
  vertical: BoundaryFit,
  horizontal: BoundaryFit,
): Point | null {
  // vertical: x = a*y+b; horizontal: y = c*x+d
  const denominator = 1 - (vertical.slope * horizontal.slope);
  if (Math.abs(denominator) < 0.1) return null;
  const x = (
    (vertical.slope * horizontal.intercept) + vertical.intercept
  ) / denominator;
  return {
    x,
    y: (horizontal.slope * x) + horizontal.intercept,
  };
}

function validQuad(
  points: readonly [Point, Point, Point, Point],
  width: number,
  height: number,
) {
  const marginX = width * 0.04;
  const marginY = height * 0.04;
  if (points.some((point) =>
    !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
    point.x < -marginX || point.x > width + marginX ||
    point.y < -marginY || point.y > height + marginY
  )) return false;
  const crosses = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    return ((next.x - point.x) * (after.y - next.y)) -
      ((next.y - point.y) * (after.x - next.x));
  });
  return crosses.every((value) => value > 0) ||
    crosses.every((value) => value < 0);
}

function foregroundCoverage(
  mask: Uint8Array,
  width: number,
  height: number,
  points: readonly [Point, Point, Point, Point],
) {
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))));
  const right = Math.min(width - 1, Math.ceil(Math.max(...points.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
  let inside = 0;
  let active = 0;
  for (let y = top; y <= bottom; y += 3) {
    for (let x = left; x <= right; x += 3) {
      if (!pointInsideQuad({ x, y }, points)) continue;
      inside += 1;
      if (mask[(y * width) + x]) active += 1;
    }
  }
  return inside ? active / inside : 0;
}

function pointInsideQuad(
  point: Point,
  quad: readonly [Point, Point, Point, Point],
) {
  const signs = quad.map((current, index) => {
    const next = quad[(index + 1) % quad.length];
    return ((next.x - current.x) * (point.y - current.y)) -
      ((next.y - current.y) * (point.x - current.x));
  });
  return signs.every((value) => value >= 0) ||
    signs.every((value) => value <= 0);
}

function borderPixels(pixels: Buffer, width: number, height: number) {
  const result: number[] = [];
  const borderWidth = Math.max(2, Math.round(width * 0.01));
  for (let y = 0; y < height; y += 3) {
    for (let offset = 0; offset < borderWidth; offset += 1) {
      result.push(pixels[(y * width) + offset]);
      result.push(pixels[(y * width) + width - 1 - offset]);
    }
  }
  for (let x = 0; x < width; x += 3) {
    for (let offset = 0; offset < borderWidth; offset += 1) {
      result.push(pixels[(offset * width) + x]);
      result.push(pixels[((height - 1 - offset) * width) + x]);
    }
  }
  return result;
}

function evenlySample<T>(values: T[], limit: number) {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) =>
    values[Math.round(index * (values.length - 1) / (limit - 1))]
  );
}

function inlierSpan(points: EnvelopePoint[]) {
  const values = points.map((point) => point.independent);
  return Math.max(...values) - Math.min(...values);
}

function polygonArea(points: readonly Point[]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + (point.x * next.y) - (next.x * point.y);
  }, 0)) / 2;
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
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
