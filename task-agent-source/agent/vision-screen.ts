import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Point } from "./homography";

export type VisionScreenCandidate = {
  confidence: number;
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
  areaRatio: number;
};

export type VisionScreenResult = {
  ok: true;
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
  candidates: VisionScreenCandidate[];
};

export type ScreenQuad = [Point, Point, Point, Point];

export type RankedScreenCandidate = {
  points: ScreenQuad;
  confidence: number;
  areaRatio: number;
  aspectRatio: number;
  score: number;
  meanExpectedErrorPx: number | null;
  maximumExpectedErrorPx: number | null;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "scripts/vision-screen.swift");
const binaryPath = resolve(repositoryRoot, ".runtime/vision-screen");
let binaryPromise: Promise<string> | null = null;

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

type LuminousRow = {
  y: number;
  left: number;
  right: number;
  count: number;
  span: number;
};

function quantile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function fitScreenEdge(rows: LuminousRow[], side: "left" | "right") {
  let selected = rows;
  let result = { slope: 0, intercept: 0, medianResidual: Number.POSITIVE_INFINITY };
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const meanY = selected.reduce((sum, row) => sum + row.y, 0) / selected.length;
    const meanX = selected.reduce((sum, row) => sum + row[side], 0) / selected.length;
    const denominator = selected.reduce(
      (sum, row) => sum + ((row.y - meanY) ** 2),
      0,
    );
    const slope = denominator > 0
      ? selected.reduce(
          (sum, row) => sum + ((row.y - meanY) * (row[side] - meanX)),
          0,
        ) / denominator
      : 0;
    const intercept = meanX - slope * meanY;
    const residuals = selected.map((row) =>
      Math.abs(row[side] - ((slope * row.y) + intercept))
    );
    const medianResidual = quantile(residuals, 0.5);
    result = { slope, intercept, medianResidual };
    if (iteration === 0) {
      const limit = Math.max(3, medianResidual * 3);
      selected = selected.filter((row) =>
        Math.abs(row[side] - ((slope * row.y) + intercept)) <= limit
      );
      if (selected.length < 12) return null;
    }
  }
  return result;
}

/** Detects a lit, near-vertical phone screen against a dark fixture. Apple
 * Vision often reports only app icons when the display has rounded corners;
 * this path fits the long illuminated side edges and infers the hidden dark
 * status-bar edge from the known screen aspect ratio. */
