import assert from "node:assert/strict";
import test from "node:test";
import {
  homographyFromFourPoints,
  mapImagePointToMachine,
  projectPoint,
  type Point,
} from "./homography";

function close(actual: Point, expected: Point) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-6);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-6);
}

test("maps a rectangular screen into machine millimetres", () => {
  const calibration = {
    imagePoints: [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 2000 },
      { x: 0, y: 2000 },
    ] as [Point, Point, Point, Point],
    machinePoints: [
      { x: 20, y: 30 },
      { x: 80, y: 30 },
      { x: 80, y: 150 },
      { x: 20, y: 150 },
    ] as [Point, Point, Point, Point],
  };

  close(mapImagePointToMachine(calibration, { x: 500, y: 1000 }), {
    x: 50,
    y: 90,
  });
  calibration.imagePoints.forEach((point, index) => {
    close(mapImagePointToMachine(calibration, point), calibration.machinePoints[index]);
  });
});

test("supports perspective camera geometry", () => {
  const source: [Point, Point, Point, Point] = [
    { x: 100, y: 80 },
    { x: 900, y: 120 },
    { x: 820, y: 1700 },
    { x: 160, y: 1600 },
  ];
  const destination: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 120 },
    { x: 0, y: 120 },
  ];
  const matrix = homographyFromFourPoints(source, destination);

  source.forEach((point, index) => {
    close(projectPoint(matrix, point), destination[index]);
  });
});

test("rejects degenerate calibration points", () => {
  const line: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
  ];
  assert.throws(
    () => homographyFromFourPoints(line, line),
    /无法形成有效坐标变换/,
  );
});
