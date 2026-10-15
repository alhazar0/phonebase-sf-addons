import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  adjustedControlMachinePoints,
  calibrationSampleScreenPoint,
  detectCalibrationMarker,
  detectNewTouch,
  fitAffineTouchCalibration,
  fitProjectiveTouchCalibration,
  legacyIphoneHomeButtonScreenPoint,
  precisionCalibrationLowerYRatio,
  projectProjectiveCalibration,
  validateReferenceGeometry,
  validationPoint,
  screenPointToMachine,
  translatedControlMachinePoints,
} from "./visual_reference";
import { mapImagePointToMachine } from "../agent/homography";

test("maps a browser screen-space touch without needing a video frame", () => {
  assert.deepEqual(calibrationSampleScreenPoint({
    normalizedScreenX: 0.25,
    normalizedScreenY: 0.75,
    coordinateSpaceVersion: 2,
  }, 720, 1560), { x: 180, y: 1170 });
  assert.throws(() => calibrationSampleScreenPoint({
    normalizedScreenX: 0.25,
    normalizedScreenY: 0.75,
    coordinateSpaceVersion: 1,
  }, 720, 1560), /全屏触点坐标/);
});

test("keeps precision points above the iPhone SE Safari toolbar", () => {
  assert.equal(precisionCalibrationLowerYRatio({
    y: 339,
    screenY: 339,
    viewportHeight: 547,
    screenHeight: 667,
  }), 0.78);
  assert.equal(precisionCalibrationLowerYRatio(undefined), 0.76);
  assert.throws(() => precisionCalibrationLowerYRatio({
    y: 200,
    screenY: 200,
    viewportHeight: 390,
    screenHeight: 667,
  }), /可触区域过小/);
});

test("learns independent phone X/Y scale from two physical touches", () => {
  const width = 720;
  const height = 1560;
  const oldControl: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] = [
    { x: 80, y: 160 }, { x: 0, y: 160 },
    { x: 0, y: 0 }, { x: 80, y: 0 },
  ];
  const anchor = { x: 362.88, y: 788.186 };
  const expected = { x: 202.88, y: 568.186 };
  const actual = { x: 157.44, y: 472.444 };
  const learned = adjustedControlMachinePoints({
    width,
    height,
    controlMachinePoints: oldControl,
    anchor,
    expected,
    actual,
  });
  assert.ok(Math.abs(learned.scale.x - 0.778816) < 0.001);
  assert.ok(Math.abs(learned.scale.y - 0.69677) < 0.001);

  const calibration = {
    imagePoints: [
      { x: 0, y: 0 }, { x: width, y: 0 },
      { x: width, y: height }, { x: 0, y: height },
    ] as [
      { x: number; y: number }, { x: number; y: number },
      { x: number; y: number }, { x: number; y: number },
    ],
    machinePoints: learned.controlMachinePoints,
  };
  const oldCalibration = {
    imagePoints: calibration.imagePoints,
    machinePoints: oldControl,
  };
  const learnedAnchor = mapImagePointToMachine(calibration, anchor);
  const oldAnchor = mapImagePointToMachine(oldCalibration, anchor);
  const learnedActual = mapImagePointToMachine(calibration, actual);
  const oldExpected = mapImagePointToMachine(oldCalibration, expected);
  assert.ok(Math.hypot(
    learnedAnchor.x - oldAnchor.x,
    learnedAnchor.y - oldAnchor.y,
  ) < 0.01);
  assert.ok(Math.hypot(
    learnedActual.x - oldExpected.x,
    learnedActual.y - oldExpected.y,
  ) < 0.01);
});

test("fits a rotated full-screen affine map from noisy physical samples", () => {
  const width = 720;
  const height = 1280;
  const sampleAt = (x: number, y: number, noiseX = 0, noiseY = 0) => ({
    screen: { x, y },
    machine: {
      x: 70 - 58 * (x / width) - 2 * (y / height) + noiseX,
      y: 145 + 1.5 * (x / width) - 108 * (y / height) + noiseY,
    },
  });
  const learned = fitAffineTouchCalibration([
    sampleAt(120, 180, 0.03, -0.02),
    sampleAt(360, 180, -0.02, 0.01),
    sampleAt(600, 180, 0.01, 0.02),
    sampleAt(120, 1050, -0.01, -0.01),
    sampleAt(360, 1050, 0.02, 0),
    sampleAt(600, 1050, -0.03, 0.01),
  ], width, height);
  assert.ok(learned.rmseMm < 0.05);
  assert.ok(learned.maximumErrorMm < 0.06);
  const idealCorners = [
    { x: 70, y: 145 }, { x: 12, y: 146.5 },
    { x: 10, y: 38.5 }, { x: 68, y: 37 },
  ];
  learned.controlMachinePoints.forEach((point, index) => {
    assert.ok(Math.hypot(
      point.x - idealCorners[index].x,
      point.y - idealCorners[index].y,
    ) < 0.06);
  });
});

