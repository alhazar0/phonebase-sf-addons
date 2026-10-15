import sharp from "sharp";
import { mapImagePointToMachine } from "../agent/homography";

export type ScreenPoint = { x: number; y: number };

export type DetectedTouch = {
  point: ScreenPoint;
  bounds: { left: number; top: number; right: number; bottom: number };
  pixelCount: number;
  confidence: number;
};

export type ReferenceGeometry = {
  coordinateOffset: ScreenPoint;
  validationDelta: ScreenPoint;
  validationController: ScreenPoint;
};

export type BrowserTouchSample = {
  normalizedScreenX: number;
  normalizedScreenY: number;
  coordinateSpaceVersion: number;
};

export type BrowserViewportSample = {
  y: number;
  screenY: number;
  viewportHeight: number;
  screenHeight: number;
};

export type TouchScaleAdjustment = {
  scale: ScreenPoint;
  controlMachinePoints: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
};

export type PrecisionTouchPair = {
  screen: ScreenPoint;
  machine: ScreenPoint;
};

export function screenPointToMachine({
  width,
  height,
  controlMachinePoints,
  point,
}: {
  width: number;
  height: number;
  controlMachinePoints: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  point: ScreenPoint;
}) {
  return mapImagePointToMachine({
    imagePoints: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    machinePoints: controlMachinePoints,
  }, point);
}

/**
 * Re-anchors an already learned screen transform after an open-loop arm has
 * lost steps. `screenDelta` is desired minus observed in screen pixels.
 */
