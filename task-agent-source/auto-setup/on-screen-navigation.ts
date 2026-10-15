import sharp from "sharp";

import type { Point } from "../agent/homography";

export type OnScreenNavigationEvidence = {
  version: 1;
  mode: "shadow";
  status: "detected" | "not_detected";
  strategy: "gesture_handle" | "three_button" | "unknown";
  confidence: number;
  homePoint: Point | null;
  gestureHandleBounds: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  threeButtonCenters: [Point, Point, Point] | null;
  wouldMoveHardware: false;
  actionReady: false;
};

type RowRun = {
  y: number;
  left: number;
  right: number;
  width: number;
  center: number;
  contrast: number;
};

type Component = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  pixels: number;
};

const SAMPLE_WIDTH = 360;
const BOTTOM_START_RATIO = 0.93;
const FOREGROUND_DELTA = 18;

/** Detects only OS navigation evidence in the extreme bottom screen band. */
export async function detectOnScreenNavigation(input: {
  imageBytes: Buffer;
  viewport: { width: number; height: number };
}): Promise<OnScreenNavigationEvidence> {
  if (!input.imageBytes.length) throw new Error("Navigation detection needs an image.");
  if (
    !Number.isInteger(input.viewport.width) || input.viewport.width < 240 ||
    !Number.isInteger(input.viewport.height) || input.viewport.height < 320
  ) throw new Error("Navigation viewport is invalid.");
  const sampleHeight = Math.round(
    SAMPLE_WIDTH * input.viewport.height / input.viewport.width,
  );
  const decoded = await sharp(input.imageBytes)
    .resize(SAMPLE_WIDTH, sampleHeight, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  const rowBaselines = Array.from({ length: sampleHeight }, (_, y) =>
    medianRow(decoded, SAMPLE_WIDTH, y)
  );
  const gesture = detectGestureHandle(
    decoded,
    SAMPLE_WIDTH,
    sampleHeight,
    rowBaselines,
  );
  const scaleX = input.viewport.width / SAMPLE_WIDTH;
  const scaleY = input.viewport.height / sampleHeight;
  if (gesture) {
    return {
      version: 1,
      mode: "shadow",
      status: "detected",
      strategy: "gesture_handle",
      confidence: rounded(gesture.confidence),
      homePoint: null,
      gestureHandleBounds: {
        left: rounded(gesture.left * scaleX),
        top: rounded(gesture.top * scaleY),
        width: rounded(gesture.width * scaleX),
        height: rounded(gesture.height * scaleY),
      },
      threeButtonCenters: null,
      wouldMoveHardware: false,
      actionReady: false,
    };
  }
  const buttons = detectThreeButtons(
    decoded,
    SAMPLE_WIDTH,
    sampleHeight,
    rowBaselines,
  );
  if (buttons) {
    const centers = buttons.centers.map((point) => ({
      x: rounded(point.x * scaleX),
      y: rounded(point.y * scaleY),
    })) as [Point, Point, Point];
    return {
      version: 1,
      mode: "shadow",
      status: "detected",
      strategy: "three_button",
      confidence: rounded(buttons.confidence),
      homePoint: centers[1],
      gestureHandleBounds: null,
      threeButtonCenters: centers,
      wouldMoveHardware: false,
      actionReady: false,
    };
  }
  return {
    version: 1,
    mode: "shadow",
    status: "not_detected",
    strategy: "unknown",
    confidence: 0,
    homePoint: null,
    gestureHandleBounds: null,
    threeButtonCenters: null,
    wouldMoveHardware: false,
    actionReady: false,
  };
}

function detectGestureHandle(
  pixels: Buffer,
  width: number,
  height: number,
  baselines: number[],
) {
  const rows: RowRun[] = [];
  const startY = Math.floor(height * 0.94);
  for (let y = startY; y < height - 1; y += 1) {
    const baseline = baselines[y];
    const active = Array.from({ length: width }, (_, x) =>
      Math.abs(pixels[(y * width) + x] - baseline) >= FOREGROUND_DELTA
    );
    for (const run of activeRuns(active, 1)) {
      const runWidth = run.right - run.left + 1;
      const center = (run.left + run.right) / 2;
      if (
        runWidth < width * 0.08 || runWidth > width * 0.46 ||
        Math.abs(center - width / 2) > width * 0.12
      ) continue;
      const contrast = mean(Array.from(
        { length: runWidth },
        (_, offset) => Math.abs(
          pixels[(y * width) + run.left + offset] - baseline,
        ),
      ));
      rows.push({
        y,
        left: run.left,
        right: run.right,
        width: runWidth,
        center,
        contrast,
      });
    }
  }
  const groups: RowRun[][] = [];
  for (const row of rows) {
    const group = groups.find((candidate) => {
      const previous = candidate.at(-1);
      return previous && row.y === previous.y + 1 &&
        Math.abs(row.center - previous.center) <= 4 &&
        Math.abs(row.width - previous.width) <= width * 0.05;
    });
    if (group) group.push(row);
    else groups.push([row]);
  }
  const candidates = groups.filter((group) => group.length >= 2).map((group) => {
    const left = median(group.map((row) => row.left));
    const right = median(group.map((row) => row.right));
    const top = group[0].y;
    const bottom = group.at(-1)?.y ?? top;
    const candidateWidth = right - left + 1;
    const candidateHeight = bottom - top + 1;
    const aspect = candidateWidth / candidateHeight;
    const center = (left + right) / 2;
    const centerScore = clamp01(1 - Math.abs(center - width / 2) / (width * 0.1));
    const widthRatio = candidateWidth / width;
    const widthScore = widthRatio >= 0.12 && widthRatio <= 0.38
      ? 1
      : clamp01(1 - Math.min(
          Math.abs(widthRatio - 0.12),
          Math.abs(widthRatio - 0.38),
        ) / 0.12);
    const aspectScore = clamp01((aspect - 6) / 12);
    const bottomScore = clamp01(((top + bottom) / 2 / height - 0.94) / 0.05);
    const contrast = mean(group.map((row) => row.contrast));
    const contrastScore = clamp01((contrast - 10) / 45);
    const confidence =
      (contrastScore * 0.28) +
      (aspectScore * 0.27) +
      (centerScore * 0.2) +
      (widthScore * 0.15) +
      (bottomScore * 0.1);
    return {
      left,
      top,
      width: candidateWidth,
      height: candidateHeight,
      aspect,
      contrast,
      confidence,
    };
  }).filter((candidate) =>
    candidate.aspect >= 7 &&
    candidate.height <= height * 0.025 &&
    candidate.contrast >= 16 &&
    candidate.confidence >= 0.76
  ).sort((left, right) => right.confidence - left.confidence);
  if (!candidates[0]) return null;
  if (
    candidates[1] &&
    candidates[0].confidence - candidates[1].confidence < 0.08
  ) return null;
  return candidates[0];
}

function detectThreeButtons(
  pixels: Buffer,
  width: number,
  height: number,
  baselines: number[],
) {
  const top = Math.floor(height * BOTTOM_START_RATIO);
  const bandHeight = height - top;
  const mask = new Uint8Array(width * bandHeight);
  for (let y = top; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (Math.abs(pixels[(y * width) + x] - baselines[y]) >= FOREGROUND_DELTA) {
        mask[((y - top) * width) + x] = 1;
      }
    }
  }
  const dilated = dilate(mask, width, bandHeight);
  const components = connectedComponents(dilated, width, bandHeight)
    .map((component) => ({
      ...component,
      top: component.top + top,
      bottom: component.bottom + top,
    }))
    .filter((component) => {
      const componentWidth = component.right - component.left + 1;
      const componentHeight = component.bottom - component.top + 1;
      const centerY = (component.top + component.bottom) / 2;
      const aspect = componentWidth / componentHeight;
      return component.pixels >= 8 &&
        componentWidth >= width * 0.012 && componentWidth <= width * 0.11 &&
        componentHeight >= height * 0.004 && componentHeight <= height * 0.04 &&
        centerY >= height * 0.945 && centerY <= height * 0.997 &&
        aspect >= 0.35 && aspect <= 3;
    });
  const zones = [
    { minimum: 0.12, maximum: 0.38, target: 0.25 },
    { minimum: 0.4, maximum: 0.6, target: 0.5 },
    { minimum: 0.62, maximum: 0.88, target: 0.75 },
  ];
  const selected = zones.map((zone) => components.map((component) => {
    const centerX = (component.left + component.right) / 2;
    const centerY = (component.top + component.bottom) / 2;
    const ratio = centerX / width;
    if (ratio < zone.minimum || ratio > zone.maximum) return null;
    const positionScore = clamp01(
      1 - Math.abs(ratio - zone.target) / (zone.maximum - zone.minimum),
    );
    const sizeScore = clamp01(component.pixels / 90);
    const bottomScore = clamp01((centerY / height - 0.94) / 0.055);
    return {
      component,
      center: { x: centerX, y: centerY },
      score: (positionScore * 0.5) + (sizeScore * 0.25) + (bottomScore * 0.25),
    };
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.score - left.score)[0] ?? null);
  if (selected.some((candidate) => candidate === null)) return null;
  const complete = selected as Array<NonNullable<(typeof selected)[number]>>;
  const yValues = complete.map((candidate) => candidate.center.y);
  if (Math.max(...yValues) - Math.min(...yValues) > height * 0.018) return null;
  const minimumScore = Math.min(...complete.map((candidate) => candidate.score));
  if (minimumScore < 0.62) return null;
  return {
    centers: complete.map((candidate) => candidate.center) as [Point, Point, Point],
    confidence: minimumScore,
  };
}

function activeRuns(values: boolean[], allowedGap: number) {
  const runs: Array<{ left: number; right: number }> = [];
  let left = -1;
  let lastActive = -1;
  let gap = 0;
  for (let index = 0; index <= values.length; index += 1) {
    if (values[index] === true) {
      if (left < 0) left = index;
      lastActive = index;
      gap = 0;
    } else if (left >= 0) {
      gap += 1;
      if (gap > allowedGap) {
        runs.push({ left, right: lastActive });
        left = -1;
        lastActive = -1;
        gap = 0;
      }
    }
  }
  return runs;
}

function dilate(input: Uint8Array, width: number, height: number) {
  const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let active = false;
      for (let dy = -1; dy <= 1 && !active; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height &&
              input[(ny * width) + nx]) {
            active = true;
            break;
          }
        }
      }
      if (active) output[(y * width) + x] = 1;
    }
  }
  return output;
}

function connectedComponents(input: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(input.length);
  const components: Component[] = [];
  for (let start = 0; start < input.length; start += 1) {
    if (!input[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    let pixels = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      pixels += 1;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = (ny * width) + nx;
        if (!input[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    components.push({ left, right, top, bottom, pixels });
  }
  return components;
}

function medianRow(pixels: Buffer, width: number, y: number) {
  const values = Array.from(pixels.subarray(y * width, (y + 1) * width));
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
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
