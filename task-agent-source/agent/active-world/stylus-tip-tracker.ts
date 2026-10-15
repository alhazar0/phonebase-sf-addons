import sharp from "sharp";

import type { Point } from "../homography";

export type StylusTipFrame = {
  bytes: Buffer;
  width: number;
  height: number;
  sequence: number;
  capturedAt: number;
};

export type StylusTipTemplate = {
  size: number;
  values: Float32Array;
  energy: number;
  calibratedAt: number;
  referenceSequence: number;
};

export type StylusTipTrack = {
  status: "tracking" | "unsafe";
  reason:
    | "observed"
    | "not-calibrated"
    | "frame-size-changed"
    | "prediction-outside-frame"
    | "appearance-mismatch"
    | "ambiguous-match";
  sequence: number;
  capturedAt: number;
  observedAt: number;
  elapsedMs: number;
  predictedPoint: Point;
  point: Point | null;
  residualPx: Point | null;
  residualDistancePx: number | null;
  correlation: number;
  secondBestCorrelation: number;
  confidence: number;
  occluded: boolean;
  searchRadiusPx: number;
  reacquired: boolean;
  wouldMoveHardware: false;
};

export type StylusTipTrackerOptions = {
  frame: { width: number; height: number };
  templateSize?: number;
  fastSearchRadiusPx?: number;
  searchRadiusPx?: number;
  minimumTemplateGradientRms?: number;
  minimumCorrelation?: number;
  minimumConfidence?: number;
};

/**
 * Tracks a visible stylus feature around a kinematic camera prediction using
 * gradient-template correlation. The kinematic prior keeps the search local;
 * the camera match supplies the residual. This observer never moves hardware.
 */
export class StylusTipTracker {
  private readonly templateSize: number;
  private readonly fastSearchRadiusPx: number;
  private readonly searchRadiusPx: number;
  private readonly minimumTemplateGradientRms: number;
  private readonly minimumCorrelation: number;
  private readonly minimumConfidence: number;
  private template: StylusTipTemplate | null = null;
  private lastTrack: StylusTipTrack | null = null;

  constructor(private readonly options: StylusTipTrackerOptions) {
    this.templateSize = boundedOdd(options.templateSize, 15, 61, 31);
    this.searchRadiusPx = boundedInteger(options.searchRadiusPx, 2, 80, 22);
    this.fastSearchRadiusPx = boundedInteger(
      options.fastSearchRadiusPx,
      2,
      this.searchRadiusPx,
      Math.min(10, this.searchRadiusPx),
    );
    this.minimumTemplateGradientRms = boundedNumber(
      options.minimumTemplateGradientRms,
      1,
      255,
      8,
    );
    this.minimumCorrelation = boundedNumber(options.minimumCorrelation, -1, 1, 0.5);
    this.minimumConfidence = boundedRatio(options.minimumConfidence, 0.72);
  }

  async calibrate(frame: StylusTipFrame, predictedPoint: Point) {
    this.assertFrame(frame);
    const half = Math.floor(this.templateSize / 2);
    const crop = cropAround(predictedPoint, half + 1, frame.width, frame.height);
    if (!crop) {
      throw new Error("The predicted stylus point is too close to the camera-frame edge.");
    }
    const decoded = await decodeGray(frame.bytes, crop);
    const gradients = gradientMagnitude(decoded.data, decoded.width, decoded.height);
    const values = extractPatch(
      gradients,
      decoded.width,
      decoded.height,
      half + 1,
      half + 1,
      this.templateSize,
    );
    const normalized = normalizeTemplate(values);
    const rms = Math.sqrt(normalized.energy / values.length);
    if (!Number.isFinite(rms) || rms < this.minimumTemplateGradientRms) {
      throw new Error(
        `The stylus template has insufficient visible edge energy (${rms.toFixed(2)} RMS).`,
      );
    }
    this.template = {
      size: this.templateSize,
      values: normalized.values,
      energy: normalized.energy,
      calibratedAt: Date.now(),
      referenceSequence: frame.sequence,
    };
    this.lastTrack = null;
    return { ...this.template, values: new Float32Array(this.template.values) };
  }