export function translatedControlMachinePoints({
  width,
  height,
  controlMachinePoints,
  screenDelta,
}: {
  width: number;
  height: number;
  controlMachinePoints: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  screenDelta: ScreenPoint;
}) {
  const corners: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  return corners.map((corner) => {
    const mapped = screenPointToMachine({
      width,
      height,
      controlMachinePoints,
      point: {
        x: corner.x + screenDelta.x,
        y: corner.y + screenDelta.y,
      },
    });
    return {
      x: Math.round(mapped.x * 1000) / 1000,
      y: Math.round(mapped.y * 1000) / 1000,
    };
  }) as [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
}

export type AffineTouchCalibration = {
  controlMachinePoints: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  coefficients: {
    x: [number, number, number];
    y: [number, number, number];
  };
  rmseMm: number;
  maximumErrorMm: number;
};

export type ProjectiveTouchCalibration = {
  controlPoints: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  coefficients: [number, number, number, number, number, number, number, number];
  rmse: number;
  maximumError: number;
};

type CandidateComponent = DetectedTouch & { score: number };

export function calibrationSampleScreenPoint(
  sample: BrowserTouchSample,
  width: number,
  height: number,
): ScreenPoint {
  if (
    sample.coordinateSpaceVersion !== 2 ||
    !Number.isFinite(sample.normalizedScreenX) ||
    !Number.isFinite(sample.normalizedScreenY) ||
    sample.normalizedScreenX < 0 || sample.normalizedScreenX > 1 ||
    sample.normalizedScreenY < 0 || sample.normalizedScreenY > 1 ||
    !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0
  ) {
    throw new Error("标定页没有提供有效的全屏触点坐标");
  }
  return {
    x: Math.round(sample.normalizedScreenX * width * 1000) / 1000,
    y: Math.round(sample.normalizedScreenY * height * 1000) / 1000,
  };
}

/**
 * Returns a lower calibration row that is still inside Safari's web content.
 *
 * iPhone Safari reserves part of the physical display for browser chrome. A
 * point can therefore be reachable by the stylus while being invisible to the
 * calibration page's pointer listener.  Keep a four-percent screen margin
 * above that boundary and cap the row at 78%, which still provides a broad
 * affine baseline without touching Safari's toolbar.
 */
export function precisionCalibrationLowerYRatio(
  sample: BrowserViewportSample | null | undefined,
) {
  if (!sample) return 0.76;
  const values = [
    sample.y,
    sample.screenY,
    sample.viewportHeight,
    sample.screenHeight,
  ];
  if (
    !values.every(Number.isFinite) ||
    sample.viewportHeight <= 0 || sample.screenHeight <= 0
  ) {
    throw new Error("标定页没有提供有效的 Safari 可触高度");
  }
  const screenTop = sample.screenY - sample.y;
  const visibleBottomRatio = (
    screenTop + sample.viewportHeight
  ) / sample.screenHeight;
  const lowerYRatio = Math.min(0.78, visibleBottomRatio - 0.04);
  if (lowerYRatio < 0.62) {
    throw new Error("Safari 网页可触区域过小，无法完成可靠的全屏拟合");
  }
  return Math.round(lowerYRatio * 1_000_000) / 1_000_000;
}

export function adjustedControlMachinePoints({
  width,
  height,
  controlMachinePoints,
  anchor,
  expected,
  actual,
}: {
  width: number;
  height: number;
  controlMachinePoints: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  anchor: ScreenPoint;
  expected: ScreenPoint;
  actual: ScreenPoint;
}): TouchScaleAdjustment {
  const actualDelta = {
    x: actual.x - anchor.x,
    y: actual.y - anchor.y,
  };
  const expectedDelta = {
    x: expected.x - anchor.x,
    y: expected.y - anchor.y,
  };
  if (
    ![width, height, actualDelta.x, actualDelta.y, expectedDelta.x, expectedDelta.y]
      .every(Number.isFinite) ||
    Math.abs(actualDelta.x) < 40 || Math.abs(actualDelta.y) < 40
  ) {
    throw new Error("两个网页触点不足以计算可靠的屏幕比例");
  }
  const scale = {
    x: expectedDelta.x / actualDelta.x,
    y: expectedDelta.y / actualDelta.y,
  };
  if (
    scale.x < 0.55 || scale.x > 1.35 ||
    scale.y < 0.55 || scale.y > 1.35
  ) {
    throw new Error(
      `网页触点比例超出安全自适应范围：X=${scale.x.toFixed(3)}/` +
      `Y=${scale.y.toFixed(3)}`,
    );
  }

  const screenCorners: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const transformedCorners = screenCorners.map((corner) => ({
    x: anchor.x + scale.x * (corner.x - anchor.x),
    y: anchor.y + scale.y * (corner.y - anchor.y),
  })) as [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  if (transformedCorners.some((corner) => (
    corner.x < 0 || corner.x > width || corner.y < 0 || corner.y > height
  ))) {
    throw new Error("自适应后的屏幕边界超出原始安全标定范围");
  }
  const calibration = {
    imagePoints: screenCorners,
    machinePoints: controlMachinePoints,
  };
  const adjusted = transformedCorners.map((corner) => {
    const mapped = mapImagePointToMachine(calibration, corner);
    return {
      x: Math.round(mapped.x * 1000) / 1000,
      y: Math.round(mapped.y * 1000) / 1000,
    };
  }) as [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  return {
    scale: {
      x: Math.round(scale.x * 1_000_000) / 1_000_000,
      y: Math.round(scale.y * 1_000_000) / 1_000_000,
    },
    controlMachinePoints: adjusted,
  };
}

function solveThreeByThree(
  matrix: [[number, number, number], [number, number, number], [number, number, number]],
  vector: [number, number, number],
): [number, number, number] {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-9) {
      throw new Error("精密触点分布退化，无法拟合整屏坐标");
    }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index < 4; index += 1) {
      rows[column][index] /= divisor;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index < 4; index += 1) {
        rows[row][index] -= factor * rows[column][index];
      }
    }
  }
  return [rows[0][3], rows[1][3], rows[2][3]];
}

function solveSquareSystem(matrix: number[][], vector: number[]) {
  const size = matrix.length;
  if (
    size === 0 || vector.length !== size ||
    matrix.some((row) => row.length !== size)
  ) {
    throw new Error("精密标定线性系统尺寸无效");
  }
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) {
      throw new Error("精密触点分布退化，无法拟合透视坐标");
    }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index <= size; index += 1) {
      rows[column][index] /= divisor;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index <= size; index += 1) {
        rows[row][index] -= factor * rows[column][index];
      }
    }
  }
  return rows.map((row) => row[size]);
}

