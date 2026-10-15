import { decode } from "jpeg-js";

import {
  homographyFromFourPoints,
  projectPoint,
  type Point,
} from "./homography";

export type FrameSyncResult = {
  score: number;
  pixelCorrelation: number;
  edgeCorrelation: number;
  samples: number;
};

type DecodedFrame = {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
};

function luma(frame: DecodedFrame, x: number, y: number) {
  const px = Math.max(0, Math.min(frame.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(frame.height - 1, Math.round(y)));
  const offset = (py * frame.width + px) * 4;
  return (
    frame.data[offset] * 0.299 +
    frame.data[offset + 1] * 0.587 +
    frame.data[offset + 2] * 0.114
  );
}

function averagedLuma(frame: DecodedFrame, x: number, y: number) {
  let sum = 0;
  let count = 0;
  for (const dy of [-2, 0, 2]) {
    for (const dx of [-2, 0, 2]) {
      sum += luma(frame, x + dx, y + dy);
      count += 1;
    }
  }
  return sum / count;
}

function correlation(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 8) return 0;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftEnergy += a * a;
    rightEnergy += b * b;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 1e-6 ? numerator / denominator : 0;
}

function edges(values: number[], columns: number, rows: number) {
  const output: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (column + 1 < columns) output.push(values[index + 1] - values[index]);
      if (row + 1 < rows) output.push(values[index + columns] - values[index]);
    }
  }
  return output;
}

/**
 * Compares the HDMI/UVC screen with the same phone seen by the fixed camera.
 * The physical frame is sampled through the verified four-point perspective
 * transform, so glare and camera perspective do not turn into false matches.
 */
export function comparePhoneFrames(input: {
  digitalJpeg: Buffer;
  physicalJpeg: Buffer;
  physicalScreenPoints: [Point, Point, Point, Point];
}): FrameSyncResult {
  const digital = decode(input.digitalJpeg, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 4,
  });
  const physical = decode(input.physicalJpeg, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 4,
  });
  const digitalCorners: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: digital.width, y: 0 },
    { x: digital.width, y: digital.height },
    { x: 0, y: digital.height },
  ];
  const toPhysical = homographyFromFourPoints(
    digitalCorners,
    input.physicalScreenPoints,
  );
  const columns = 24;
  const rows = 40;
  const digitalValues: number[] = [];
  const physicalValues: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      // Ignore the extreme bezel/status edges, which are most sensitive to a
      // one-pixel crop change and contain little useful UI structure.
      const x = (0.04 + 0.92 * ((column + 0.5) / columns)) * digital.width;
      const y = (0.035 + 0.93 * ((row + 0.5) / rows)) * digital.height;
      const cameraPoint = projectPoint(toPhysical, { x, y });
      digitalValues.push(averagedLuma(digital, x, y));
      physicalValues.push(averagedLuma(physical, cameraPoint.x, cameraPoint.y));
    }
  }
  const pixelCorrelation = correlation(digitalValues, physicalValues);
  const edgeCorrelation = correlation(
    edges(digitalValues, columns, rows),
    edges(physicalValues, columns, rows),
  );
  const score = Math.max(
    0,
    Math.min(1, (pixelCorrelation * 0.35 + edgeCorrelation * 0.65 + 1) / 2),
  );
  return {
    score: Math.round(score * 1_000) / 1_000,
    pixelCorrelation: Math.round(pixelCorrelation * 1_000) / 1_000,
    edgeCorrelation: Math.round(edgeCorrelation * 1_000) / 1_000,
    samples: digitalValues.length,
  };
}
