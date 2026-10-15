import assert from "node:assert/strict";
import test from "node:test";
import type { ScreenHandCalibrationProfile } from "../agent/calibration-profile";
import type { VisionRegistrationResult } from "../agent/vision-register";
import {
  autoSetupReferenceIntegrityIssue,
  buildAutomaticVisionBaseline,
  buildRegisteredAutoSetup,
  buildVisionBaselineProfile,
  calibrationFingerprint,
  type AutoSetupReference,
} from "./core";

const profile: ScreenHandCalibrationProfile = {
  id: "fixture-v1",
  deviceId: "black-arm-01",
  verified: true,
  verifiedAt: "2026-08-01T00:00:00.000Z",
  frame: { width: 720, height: 1280 },
  screen: { width: 720, height: 1560 },
  imagePoints: [
    { x: 100, y: 80 },
    { x: 620, y: 80 },
    { x: 620, y: 1200 },
    { x: 100, y: 1200 },
  ],
  machinePoints: [
    { x: 70, y: 146 },
    { x: 14, y: 146 },
    { x: 14, y: 14 },
    { x: 70, y: 14 },
  ],
  safeMachineBounds: {
    minimumX: 15,
    maximumX: 69,
    minimumY: 15,
    maximumY: 145,
  },
  navigation: {
    home: {
      strategy: "physical-button",
      machinePoint: { x: 42, y: 140 },
      durationMs: 120,
      source: "legacy-ios-16x9-geometry-v1",
    },
  },
  tap: { hoverZ: 1, touchZ: 10, zStep: 0.5, feed: 3000, dwellMs: 40 },
};
const calibrationSha256 = calibrationFingerprint(profile);

const reference: AutoSetupReference = {
  version: 2,
  deviceId: profile.deviceId,
  calibrationId: profile.id,
  capturedAt: "2026-08-01T00:00:00.000Z",
  baselineCalibrationSha256: calibrationSha256,
  authorizedCalibrationSha256: calibrationSha256,
  frame: { width: 720, height: 1280, sequence: 12, sha256: "a".repeat(64) },
  calibration: profile,
};

function registration(matrix: VisionRegistrationResult["referenceToCurrentVision"]): VisionRegistrationResult {
  return {
    ok: true,
    confidence: 0.98,
    elapsedMs: 48,
    referenceWidth: 720,
    referenceHeight: 1280,
    currentWidth: 720,
    currentHeight: 1280,
    referenceToCurrentVision: matrix,
  };
}

const movementBounds = {
  minimumX: 5.8,
  maximumX: 78.5,
  minimumY: 10.5,
  maximumY: 168,
};

test("reuses an unchanged camera reference without moving calibration", () => {
  const result = buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    movementBounds,
    now: new Date("2026-08-28T00:00:00.000Z"),
  });
  assert.deepEqual(result.imagePoints, profile.imagePoints);
  assert.deepEqual(result.machinePoints, profile.machinePoints);
  assert.equal(result.meanDriftPx, 0);
  assert.equal(result.profile.verifiedAt, "2026-08-28T00:00:00.000Z");
  assert.deepEqual(result.profile.navigation, profile.navigation);
});

test("binds a trusted frame to its exact baseline calibration", () => {
  assert.equal(autoSetupReferenceIntegrityIssue({
    reference,
    expectedDeviceId: profile.deviceId,
    imageSha256: reference.frame.sha256,
  }), null);
  assert.match(autoSetupReferenceIntegrityIssue({
    reference: {
      ...reference,
      calibration: {
        ...reference.calibration,
        imagePoints: [
          { x: 101, y: 80 },
          ...reference.calibration.imagePoints.slice(1),
        ] as ScreenHandCalibrationProfile["imagePoints"],
      },
    },
    expectedDeviceId: profile.deviceId,
    imageSha256: reference.frame.sha256,
  }) ?? "", /baseline calibration hash/i);
});

test("adopts reviewed vision corners through the verified camera-to-machine map", () => {
  const updated = buildVisionBaselineProfile({
    currentProfile: {
      ...profile,
      placementCalibration: {
        method: "joint-camera-touch-v1",
        verifiedAt: "2026-08-01T00:00:00.000Z",
        cameraRmsePx: 2,
        cameraMaximumErrorPx: 4,
      },
    },
    imagePoints: [
      { x: 71.1234, y: 12.2222 },
      { x: 624.8888, y: 12.1111 },
      { x: 640.5555, y: 1211.4444 },
      { x: 87.7777, y: 1211.3333 },
    ],
    frame: { width: 720, height: 1280 },
    now: new Date("2026-08-28T01:02:03.000Z"),
  });
  assert.deepEqual(updated.imagePoints[0], { x: 71.123, y: 12.222 });
  assert.notDeepEqual(updated.machinePoints, profile.machinePoints);
  assert.ok(updated.machinePoints.every((point) =>
    Number.isFinite(point.x) && Number.isFinite(point.y)
  ));
  assert.deepEqual(updated.safeMachineBounds, profile.safeMachineBounds);
  assert.equal(updated.verifiedAt, "2026-08-28T01:02:03.000Z");
  assert.equal(updated.placementCalibration, undefined);
});