export function projectProjectiveCalibration(
  calibration: ProjectiveTouchCalibration,
  point: ScreenPoint,
  width: number,
  height: number,
) {
  const u = point.x / width;
  const v = point.y / height;
  const [a, b, c, d, e, f, g, h] = calibration.coefficients;
  const denominator = g * u + h * v + 1;
  if (Math.abs(denominator) < 0.1) {
    throw new Error("透视坐标在屏幕区域内发生退化");
  }
  return {
    x: (a * u + b * v + c) / denominator,
    y: (d * u + e * v + f) / denominator,
  };
}

/** Fits a screen-to-destination homography from redundant physical samples. */
export function fitProjectiveTouchCalibration(
  pairs: PrecisionTouchPair[],
  width: number,
  height: number,
): ProjectiveTouchCalibration {
  if (
    pairs.length < 6 || !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0
  ) {
    throw new Error("透视精密标定至少需要六个有效触点");
  }
  const scaleX = Math.max(1, ...pairs.map((pair) => Math.abs(pair.machine.x)));
  const scaleY = Math.max(1, ...pairs.map((pair) => Math.abs(pair.machine.y)));
  const normal = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  const target = Array<number>(8).fill(0);
  const accumulate = (row: number[], value: number) => {
    for (let left = 0; left < 8; left += 1) {
      target[left] += row[left] * value;
      for (let right = 0; right < 8; right += 1) {
        normal[left][right] += row[left] * row[right];
      }
    }
  };
  for (const pair of pairs) {
    const values = [
      pair.screen.x, pair.screen.y,
      pair.machine.x, pair.machine.y,
    ];
    if (!values.every(Number.isFinite)) {
      throw new Error("透视精密标定触点必须是有限坐标");
    }
    const u = pair.screen.x / width;
    const v = pair.screen.y / height;
    const x = pair.machine.x / scaleX;
    const y = pair.machine.y / scaleY;
    accumulate([u, v, 1, 0, 0, 0, -x * u, -x * v], x);
    accumulate([0, 0, 0, u, v, 1, -y * u, -y * v], y);
  }
  const normalized = solveSquareSystem(normal, target);
  const coefficients = [
    normalized[0] * scaleX,
    normalized[1] * scaleX,
    normalized[2] * scaleX,
    normalized[3] * scaleY,
    normalized[4] * scaleY,
    normalized[5] * scaleY,
    normalized[6],
    normalized[7],
  ] as ProjectiveTouchCalibration["coefficients"];
  const provisional: ProjectiveTouchCalibration = {
    controlPoints: [
      { x: 0, y: 0 }, { x: 0, y: 0 },
      { x: 0, y: 0 }, { x: 0, y: 0 },
    ],
    coefficients,
    rmse: 0,
    maximumError: 0,
  };
  const errors = pairs.map((pair) => {
    const predicted = projectProjectiveCalibration(
      provisional,
      pair.screen,
      width,
      height,
    );
    return Math.hypot(
      predicted.x - pair.machine.x,
      predicted.y - pair.machine.y,
    );
  });
  const screenCorners: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  provisional.controlPoints = screenCorners.map((point) => {
    const projected = projectProjectiveCalibration(provisional, point, width, height);
    return {
      x: Math.round(projected.x * 1000) / 1000,
      y: Math.round(projected.y * 1000) / 1000,
    };
  }) as ProjectiveTouchCalibration["controlPoints"];
  provisional.coefficients = coefficients.map(
    (value) => Math.round(value * 1_000_000) / 1_000_000,
  ) as ProjectiveTouchCalibration["coefficients"];
  provisional.rmse = Math.round(Math.sqrt(
    errors.reduce((sum, error) => sum + error * error, 0) / errors.length,
  ) * 1_000_000) / 1_000_000;
  provisional.maximumError = Math.round(
    Math.max(...errors) * 1_000_000,
  ) / 1_000_000;
  return provisional;
}