  async update(frame: StylusTipFrame, predictedPoint: Point): Promise<StylusTipTrack> {
    const startedAt = performance.now();
    const base = {
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
      observedAt: Date.now(),
      predictedPoint: roundedPoint(predictedPoint),
      wouldMoveHardware: false as const,
    };
    if (!this.template) {
      return this.remember(unsafeTrack(base, "not-calibrated", performance.now() - startedAt));
    }
    if (
      frame.width !== this.options.frame.width ||
      frame.height !== this.options.frame.height
    ) {
      return this.remember(unsafeTrack(
        base,
        "frame-size-changed",
        performance.now() - startedAt,
      ));
    }
    const half = Math.floor(this.templateSize / 2);
    const extent = half + this.searchRadiusPx + 1;
    const crop = cropAround(predictedPoint, extent, frame.width, frame.height);
    if (!crop) {
      return this.remember(unsafeTrack(
        base,
        "prediction-outside-frame",
        performance.now() - startedAt,
      ));
    }

    const decoded = await decodeGray(frame.bytes, crop);
    const gradients = gradientMagnitude(decoded.data, decoded.width, decoded.height);
    const center = extent;
    let match = findBestMatch(
      this.template,
      gradients,
      decoded.width,
      decoded.height,
      center,
      this.templateSize,
      this.fastSearchRadiusPx,
    );
    let reacquired = false;
    if (
      this.fastSearchRadiusPx < this.searchRadiusPx &&
      (
        match.correlation < this.minimumCorrelation ||
        match.confidence < this.minimumConfidence ||
        Math.abs(match.dx) >= this.fastSearchRadiusPx - 1 ||
        Math.abs(match.dy) >= this.fastSearchRadiusPx - 1
      )
    ) {
      match = findBestMatch(
        this.template,
        gradients,
        decoded.width,
        decoded.height,
        center,
        this.templateSize,
        this.searchRadiusPx,
      );
      reacquired = true;
    }
    const common = {
      correlation: rounded(match.correlation),
      secondBestCorrelation: rounded(match.secondBestCorrelation),
      confidence: rounded(match.confidence),
      searchRadiusPx: reacquired ? this.searchRadiusPx : this.fastSearchRadiusPx,
      reacquired,
    };
    if (match.correlation < this.minimumCorrelation) {
      return this.remember(unsafeTrack(
        base,
        "appearance-mismatch",
        performance.now() - startedAt,
        common,
      ));
    }
    if (match.confidence < this.minimumConfidence) {
      return this.remember(unsafeTrack(
        base,
        "ambiguous-match",
        performance.now() - startedAt,
        common,
      ));
    }
    const point = {
      x: Math.round(predictedPoint.x) + match.dx,
      y: Math.round(predictedPoint.y) + match.dy,
    };
    const residualPx = {
      x: point.x - predictedPoint.x,
      y: point.y - predictedPoint.y,
    };
    return this.remember({
      status: "tracking",
      reason: "observed",
      ...base,
      elapsedMs: rounded(performance.now() - startedAt),
      point: roundedPoint(point),
      residualPx: roundedPoint(residualPx),
      residualDistancePx: rounded(Math.hypot(residualPx.x, residualPx.y)),
      ...common,
      occluded: false,
    });
  }

  latest(): StylusTipTrack | null {
    return this.lastTrack;
  }

  isCalibrated() {
    return this.template !== null;
  }

  reset() {
    this.template = null;
    this.lastTrack = null;
  }

  private assertFrame(frame: StylusTipFrame) {
    if (
      frame.width !== this.options.frame.width ||
      frame.height !== this.options.frame.height
    ) throw new Error("The stylus calibration frame size does not match the tracker.");
    if (!frame.bytes.length) throw new Error("The stylus calibration frame is empty.");
  }

  private remember(track: StylusTipTrack) {
    this.lastTrack = track;
    return track;
  }
}