test("fits a projective screen map from redundant physical samples", () => {
  const width = 720;
  const height = 1560;
  const expected = {
    controlPoints: [],
    coefficients: [
      -57, 1.5, 70,
      -0.8, -103, 141,
      0.035, -0.025,
    ],
    rmse: 0,
    maximumError: 0,
  } as unknown as ReturnType<typeof fitProjectiveTouchCalibration>;
  const points = [
    [0.12, 0.15], [0.5, 0.15], [0.88, 0.15],
    [0.12, 0.5], [0.88, 0.5],
    [0.12, 0.78], [0.5, 0.78], [0.88, 0.78],
  ];
  const pairs = points.map(([u, v], index) => {
    const screen = { x: width * u, y: height * v };
    const machine = projectProjectiveCalibration(expected, screen, width, height);
    return {
      screen,
      machine: {
        x: machine.x + (index % 2 ? 0.01 : -0.01),
        y: machine.y + (index % 3 ? 0.015 : -0.015),
      },
    };
  });
  const fitted = fitProjectiveTouchCalibration(pairs, width, height);
  assert.ok(fitted.rmse < 0.03);
  assert.ok(fitted.maximumError < 0.04);
  const check = { x: width * 0.37, y: height * 0.63 };
  const actual = projectProjectiveCalibration(fitted, check, width, height);
  const ideal = projectProjectiveCalibration(expected, check, width, height);
  assert.ok(Math.hypot(actual.x - ideal.x, actual.y - ideal.y) < 0.05);
});

async function blankFrame() {
  return sharp({
    create: { width: 720, height: 1560, channels: 3, background: "white" },
  }).jpeg({ quality: 95 }).toBuffer();
}

async function frameWithDot(x: number, y: number) {
  return sharp({
    create: { width: 720, height: 1560, channels: 3, background: "white" },
  }).composite([{
    input: Buffer.from(
      `<svg width="720" height="1560"><circle cx="${x}" cy="${y}" r="6" fill="black"/></svg>`,
    ),
  }]).jpeg({ quality: 95 }).toBuffer();
}

async function frameWithBlueStroke(startX: number, endX: number, y: number) {
  return sharp({
    create: { width: 720, height: 1560, channels: 3, background: "white" },
  }).composite([{
    input: Buffer.from(
      `<svg width="720" height="1560"><line x1="${startX}" y1="${y}" ` +
      `x2="${endX}" y2="${y}" stroke="#078cff" stroke-width="7" ` +
      `stroke-linecap="round"/></svg>`,
    ),
  }]).jpeg({ quality: 95 }).toBuffer();
}

async function frameWithCalibrationMarker(x: number, y: number) {
  return sharp({
    create: { width: 720, height: 1560, channels: 3, background: "white" },
  }).composite([{
    input: Buffer.from(
      `<svg width="720" height="1560">` +
      `<circle cx="${x}" cy="${y}" r="33" fill="none" ` +
      `stroke="#dc2626" stroke-width="4"/>` +
      `<line x1="${x - 48}" y1="${y}" x2="${x + 48}" y2="${y}" ` +
      `stroke="#dc2626" stroke-width="2"/>` +
      `<line x1="${x}" y1="${y - 48}" x2="${x}" y2="${y + 48}" ` +
      `stroke="#dc2626" stroke-width="2"/>` +
      `</svg>`,
    ),
  }]).jpeg({ quality: 90 }).toBuffer();
}

