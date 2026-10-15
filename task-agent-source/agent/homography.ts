export type Point = {
  x: number;
  y: number;
};

export type FourPointCalibration = {
  imagePoints: [Point, Point, Point, Point];
  machinePoints: [Point, Point, Point, Point];
};

export type Homography = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function solveLinearSystem(rows: number[][]): number[] {
  const size = rows.length;
  const matrix = rows.map((row) => [...row]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivotRow][column])) {
        pivotRow = row;
      }
    }

    if (Math.abs(matrix[pivotRow][column]) < 1e-10) {
      throw new Error("标定点无法形成有效坐标变换");
    }

    [matrix[column], matrix[pivotRow]] = [
      matrix[pivotRow],
      matrix[column],
    ];

    const pivot = matrix[column][column];
    for (let item = column; item <= size; item += 1) {
      matrix[column][item] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let item = column; item <= size; item += 1) {
        matrix[row][item] -= factor * matrix[column][item];
      }
    }
  }

  return matrix.map((row) => row[size]);
}

/**
 * Computes a projective transform from four camera pixels to four machine
 * coordinates. Point order is conventionally top-left, top-right,
 * bottom-right, bottom-left, but any one-to-one order works.
 */
export function homographyFromFourPoints(
  source: [Point, Point, Point, Point],
  destination: [Point, Point, Point, Point],
): Homography {
  const rows: number[][] = [];

  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = destination[index];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  const solved = solveLinearSystem(rows);
  return [
    solved[0],
    solved[1],
    solved[2],
    solved[3],
    solved[4],
    solved[5],
    solved[6],
    solved[7],
    1,
  ];
}

export function projectPoint(matrix: Homography, point: Point): Point {
  const denominator =
    matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-10) {
    throw new Error("目标点位于无效标定区域");
  }
  return {
    x:
      (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) /
      denominator,
    y:
      (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) /
      denominator,
  };
}

export function mapImagePointToMachine(
  calibration: FourPointCalibration,
  point: Point,
): Point {
  return projectPoint(
    homographyFromFourPoints(
      calibration.imagePoints,
      calibration.machinePoints,
    ),
    point,
  );
}