function unsafeTrack(
  base: Pick<StylusTipTrack,
    "sequence" | "capturedAt" | "observedAt" | "predictedPoint" | "wouldMoveHardware">,
  reason: Exclude<StylusTipTrack["reason"], "observed">,
  elapsedMs: number,
  detail: Partial<StylusTipTrack> = {},
): StylusTipTrack {
  return {
    status: "unsafe",
    reason,
    ...base,
    elapsedMs: rounded(elapsedMs),
    point: null,
    residualPx: null,
    residualDistancePx: null,
    correlation: 0,
    secondBestCorrelation: 0,
    confidence: 0,
    occluded: true,
    searchRadiusPx: 0,
    reacquired: false,
    ...detail,
  };
}

function findBestMatch(
  template: StylusTipTemplate,
  gradients: Float32Array,
  width: number,
  height: number,
  center: number,
  templateSize: number,
  searchRadius: number,
) {
  let best = { correlation: Number.NEGATIVE_INFINITY, dx: 0, dy: 0 };
  const matches: Array<{ correlation: number; dx: number; dy: number }> = [];
  for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      const values = extractPatch(
        gradients,
        width,
        height,
        center + dx,
        center + dy,
        templateSize,
      );
      const correlation = correlate(template, values);
      const match = { correlation, dx, dy };
      matches.push(match);
      if (correlation > best.correlation) best = match;
    }
  }
  const secondBestCorrelation = matches
    .filter((match) => Math.hypot(match.dx - best.dx, match.dy - best.dy) >= 4)
    .reduce(
      (highest, match) => Math.max(highest, match.correlation),
      Number.NEGATIVE_INFINITY,
    );
  const scoreQuality = clamp01((best.correlation - 0.35) / 0.6);
  const separation = clamp01((best.correlation - secondBestCorrelation - 0.01) / 0.14);
  const confidence = clamp01(scoreQuality * 0.82 + separation * 0.18);
  return { ...best, secondBestCorrelation, confidence };
}

async function decodeGray(
  bytes: Buffer,
  crop: { left: number; top: number; width: number; height: number },
) {
  const result = await sharp(bytes)
    .extract(crop)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
  };
}

function cropAround(point: Point, extent: number, width: number, height: number) {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  const left = centerX - extent;
  const top = centerY - extent;
  const size = extent * 2 + 1;
  if (left < 0 || top < 0 || left + size > width || top + size > height) return null;
  return { left, top, width: size, height: size };
}

function gradientMagnitude(data: Buffer, width: number, height: number) {
  const output = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const gx = data[index + 1] - data[index - 1];
      const gy = data[index + width] - data[index - width];
      output[index] = Math.hypot(gx, gy);
    }
  }
  return output;
}

function extractPatch(
  data: Float32Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  size: number,
) {
  const half = Math.floor(size / 2);
  if (
    centerX - half < 0 || centerY - half < 0 ||
    centerX + half >= width || centerY + half >= height
  ) throw new Error("The stylus search patch exceeded its decoded camera crop.");
  const values = new Float32Array(size * size);
  let target = 0;
  for (let y = centerY - half; y <= centerY + half; y += 1) {
    for (let x = centerX - half; x <= centerX + half; x += 1) {
      values[target++] = data[y * width + x];
    }
  }
  return values;
}

function normalizeTemplate(values: Float32Array) {
  const average = mean(values);
  const normalized = new Float32Array(values.length);
  let energy = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] - average;
    normalized[index] = value;
    energy += value * value;
  }
  return { values: normalized, energy };
}

function correlate(template: StylusTipTemplate, values: Float32Array) {
  const average = mean(values);
  let numerator = 0;
  let energy = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] - average;
    numerator += template.values[index] * value;
    energy += value * value;
  }
  const denominator = Math.sqrt(template.energy * energy);
  return denominator > 1e-6 ? numerator / denominator : -1;
}

function mean(values: Float32Array) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / Math.max(1, values.length);
}

function boundedOdd(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum &&
      Number(value) % 2 === 1
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

function boundedRatio(value: number | undefined, fallback: number) {
  return boundedNumber(value, 0, 1, fallback);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundedPoint(point: Point) {
  return { x: rounded(point.x), y: rounded(point.y) };
}