async function frameWithCalibrationMarkerAndDistractor(x: number, y: number) {
  return sharp({
    create: { width: 720, height: 1560, channels: 3, background: "white" },
  }).composite([{
    input: Buffer.from(
      `<svg width="720" height="1560">` +
      `<circle cx="${x}" cy="${y}" r="33" fill="none" ` +
      `stroke="#dc2626" stroke-width="4"/>` +
      `<line x1="${x - 48}" y1="${y}" x2="${x + 48}" y2="${y}" ` +
      `stroke="#dc2626" stroke-width="2"/>` +
      `<line x1="${x}" y1="${y - 48}" x2="${x}" y2="${y + 48}" ` +
      `stroke="#dc2626" stroke-width="2"/>` +
      `<line x1="90" y1="300" x2="115" y2="325" ` +
      `stroke="#dc2626" stroke-width="2"/>` +
      `</svg>`,
    ),
  }]).jpeg({ quality: 90 }).toBuffer();
}

async function frameWithTwoCalibrationMarkers() {
  return sharp({
    create: { width: 720, height: 1560, channels: 3, background: "white" },
  }).composite([{
    input: Buffer.from(
      `<svg width="720" height="1560">` +
      `<g fill="none" stroke="#dc2626">` +
      `<circle cx="180" cy="360" r="33" stroke-width="4"/>` +
      `<path d="M132 360h96M180 312v96" stroke-width="2"/>` +
      `<circle cx="540" cy="980" r="33" stroke-width="4"/>` +
      `<path d="M492 980h96M540 932v96" stroke-width="2"/>` +
      `</g></svg>`,
    ),
  }]).jpeg({ quality: 90 }).toBuffer();
}

test("detects the center of a newly drawn compact touch mark", async () => {
  const detected = await detectNewTouch(await blankFrame(), await frameWithDot(245, 812));
  assert.ok(detected);
  assert.ok(Math.abs(detected.point.x - 245) < 1);
  assert.ok(Math.abs(detected.point.y - 812) < 1);
  assert.ok(detected.pixelCount > 20);
});

test("returns null when the wired screen did not change", async () => {
  const frame = await blankFrame();
  assert.equal(await detectNewTouch(frame, frame), null);
});

test("detects the blue micro-stroke used by iOS Notes recovery", async () => {
  const detected = await detectNewTouch(
    await blankFrame(),
    await frameWithBlueStroke(500, 488, 900),
  );
  assert.ok(detected);
  assert.ok(Math.abs(detected.point.x - 494) < 2);
  assert.ok(Math.abs(detected.point.y - 900) < 1);
});

test("detects the scaled red marker from the touch-calibration page", async () => {
  const detected = await detectNewTouch(
    await blankFrame(),
    await frameWithCalibrationMarker(410, 780),
  );
  assert.ok(detected);
  assert.ok(Math.abs(detected.point.x - 410) < 2);
  assert.ok(Math.abs(detected.point.y - 780) < 2);
  assert.ok(detected.bounds.right - detected.bounds.left > 80);
});

test("detects a red calibration marker in one physical-camera frame", async () => {
  const detected = await detectCalibrationMarker(
    await frameWithCalibrationMarker(410, 780),
  );
  assert.ok(detected);
  assert.ok(Math.abs(detected.point.x - 410) < 2);
  assert.ok(Math.abs(detected.point.y - 780) < 2);
});

test("ignores a disconnected red camera artifact near the calibration marker", async () => {
  const detected = await detectCalibrationMarker(
    await frameWithCalibrationMarkerAndDistractor(410, 780),
  );
  assert.ok(detected);
  assert.ok(Math.abs(detected.point.x - 410) < 2);
  assert.ok(Math.abs(detected.point.y - 780) < 2);
});

test("selects the expected physical marker when an older crosshair remains visible", async () => {
  const frame = await frameWithTwoCalibrationMarkers();
  const top = await detectCalibrationMarker(frame, { x: 190, y: 350 });
  const bottom = await detectCalibrationMarker(frame, { x: 530, y: 990 });
  assert.ok(top);
  assert.ok(bottom);
  assert.ok(Math.abs(top.point.x - 180) < 2);
  assert.ok(Math.abs(top.point.y - 360) < 2);
  assert.ok(Math.abs(bottom.point.x - 540) < 2);
  assert.ok(Math.abs(bottom.point.y - 980) < 2);
});

test("recognizes legacy 16:9 iPhones with a physical Home button", () => {
  assert.deepEqual(legacyIphoneHomeButtonScreenPoint({
    screenWidth: 375,
    screenHeight: 667,
  }, 720, 1560), { x: 360, y: 1669.2 });
  assert.equal(legacyIphoneHomeButtonScreenPoint({
    screenWidth: 428,
    screenHeight: 926,
  }, 720, 1560), null);
});

