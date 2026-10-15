export type CalibrationPoint = { x: number; y: number };

function completePoints(
  values: Array<CalibrationPoint | null>,
): values is CalibrationPoint[] {
  return values.length === 4 && values.every((point) =>
    point !== null && Number.isFinite(point.x) && Number.isFinite(point.y)
  );
}

function span(points: CalibrationPoint[], axis: "x" | "y") {
  const values = points.map((point) => point[axis]);
  return Math.max(...values) - Math.min(...values);
}

function polygonArea(points: CalibrationPoint[]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

function distance(left: CalibrationPoint, right: CalibrationPoint) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function calibrationReadinessIssue(input: {
  imagePoints: Array<CalibrationPoint | null>;
  machinePoints: Array<CalibrationPoint | null>;
}) {
  if (!completePoints(input.imagePoints) || !completePoints(input.machinePoints)) {
    return "Record both a camera point and a machine point for all four corners.";
  }
  const imagePoints = input.imagePoints as CalibrationPoint[];
  const machinePoints = input.machinePoints as CalibrationPoint[];
  if (span(imagePoints, "x") < 40 || span(imagePoints, "y") < 80) {
    return "The four camera points overlap. Select the four separate visible screen corners.";
  }
  if (polygonArea(imagePoints) < 2_000) {
    return "The camera points do not form a valid four-corner screen outline.";
  }
  if (span(machinePoints, "x") < 2 || span(machinePoints, "y") < 2) {
    const first = machinePoints[0];
    return `The machine points overlap near X=${first.x.toFixed(2)}, Y=${first.y.toFixed(2)}. ` +
      "Move the hovering stylus to each matching corner before capturing XY.";
  }
  for (let left = 0; left < machinePoints.length; left += 1) {
    for (let right = left + 1; right < machinePoints.length; right += 1) {
      if (distance(machinePoints[left], machinePoints[right]) < 5) {
        return `Machine points ${left + 1} and ${right + 1} overlap. ` +
          "Move the hovering stylus to each separate matching screen corner before capturing XY.";
      }
    }
  }
  const edgeLengths = machinePoints.map((point, index) =>
    distance(point, machinePoints[(index + 1) % machinePoints.length])
  );
  if (edgeLengths.some((length) => length < 20)) {
    return "The machine points do not cover four separate physical screen corners.";
  }
  if (polygonArea(machinePoints) < 300) {
    return "The machine points do not form a valid four-corner physical area.";
  }
  return null;
}