export async function detectLuminousScreenCandidate(
  imageBytes: Buffer,
  expectedScreenAspectRatio = 9 / 19.5,
): Promise<VisionScreenCandidate | null> {
  if (
    !imageBytes.length ||
    !Number.isFinite(expectedScreenAspectRatio) ||
    expectedScreenAspectRatio < 0.25 ||
    expectedScreenAspectRatio > 0.8
  ) return null;
  const metadata = await sharp(imageBytes).metadata();
  const decoded = await sharp(imageBytes)
    .removeAlpha()
    .resize({ width: 720, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (width < 160 || height < 240 || channels < 3) return null;
  const luminanceAt = (x: number, y: number) => {
    const offset = ((y * width) + x) * channels;
    return (decoded.data[offset] * 0.2126) +
      (decoded.data[offset + 1] * 0.7152) +
      (decoded.data[offset + 2] * 0.0722);
  };
  const border: number[] = [];
  const borderWidth = Math.max(3, Math.round(width * 0.008));
  for (let y = 0; y < height; y += 4) {
    for (let offset = 0; offset < borderWidth; offset += 1) {
      border.push(luminanceAt(offset, y), luminanceAt(width - 1 - offset, y));
    }
  }
  const backgroundLuminance = quantile(border, 0.5);
  if (backgroundLuminance > 42) return null;
  const foregroundThreshold = Math.max(12, backgroundLuminance + 10);
  const rows: LuminousRow[] = [];
  for (let y = 0; y < height; y += 1) {
    let left = width;
    let right = -1;
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      if (luminanceAt(x, y) <= foregroundThreshold) continue;
      left = Math.min(left, x);
      right = x;
      count += 1;
    }
    const span = right - left;
    if (count >= width * 0.28 && span >= width * 0.5) {
      rows.push({ y, left, right, count, span });
    }
  }
  if (rows.length < height * 0.25) return null;
  const representativeWidth = quantile(rows.map((row) => row.span), 0.8);
  const edgeRows = rows.filter((row) => row.span >= representativeWidth * 0.96);
  if (edgeRows.length < height * 0.2) return null;
  const leftEdge = fitScreenEdge(edgeRows, "left");
  const rightEdge = fitScreenEdge(edgeRows, "right");
  if (!leftEdge || !rightEdge) return null;
  if (Math.abs(leftEdge.slope) > 0.3 || Math.abs(rightEdge.slope) > 0.3) return null;

  const lowerRows = rows.filter((row) =>
    row.span >= representativeWidth * 0.65 && row.count >= width * 0.28
  );
  if (!lowerRows.length) return null;
  const bottomY = Math.min(height - 1, Math.max(...lowerRows.map((row) => row.y)) + 1);
  const middleY = quantile(edgeRows.map((row) => row.y), 0.5);
  const leftAt = (y: number) => (leftEdge.slope * y) + leftEdge.intercept;
  const rightAt = (y: number) => (rightEdge.slope * y) + rightEdge.intercept;
  const screenWidth = rightAt(middleY) - leftAt(middleY);
  const screenHeight = screenWidth / expectedScreenAspectRatio;
  const topY = bottomY - screenHeight;
  if (
    screenWidth < width * 0.32 || screenWidth > width * 0.9 ||
    screenHeight < height * 0.5 || screenHeight > height * 1.02 ||
    topY < -2 || bottomY > height + 1
  ) return null;

  const scaleX = (metadata.width ?? decoded.info.width) / decoded.info.width;
  const scaleY = (metadata.height ?? decoded.info.height) / decoded.info.height;
  const point = (x: number, y: number): Point => ({ x: x * scaleX, y: y * scaleY });
  const topLeft = point(leftAt(topY), topY);
  const topRight = point(rightAt(topY), topY);
  const bottomRight = point(rightAt(bottomY), bottomY);
  const bottomLeft = point(leftAt(bottomY), bottomY);
  const points = [topLeft, topRight, bottomRight, bottomLeft];
  const imageArea = (decoded.info.width * scaleX) * (decoded.info.height * scaleY);
  const areaRatio = Math.abs(points.reduce((sum, current, index) => {
    const next = points[(index + 1) % points.length];
    return sum + (current.x * next.y) - (next.x * current.y);
  }, 0)) / 2 / imageArea;
  if (areaRatio < 0.18 || areaRatio > 0.9) return null;
  const residual = Math.max(leftEdge.medianResidual, rightEdge.medianResidual);
  const confidence = clamp01(
    0.72 +
    (clamp01(edgeRows.length / (height * 0.55)) * 0.16) +
    (clamp01(1 - residual / 5) * 0.12),
  );
  return { confidence, topLeft, topRight, bottomRight, bottomLeft, areaRatio };
}

export function candidatePoints(candidate: VisionScreenCandidate): ScreenQuad {
  return [
    candidate.topLeft,
    candidate.topRight,
    candidate.bottomRight,
    candidate.bottomLeft,
  ];
}

export function rankScreenCandidate(input: {
  candidate: VisionScreenCandidate;
  imageWidth: number;
  imageHeight: number;
  expectedPoints?: ScreenQuad | null;
  expectedScreenAspectRatio?: number;
}): RankedScreenCandidate {
  const points = candidatePoints(input.candidate);
  const horizontal = (
    distance(points[0], points[1]) + distance(points[3], points[2])
  ) / 2;
  const vertical = (
    distance(points[0], points[3]) + distance(points[1], points[2])
  ) / 2;
  const aspectRatio = vertical > 0 ? horizontal / vertical : 0;
  const expectedAspectRatio = input.expectedScreenAspectRatio ?? 9 / 19.5;
  const aspectScore = clamp01(
    1 - Math.abs(Math.log(Math.max(0.01, aspectRatio) / expectedAspectRatio)) / 1.1,
  );
  const areaScore = clamp01((input.candidate.areaRatio - 0.08) / 0.45);
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const centerDistance = Math.hypot(
    (center.x - input.imageWidth / 2) / input.imageWidth,
    (center.y - input.imageHeight / 2) / input.imageHeight,
  );
  const centerScore = clamp01(1 - centerDistance / 0.55);

  let meanExpectedErrorPx: number | null = null;
  let maximumExpectedErrorPx: number | null = null;
  let expectedScore = 0;
  if (input.expectedPoints) {
    const errors = points.map((point, index) =>
      distance(point, input.expectedPoints?.[index] ?? point)
    );
    meanExpectedErrorPx = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    maximumExpectedErrorPx = Math.max(...errors);
    const diagonal = Math.hypot(input.imageWidth, input.imageHeight);
    expectedScore = clamp01(1 - meanExpectedErrorPx / (diagonal * 0.12));
  }

  const confidence = clamp01(input.candidate.confidence);
  const score = input.expectedPoints
    ? expectedScore * 0.48 + areaScore * 0.20 + aspectScore * 0.17 +
      confidence * 0.10 + centerScore * 0.05
    : areaScore * 0.36 + aspectScore * 0.29 + confidence * 0.20 + centerScore * 0.15;

  return {
    points,
    confidence,
    areaRatio: input.candidate.areaRatio,
    aspectRatio,
    score,
    meanExpectedErrorPx,
    maximumExpectedErrorPx,
  };
}

export function chooseScreenCandidate(input: {
  result: VisionScreenResult;
  expectedPoints?: ScreenQuad | null;
  expectedScreenAspectRatio?: number;
}) {
  const ranked = input.result.candidates
    .map((candidate) => rankScreenCandidate({
      candidate,
      imageWidth: input.result.imageWidth,
      imageHeight: input.result.imageHeight,
      expectedPoints: input.expectedPoints,
      expectedScreenAspectRatio: input.expectedScreenAspectRatio,
    }))
    .filter((candidate) =>
      candidate.areaRatio >= 0.12 &&
      candidate.aspectRatio >= 0.18 &&
      candidate.aspectRatio <= 0.82 &&
      opposingEdgesArePlausible(candidate.points)
    )
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0] ?? null;
  if (!selected || selected.score < (input.expectedPoints ? 0.62 : 0.55)) {
    return { selected: null, ranked };
  }
  return { selected, ranked };
}