test("chooses a separated validation point inside the drawing canvas", () => {
  assert.deepEqual(validationPoint({ x: 500, y: 900 }, 720, 1560), {
    x: 340,
    y: 680,
  });
  assert.deepEqual(validationPoint({ x: 650, y: 1450 }, 720, 1560), {
    x: 490,
    y: 1230,
  });
});

test("keeps XY validation moving away from both stuck home inputs", () => {
  assert.deepEqual(validateReferenceGeometry({
    anchorMachine: { x: 25, y: 40 },
    validationMachine: { x: 41, y: 62 },
    anchorController: { x: 25, y: 40 },
    faultPins: "XY",
    maximumControllerX: 78.5,
    maximumControllerY: 168,
  }), {
    coordinateOffset: { x: 0, y: 0 },
    validationDelta: { x: 16, y: 22 },
    validationController: { x: 41, y: 62 },
  });
});

test("rejects a large fixture offset or motion toward a stuck input", () => {
  assert.throws(() => validateReferenceGeometry({
    anchorMachine: { x: 25, y: 40 },
    validationMachine: { x: 41, y: 62 },
    anchorController: { x: 41, y: 55.1 },
    faultPins: "XY",
    maximumControllerX: 78.5,
    maximumControllerY: 168,
  }), /坐标方向与偏差检查/);
  assert.throws(() => validateReferenceGeometry({
    anchorMachine: { x: 25, y: 40 },
    validationMachine: { x: 20, y: 35 },
    anchorController: { x: 25, y: 40 },
    faultPins: "XY",
    maximumControllerX: 78.5,
    maximumControllerY: 168,
  }), /坐标方向与偏差检查/);
});

test("allows an explicitly widened manual-reference offset for a fixed demo fixture", () => {
  assert.deepEqual(validateReferenceGeometry({
    anchorMachine: { x: 52.21, y: 113.14 },
    validationMachine: { x: 62.81, y: 126.44 },
    anchorController: { x: 40, y: 80 },
    faultPins: "X",
    maximumControllerX: 78.5,
    maximumControllerY: 168,
    maximumOffsetMm: 40,
    controlMachinePoints: [
      { x: 70.667, y: 141.273 },
      { x: 12.619, y: 140.889 },
      { x: 13.653, y: 36.55 },
      { x: 71.701, y: 36.934 },
    ],
  }), {
    coordinateOffset: { x: -12.21, y: -33.14 },
    validationDelta: { x: 10.600000000000001, y: 13.299999999999997 },
    validationController: { x: 50.6, y: 93.3 },
  });

  assert.throws(() => validateReferenceGeometry({
    anchorMachine: { x: 52.21, y: 113.14 },
    validationMachine: { x: 62.81, y: 126.44 },
    anchorController: { x: 40, y: 80 },
    faultPins: "X",
    maximumControllerX: 78.5,
    maximumControllerY: 168,
  }), /limit=15\.0 mm/);

  assert.throws(() => validateReferenceGeometry({
    anchorMachine: { x: 52.21, y: 113.14 },
    validationMachine: { x: 62.81, y: 126.44 },
    anchorController: { x: 40, y: 80 },
    faultPins: "X",
    maximumControllerX: 78.5,
    maximumControllerY: 168,
    maximumOffsetMm: 40,
    controlMachinePoints: [{ x: 5, y: 40 }],
  }), /坐标方向与偏差检查/);
});

test("translates an existing screen transform after open-loop position drift", () => {
  const original = [
    { x: 70, y: 140 },
    { x: 10, y: 140 },
    { x: 10, y: 40 },
    { x: 70, y: 40 },
  ] as const;
  const shifted = translatedControlMachinePoints({
    width: 720,
    height: 1280,
    controlMachinePoints: [...original],
    screenDelta: { x: 0, y: 40 },
  });
  const corrected = screenPointToMachine({
    width: 720,
    height: 1280,
    controlMachinePoints: shifted,
    point: { x: 360, y: 512 },
  });
  const oldAtCompensatedPoint = screenPointToMachine({
    width: 720,
    height: 1280,
    controlMachinePoints: [...original],
    point: { x: 360, y: 552 },
  });
  assert.ok(Math.abs(corrected.x - oldAtCompensatedPoint.x) < 1e-9);
  assert.ok(Math.abs(corrected.y - oldAtCompensatedPoint.y) < 1e-9);
});
