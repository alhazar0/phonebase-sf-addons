import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Point } from "./homography";

export type Matrix3x3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type VisionRegistrationResult = {
  ok: true;
  confidence: number;
  elapsedMs: number;
  referenceWidth: number;
  referenceHeight: number;
  currentWidth: number;
  currentHeight: number;
  referenceToCurrentVision: Matrix3x3;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "scripts/vision-register.swift");
const binaryPath = resolve(repositoryRoot, ".runtime/vision-register");
let binaryPromise: Promise<string> | null = null;

export function invertHomography(matrix: Matrix3x3): Matrix3x3 {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant =
    a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) {
    throw new Error("Vision registration produced a singular homography.");
  }
  const inverse = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((value) => value / determinant) as Matrix3x3;
  return inverse;
}

export function transformPoint(matrix: Matrix3x3, point: Point): Point {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    throw new Error("Vision registration mapped a point to infinity.");
  }
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

export function referencePointsInCurrentFrame(
  referenceToCurrentVision: Matrix3x3,
  points: [Point, Point, Point, Point],
  imageHeight: number,
) {
  if (!Number.isFinite(imageHeight) || imageHeight <= 0) {
    throw new Error("Camera frame height must be a positive number.");
  }
  return points.map((point) => {
    const transformed = transformPoint(referenceToCurrentVision, {
      x: point.x,
      y: imageHeight - point.y,
    });
    return { x: transformed.x, y: imageHeight - transformed.y };
  }) as [
    Point,
    Point,
    Point,
    Point,
  ];
}

export async function registerVisionFrames(
  referenceBytes: Buffer,
  currentBytes: Buffer,
  signal?: AbortSignal,
): Promise<VisionRegistrationResult> {
  if (process.platform !== "darwin") {
    throw new Error("Camera reference registration currently requires macOS Vision.");
  }
  if (!referenceBytes.length || !currentBytes.length) {
    throw new Error("Camera reference registration requires two non-empty images.");
  }
  const executable = await ensureVisionRegisterBinary(signal);
  const directory = await mkdtemp(resolve(tmpdir(), "screenhand-register-"));
  const referencePath = resolve(directory, "reference.jpg");
  const currentPath = resolve(directory, "current.jpg");
  try {
    await Promise.all([
      writeFile(referencePath, referenceBytes),
      writeFile(currentPath, currentBytes),
    ]);
    const stdout = await runFile(
      executable,
      [referencePath, currentPath],
      signal,
      20_000,
    );
    const parsed = JSON.parse(stdout) as Partial<VisionRegistrationResult>;
    if (
      parsed.ok !== true ||
      !Number.isFinite(parsed.confidence) ||
      !Array.isArray(parsed.referenceToCurrentVision) ||
      parsed.referenceToCurrentVision.length !== 9 ||
      !parsed.referenceToCurrentVision.every(Number.isFinite)
    ) {
      throw new Error("Apple Vision returned an invalid registration response.");
    }
    return parsed as VisionRegistrationResult;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ensureVisionRegisterBinary(signal?: AbortSignal) {
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