/** Finds the red crosshair rendered by the dedicated calibration page. */
export async function detectCalibrationMarker(
  jpeg: Buffer,
  expected?: ScreenPoint,
): Promise<DetectedTouch | null> {
  const image = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = image.info;
  const frameMinimumX = Math.round(width * 0.08);
  const frameMaximumX = Math.round(width * 0.92);
  const frameMinimumY = Math.round(height * 0.08);
  const frameMaximumY = Math.round(height * 0.92);
  const searchRadius = Math.round(Math.min(width, height) * 0.24);
  const minimumX = expected
    ? Math.max(frameMinimumX, Math.round(expected.x) - searchRadius)
    : frameMinimumX;
  const maximumX = expected
    ? Math.min(frameMaximumX, Math.round(expected.x) + searchRadius)
    : frameMaximumX;
  const minimumY = expected
    ? Math.max(frameMinimumY, Math.round(expected.y) - searchRadius)
    : frameMinimumY;
  const maximumY = expected
    ? Math.min(frameMaximumY, Math.round(expected.y) + searchRadius)
    : frameMaximumY;
  const columnScores = new Float64Array(width);
  const rowScores = new Float64Array(height);
  const pixelScores = new Float32Array(width * height);
  for (let y = minimumY; y < maximumY; y += 1) {
    for (let x = minimumX; x < maximumX; x += 1) {
      const index = (y * width + x) * channels;
      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];
      // Score both redness and darkness. The camera often fragments the thin
      // CSS crosshair under glare, so a connected red bounding box is not a
      // reliable centre estimator. The long horizontal and vertical strokes,
      // however, create coincident peaks in the image's row/column projections.
      const redness = Math.max(0, 2 * red - green - blue);
      const darkness = Math.max(0, 220 - (red + green + blue) / 3);
      const score = redness * darkness;
      pixelScores[y * width + x] = score;
      columnScores[x] += score;
      rowScores[y] += score;
    }
  }
  const crosshairPeak = (scores: Float64Array, start: number, end: number) => {
    const minimumRadius = Math.max(12, Math.round(Math.min(width, height) * 0.025));
    const maximumRadius = Math.max(minimumRadius, Math.round(Math.min(width, height) * 0.06));
    let peak = start + maximumRadius;
    let peakScore = -1;
    for (let index = start + maximumRadius; index < end - maximumRadius; index += 1) {
      let score = -1;
      for (let radius = minimumRadius; radius <= maximumRadius; radius += 1) {
        score = Math.max(
          score,
          scores[index] + 0.7 * (scores[index - radius] + scores[index + radius]),
        );
      }
      if (score > peakScore) {
        peak = index;
        peakScore = score;
      }
    }
    return peak;
  };
  const centreOfPeak = (scores: Float64Array, peak: number) => {
    let weighted = 0;
    let total = 0;
    for (let index = Math.max(0, peak - 2); index <= Math.min(scores.length - 1, peak + 2); index += 1) {
      weighted += index * scores[index];
      total += scores[index];
    }
    return total > 0 ? weighted / total : peak;
  };
  const median = (scores: Float64Array, start: number, end: number) => {
    const values = Array.from(scores.slice(start, end)).sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)] ?? 0;
  };
  const peakX = crosshairPeak(columnScores, minimumX, maximumX);
  const peakY = crosshairPeak(rowScores, minimumY, maximumY);
  const columnBackground = median(columnScores, minimumX, maximumX);
  const rowBackground = median(rowScores, minimumY, maximumY);
  const columnRatio = columnScores[peakX] / Math.max(1, columnBackground);
  const rowRatio = rowScores[peakY] / Math.max(1, rowBackground);
  if (
    columnScores[peakX] < 20_000 || rowScores[peakY] < 20_000 ||
    columnRatio < 1.8 || rowRatio < 1.8
  ) {
    return null;
  }
  const point = {
    x: Math.round(centreOfPeak(columnScores, peakX) * 1000) / 1000,
    y: Math.round(centreOfPeak(rowScores, peakY) * 1000) / 1000,
  };
  const radius = Math.max(18, Math.round(Math.min(width, height) * 0.07));
  const bounds = {
    left: Math.max(minimumX, Math.round(point.x) - radius),
    top: Math.max(minimumY, Math.round(point.y) - radius),
    right: Math.min(maximumX - 1, Math.round(point.x) + radius),
    bottom: Math.min(maximumY - 1, Math.round(point.y) + radius),
  };
  let pixelCount = 0;
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (pixelScores[y * width + x] >= 600) pixelCount += 1;
    }
  }
  return {
    point,
    bounds,
    pixelCount,
    confidence: Math.min(1, Math.min(columnRatio, rowRatio) / 4),
  };
}