function opposingEdgesArePlausible(points: ScreenQuad) {
  const top = distance(points[0], points[1]);
  const right = distance(points[1], points[2]);
  const bottom = distance(points[2], points[3]);
  const left = distance(points[3], points[0]);
  return Math.min(top, bottom) / Math.max(top, bottom) >= 0.42 &&
    Math.min(left, right) / Math.max(left, right) >= 0.55;
}

export async function detectVisionScreen(
  imageBytes: Buffer,
  signal?: AbortSignal,
  expectedScreenAspectRatio: number | null = 9 / 19.5,
): Promise<VisionScreenResult> {
  if (process.platform !== "darwin") {
    throw new Error("Automatic screen detection currently requires macOS Vision.");
  }
  if (!imageBytes.length) throw new Error("Screen detection received an empty image.");
  const executable = await ensureVisionScreenBinary(signal);
  const directory = await mkdtemp(resolve(tmpdir(), "screenhand-screen-"));
  const imagePath = resolve(directory, "frame.jpg");
  try {
    await writeFile(imagePath, imageBytes);
    const stdout = await runFile(executable, [imagePath], signal, 15_000);
    const parsed = JSON.parse(stdout) as Partial<VisionScreenResult>;
    if (
      parsed.ok !== true ||
      !Number.isInteger(parsed.imageWidth) ||
      !Number.isInteger(parsed.imageHeight) ||
      !Array.isArray(parsed.candidates)
    ) {
      throw new Error("Apple Vision returned an invalid screen detection response.");
    }
    const result = parsed as VisionScreenResult;
    const luminous = expectedScreenAspectRatio === null
      ? null
      : await detectLuminousScreenCandidate(
          imageBytes,
          expectedScreenAspectRatio,
        );
    if (luminous) {
      const luminousPoints = candidatePoints(luminous);
      const duplicate = result.candidates.some((candidate) => {
        const points = candidatePoints(candidate);
        return points.reduce(
          (sum, point, index) => sum + distance(point, luminousPoints[index]),
          0,
        ) / points.length < 18;
      });
      if (!duplicate) result.candidates.push(luminous);
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ensureVisionScreenBinary(signal?: AbortSignal) {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      let shouldCompile = false;
      try {
        await access(binaryPath);
        const [source, binary] = await Promise.all([stat(sourcePath), stat(binaryPath)]);
        shouldCompile = source.mtimeMs > binary.mtimeMs;
      } catch {
        shouldCompile = true;
      }
      if (shouldCompile) {
        await mkdir(dirname(binaryPath), { recursive: true });
        await runFile("/usr/bin/swiftc", [sourcePath, "-O", "-o", binaryPath], signal, 90_000);
      }
      return binaryPath;
    })().catch((error) => {
      binaryPromise = null;
      throw error;
    });
  }
  return binaryPromise;
}

function runFile(
  executable: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout: number,
) {
  return new Promise<string>((resolveRun, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal, timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `${executable} failed: ${stderr.trim() || error.message}`,
            { cause: error },
          ));
          return;
        }
        resolveRun(stdout);
      },
    );
  });
}