test("automatically adopts only a stable, unambiguous three-frame screen", () => {
  const points = [
    { x: 106, y: 76 },
    { x: 626, y: 76 },
    { x: 626, y: 1196 },
    { x: 106, y: 1196 },
  ] as const;
  const result = buildAutomaticVisionBaseline({
    currentProfile: profile,
    observations: [0, 1, 2].map((index) => ({
      sequence: 40 + index,
      frame: { width: 720, height: 1280 },
      points: points.map((point) => ({
        x: point.x + (index - 1) * 0.4,
        y: point.y + (index - 1) * 0.25,
      })) as ScreenHandCalibrationProfile["imagePoints"],
      confidence: 0.97,
      score: 0.94,
      runnerUpScore: 0.72,
      elapsedMs: 52 + index,
    })),
    movementBounds,
  });
  assert.deepEqual(result.frameSequences, [40, 41, 42]);
  assert.deepEqual(result.imagePoints, points);
  assert.ok(result.maximumDeviationPx < 1);
  assert.notDeepEqual(result.profile.machinePoints, profile.machinePoints);
  assert.ok(result.profile.navigation);
  assert.notDeepEqual(
    result.profile.navigation?.home.machinePoint,
    profile.navigation?.home.machinePoint,
  );
});

test("automatic baseline fails closed on ambiguity or moving corners", () => {
  const observation = (sequence: number, shift: number, runnerUpScore = 0.4) => ({
    sequence,
    frame: { width: 720, height: 1280 },
    points: profile.imagePoints.map((point) => ({
      x: point.x + shift,
      y: point.y,
    })) as ScreenHandCalibrationProfile["imagePoints"],
    confidence: 0.98,
    score: 0.9,
    runnerUpScore,
    elapsedMs: 40,
  });
  assert.throws(() => buildAutomaticVisionBaseline({
    currentProfile: profile,
    observations: [
      observation(1, 0, 0.85),
      observation(2, 0, 0.85),
      observation(3, 0, 0.85),
    ],
    movementBounds,
  }), /ambiguous/);
  assert.throws(() => buildAutomaticVisionBaseline({
    currentProfile: profile,
    observations: [observation(1, -8), observation(2, 0), observation(3, 8)],
    movementBounds,
  }), /moved during automatic setup/);
  assert.throws(() => buildAutomaticVisionBaseline({
    currentProfile: profile,
    observations: [observation(3, 0), observation(2, 0), observation(1, 0)],
    movementBounds,
  }), /ordered camera frames/);
});

test("translates camera and machine corners after the phone is reseated", () => {
  const result = buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0, 12, 0, 1, -8, 0, 0, 1]),
    movementBounds,
  });
  assert.deepEqual(result.imagePoints[0], { x: 112, y: 88 });
  assert.ok(Math.abs(result.machinePoints[0].x - 68.708) < 0.002);
  assert.ok(Math.abs(result.machinePoints[0].y - 145.057) < 0.002);
  assert.ok(result.maximumDriftPx > 14 && result.maximumDriftPx < 15);
  assert.notDeepEqual(
    result.profile.navigation?.home.machinePoint,
    profile.navigation?.home.machinePoint,
  );
  const home = result.profile.navigation?.home.machinePoint;
  assert.ok(home);
  assert.ok(home.x >= result.profile.safeMachineBounds.minimumX);
  assert.ok(home.x <= result.profile.safeMachineBounds.maximumX);
  assert.ok(home.y >= result.profile.safeMachineBounds.minimumY);
  assert.ok(home.y <= result.profile.safeMachineBounds.maximumY);
});

test("keeps full screen corners outside normal touch bounds when calibration travel is safe", () => {
  const overhangingProfile: ScreenHandCalibrationProfile = {
    ...profile,
    machinePoints: [
      { x: 80, y: 160 },
      { x: 4, y: 160 },
      { x: 4, y: 6 },
      { x: 80, y: 6 },
    ],
    safeMachineBounds: movementBounds,
  };
  const hash = calibrationFingerprint(overhangingProfile);
  const overhangingReference: AutoSetupReference = {
    ...reference,
    baselineCalibrationSha256: hash,
    authorizedCalibrationSha256: hash,
    calibration: overhangingProfile,
  };
  const result = buildRegisteredAutoSetup({
    reference: overhangingReference,
    currentProfile: overhangingProfile,
    registration: registration([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    movementBounds,
    calibrationMovementBounds: {
      minimumX: 1,
      maximumX: 82,
      minimumY: 1,
      maximumY: 170,
    },
  });
  assert.deepEqual(result.machinePoints, overhangingProfile.machinePoints);
  assert.deepEqual(result.profile.safeMachineBounds, {
    ...movementBounds,
    maximumY: 159.5,
  });
});

test("fails closed on low-confidence visual registration", () => {
  assert.throws(() => buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: { ...registration([1, 0, 0, 0, 1, 0, 0, 0, 1]), confidence: 0.4 },
    movementBounds,
  }), /confidence/);
});

test("fails closed when the registered phone leaves the camera frame", () => {
  assert.throws(() => buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0, 260, 0, 1, 0, 0, 0, 1]),
    movementBounds,
  }), /moved too far|outside the camera frame/);
});

test("fails closed when registration shears the screen instead of moving it", () => {
  assert.throws(() => buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0.15, -100, 0, 1, 0, 0, 0, 1]),
    movementBounds,
  }), /distorted/);
});