/**
 * Safari exposes 16:9 CSS screen dimensions on iPhones with a separate Home
 * button (for example 375×667 on iPhone SE).  The button centre sits about 7%
 * of an active-display height below the bottom edge.  Returning this as
 * an extrapolated screen point lets the already learned projective transform
 * produce a machine coordinate without pretending the button is part of the
 * clickable display.
 */
export function legacyIphoneHomeButtonScreenPoint(
  sample: { screenWidth: number; screenHeight: number } | undefined,
  width: number,
  height: number,
): ScreenPoint | null {
  if (!sample || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (
    sample.screenWidth <= 0 || sample.screenHeight <= 0 ||
    sample.screenWidth >= sample.screenHeight
  ) {
    return null;
  }
  const aspectRatio = sample.screenHeight / sample.screenWidth;
  if (Math.abs(aspectRatio - 16 / 9) > 0.025) return null;
  return {
    x: Math.round(width * 0.5 * 1000) / 1000,
    // The 4.7-inch iPhone 6/7/8/SE 2/SE 3 chassis places the physical Home
    // button center about 7% below the active display.  The previous 10%
    // estimate landed roughly 3 mm too low on an iPhone SE and could miss the
    // button while still reporting a mechanically completed tap.
    y: Math.round(height * 1.07 * 1000) / 1000,
  };
}

export function fitAffineTouchCalibration(
  pairs: PrecisionTouchPair[],
  width: number,
  height: number,
): AffineTouchCalibration {
  if (
    pairs.length < 4 || !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0
  ) {
    throw new Error("精密标定至少需要四个有效触点");
  }
  const normal: [[number, number, number], [number, number, number], [number, number, number]] = [
    [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ];
  const targetX: [number, number, number] = [0, 0, 0];
  const targetY: [number, number, number] = [0, 0, 0];
  for (const pair of pairs) {
    const values = [
      pair.screen.x, pair.screen.y,
      pair.machine.x, pair.machine.y,
    ];
    if (!values.every(Number.isFinite)) {
      throw new Error("精密标定触点必须是有限坐标");
    }
    const basis: [number, number, number] = [
      1,
      pair.screen.x / width,
      pair.screen.y / height,
    ];
    for (let row = 0; row < 3; row += 1) {
      targetX[row] += basis[row] * pair.machine.x;
      targetY[row] += basis[row] * pair.machine.y;
      for (let column = 0; column < 3; column += 1) {
        normal[row][column] += basis[row] * basis[column];
      }
    }
  }
  const coefficientX = solveThreeByThree(normal, targetX);
  const coefficientY = solveThreeByThree(normal, targetY);
  const predict = (u: number, v: number): ScreenPoint => ({
    x: coefficientX[0] + coefficientX[1] * u + coefficientX[2] * v,
    y: coefficientY[0] + coefficientY[1] * u + coefficientY[2] * v,
  });
  const errors = pairs.map((pair) => {
    const predicted = predict(pair.screen.x / width, pair.screen.y / height);
    return Math.hypot(
      predicted.x - pair.machine.x,
      predicted.y - pair.machine.y,
    );
  });
  const rmseMm = Math.sqrt(
    errors.reduce((sum, error) => sum + error * error, 0) / errors.length,
  );
  const corners = [
    predict(0, 0), predict(1, 0), predict(1, 1), predict(0, 1),
  ].map((point) => ({
    x: Math.round(point.x * 1000) / 1000,
    y: Math.round(point.y * 1000) / 1000,
  })) as [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  return {
    controlMachinePoints: corners,
    coefficients: {
      x: coefficientX.map((value) => Math.round(value * 1_000_000) / 1_000_000) as
        [number, number, number],
      y: coefficientY.map((value) => Math.round(value * 1_000_000) / 1_000_000) as
        [number, number, number],
    },
    rmseMm: Math.round(rmseMm * 1_000_000) / 1_000_000,
    maximumErrorMm: Math.round(Math.max(...errors) * 1_000_000) / 1_000_000,
  };
}

/**
 * Finds a newly rendered compact touch marker between two wired iPhone frames.
 *
 * The recovery phone displays ScreenHand's dedicated touch-calibration page.
 * Its red crosshair can be close to 100 output pixels wide after iPhone video
 * scaling, so compact components are allowed to be larger than a pen dot while
 * full-screen UI transitions are still rejected.
 */
export async function detectNewTouch(
  beforeJpeg: Buffer,
  afterJpeg: Buffer,
): Promise<DetectedTouch | null> {
  const [before, after] = await Promise.all([
    sharp(beforeJpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(afterJpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (
    before.info.width !== after.info.width ||
    before.info.height !== after.info.height ||
    before.info.channels !== after.info.channels
  ) {
    throw new Error("视觉参考的前后画面尺寸不一致");
  }

  const width = before.info.width;
  const height = before.info.height;
  const channels = before.info.channels;
  // The calibration page intentionally exercises the top 15% of the phone.
  // Keep only a small camera-edge margin so those real touches are not
  // discarded before the component safety filters run.
  const minimumY = Math.max(64, Math.round(height * 0.04));
  const maximumY = Math.min(height - 190, Math.round(height * 0.87));
  const candidates = new Uint8Array(width * height);

  for (let y = minimumY; y < maximumY; y += 1) {
    for (let x = 8; x < width - 8; x += 1) {
      const index = (y * width + x) * channels;
      const beforeLuma = (
        before.data[index] + before.data[index + 1] + before.data[index + 2]
      ) / 3;
      const afterLuma = (
        after.data[index] + after.data[index + 1] + after.data[index + 2]
      ) / 3;
      if (
        beforeLuma >= 205 &&
        afterLuma <= 190 &&
        beforeLuma - afterLuma >= 28
      ) {
        candidates[y * width + x] = 1;
      }
    }
  }

  const visited = new Uint8Array(width * height);
  const components: CandidateComponent[] = [];
  for (let y = minimumY; y < maximumY; y += 1) {
    for (let x = 8; x < width - 8; x += 1) {
      const start = y * width + x;
      if (!candidates[start] || visited[start]) continue;
      const queue = [start];
      visited[start] = 1;
      let cursor = 0;
      let pixelCount = 0;
      let left = x;
      let right = x;
      let top = y;
      let bottom = y;
      let weightedX = 0;
      let weightedY = 0;
      let totalWeight = 0;
      let score = 0;

      while (cursor < queue.length) {
        const current = queue[cursor++];
        const currentX = current % width;
        const currentY = Math.floor(current / width);
        const byteIndex = current * channels;
        const beforeLuma = (
          before.data[byteIndex] +
          before.data[byteIndex + 1] +
          before.data[byteIndex + 2]
        ) / 3;
        const afterLuma = (
          after.data[byteIndex] +
          after.data[byteIndex + 1] +
          after.data[byteIndex + 2]
        ) / 3;
        const weight = Math.max(1, beforeLuma - afterLuma);
        pixelCount += 1;
        left = Math.min(left, currentX);
        right = Math.max(right, currentX);
        top = Math.min(top, currentY);
        bottom = Math.max(bottom, currentY);
        weightedX += currentX * weight;
        weightedY += currentY * weight;
        totalWeight += weight;
        score += weight;

        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (offsetX === 0 && offsetY === 0) continue;
            const nextX = currentX + offsetX;
            const nextY = currentY + offsetY;
            if (
              nextX < 8 || nextX >= width - 8 ||
              nextY < minimumY || nextY >= maximumY
            ) continue;
            const next = nextY * width + nextX;
            if (candidates[next] && !visited[next]) {
              visited[next] = 1;
              queue.push(next);
            }
          }
        }
      }

      const componentWidth = right - left + 1;
      const componentHeight = bottom - top + 1;
      if (
        pixelCount < 2 ||
        pixelCount > 6_000 ||
        componentWidth > 128 ||
        componentHeight > 128 ||
        score < 100
      ) continue;
      components.push({
        point: {
          x: Math.round((weightedX / totalWeight) * 1000) / 1000,
          y: Math.round((weightedY / totalWeight) * 1000) / 1000,
        },
        bounds: { left, top, right, bottom },
        pixelCount,
        confidence: Math.round(Math.min(1, score / 2_000) * 1000) / 1000,
        score,
      });
    }
  }

  components.sort((left, right) => right.score - left.score);
  const detected = components[0];
  if (!detected) return null;
  return {
    point: detected.point,
    bounds: detected.bounds,
    pixelCount: detected.pixelCount,
    confidence: detected.confidence,
  };
}

export function validationPoint(
  anchor: ScreenPoint,
  width: number,
  height: number,
): ScreenPoint {
  // On the black arm, screen-left/screen-up are positive machine X/Y.  Always
  // validate in that direction so a stuck X or Y home input is approached
  // only from its already verified release direction.
  const x = anchor.x - 160;
  const y = anchor.y - 220;
  return {
    x: Math.round(Math.max(100, Math.min(width - 100, x)) * 1000) / 1000,
    y: Math.round(Math.max(220, Math.min(height - 260, y)) * 1000) / 1000,
  };
}

export function validateReferenceGeometry({
  anchorMachine,
  validationMachine,
  anchorController,
  faultPins,
  maximumControllerX,
  maximumControllerY,
  maximumOffsetMm = 15,
  controlMachinePoints = [],
}: {
  anchorMachine: ScreenPoint;
  validationMachine: ScreenPoint;
  anchorController: ScreenPoint;
  faultPins: "X" | "XY";
  maximumControllerX: number;
  maximumControllerY: number;
  maximumOffsetMm?: number;
  controlMachinePoints?: ScreenPoint[];
}): ReferenceGeometry {
  const values = [
    anchorMachine.x,
    anchorMachine.y,
    validationMachine.x,
    validationMachine.y,
    anchorController.x,
    anchorController.y,
    maximumControllerX,
    maximumControllerY,
    maximumOffsetMm,
    ...controlMachinePoints.flatMap((point) => [point.x, point.y]),
  ];
  if (!values.every(Number.isFinite)) {
    throw new Error("视觉参考坐标必须是有限数字");
  }
  const coordinateOffset = {
    x: anchorController.x - anchorMachine.x,
    y: anchorController.y - anchorMachine.y,
  };
  const validationDelta = {
    x: validationMachine.x - anchorMachine.x,
    y: validationMachine.y - anchorMachine.y,
  };
  const validationController = {
    x: anchorController.x + validationDelta.x,
    y: anchorController.y + validationDelta.y,
  };
  const controllerControlPoints = controlMachinePoints.map((point) => ({
    x: point.x + coordinateOffset.x,
    y: point.y + coordinateOffset.y,
  }));
  if (
    maximumOffsetMm <= 0 || maximumOffsetMm > 50 ||
    Math.abs(coordinateOffset.x) > maximumOffsetMm ||
    Math.abs(coordinateOffset.y) > maximumOffsetMm ||
    validationDelta.x < 5 ||
    (faultPins === "XY" && validationDelta.y < 5) ||
    validationController.x < 0 ||
    validationController.x > maximumControllerX + 8 ||
    validationController.y < 0 ||
    validationController.y > maximumControllerY + 8 ||
    controllerControlPoints.some((point) => (
      point.x < 0 || point.x > maximumControllerX + 8 ||
      point.y < 0 || point.y > maximumControllerY + 8
    ))
  ) {
    throw new Error(
      "视觉参考未通过固定夹具的坐标方向与偏差检查：" +
      `offset=X${coordinateOffset.x.toFixed(3)}/Y${coordinateOffset.y.toFixed(3)} mm，` +
      `limit=${maximumOffsetMm.toFixed(1)} mm，` +
      `delta=X${validationDelta.x.toFixed(3)}/Y${validationDelta.y.toFixed(3)} mm`,
    );
  }
  return { coordinateOffset, validationDelta, validationController };
}
