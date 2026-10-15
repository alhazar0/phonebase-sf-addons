import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  calibratedMachinePoint,
  calibratedReachableScreenPoint,
  calibratedScreenPoint,
  calibrationReadiness,
  parseScreenHandCalibrationProfile,
  retainedKeyboardCalibration,
} from "./calibration-profile";

function profileInput() {
  return {
    id: "black-arm-test-profile-v1",
    deviceId: "black-arm-test",
    verified: true,
    verifiedAt: "2026-07-29T13:49:00+08:00",
    frame: { width: 720, height: 1280 },
    screen: { width: 720, height: 1280 },
    imagePoints: [
      { x: 0, y: 0 },
      { x: 720, y: 0 },
      { x: 720, y: 1280 },
      { x: 0, y: 1280 },
    ],
    machinePoints: [
      { x: 6, y: 11 },
      { x: 78, y: 11 },
      { x: 78, y: 168 },
      { x: 6, y: 168 },
    ],
    safeMachineBounds: {
      minimumX: 10,
      maximumX: 74,
      minimumY: 15,
      maximumY: 164,
    },
    tap: {
      hoverZ: 1,
      touchZ: 10,
      zStep: 0.5,
      feed: 3000,
      dwellMs: 80,
    },
  };
}

test("accepts a verified profile that matches the Android hard limits", () => {
  const profile = parseScreenHandCalibrationProfile(profileInput());
  assert.equal(profile.tap.touchZ, 10);
  assert.deepEqual(profile.screen, { width: 720, height: 1280 });
  assert.equal(
    calibrationReadiness(profile, {
      deviceId: profile.deviceId,
      frame: profile.frame,
    }).ready,
    true,
  );
});

test("accepts only independently verified joint camera placement metadata", () => {
  const value = {
    ...profileInput(),
    placementCalibration: {
      method: "joint-camera-touch-v1",
      verifiedAt: "2026-08-09T14:30:00Z",
      cameraRmsePx: 3.2,
      cameraMaximumErrorPx: 5.1,
    },
  };
  const profile = parseScreenHandCalibrationProfile(value);
  assert.equal(profile.placementCalibration?.cameraMaximumErrorPx, 5.1);
  assert.throws(() => parseScreenHandCalibrationProfile({
    ...value,
    placementCalibration: {
      ...value.placementCalibration,
      cameraMaximumErrorPx: 20,
    },
  }), /验收误差/);
});

test("accepts a bounded physical iPhone Home button target", () => {
  const profile = parseScreenHandCalibrationProfile({
    ...profileInput(),
    navigation: {
      home: {
        strategy: "physical-button",
        machinePoint: { x: 42, y: 158 },
        durationMs: 120,
        source: "legacy-ios-16x9-geometry-v1",
      },
    },
  });
  assert.deepEqual(profile.navigation?.home.machinePoint, { x: 42, y: 158 });
  assert.throws(() => parseScreenHandCalibrationProfile({
    ...profileInput(),
    navigation: {
      home: {
        strategy: "physical-button",
        machinePoint: { x: 42, y: 170 },
        durationMs: 120,
        source: "legacy-ios-16x9-geometry-v1",
      },
    },
  }), /Home 键坐标/);
});

test("accepts only a bounded Face ID bottom-up Home gesture", () => {
  const profile = parseScreenHandCalibrationProfile({
    ...profileInput(),
    navigation: {
      home: {
        strategy: "screen-swipe",
        startPoint: { x: 360, y: 1216 },
        endPoint: { x: 360, y: 870 },
        durationMs: 320,
        source: "ios-face-id-home-v1",
      },
    },
  });
  assert.equal(profile.navigation?.home.strategy, "screen-swipe");
  assert.deepEqual(
    profile.navigation?.home.strategy === "screen-swipe"
      ? profile.navigation.home.startPoint
      : null,
    { x: 360, y: 1216 },
  );
  assert.throws(() => parseScreenHandCalibrationProfile({
    ...profileInput(),
    navigation: {
      home: {
        strategy: "screen-swipe",
        startPoint: { x: 360, y: 700 },
        endPoint: { x: 360, y: 870 },
        durationMs: 320,
        source: "ios-face-id-home-v1",
      },
    },
  }), /底部向上滑动/);
});

test("accepts only strict per-device physical keyboard points", () => {
  const profile = parseScreenHandCalibrationProfile({
    ...profileInput(),
    keyboard: {
      strategy: "screen-point-overrides-v1",
      layout: "ios-latin-qwerty",
      verifiedAt: "2026-08-27T13:55:00+08:00",
      strict: true,
      points: { a: { x: 10, y: 1100 } },
    },
  });
  assert.deepEqual(profile.keyboard?.points.a, { x: 10, y: 1100 });
  assert.throws(() => parseScreenHandCalibrationProfile({
    ...profileInput(),
    keyboard: {
      strategy: "screen-point-overrides-v1",
      layout: "ios-latin-qwerty",
      verifiedAt: "2026-08-27T13:55:00+08:00",
      strict: false,
      points: { a: { x: 10, y: 1100 } },
    },
  }), /strict/);
});

test("retains a verified keyboard map only for the identical physical profile", () => {
  const profile = parseScreenHandCalibrationProfile({
    ...profileInput(),
    keyboard: {
      strategy: "screen-point-overrides-v1",
      layout: "ios-latin-qwerty",
      verifiedAt: "2026-08-31T17:27:00.000Z",
      strict: true,
      points: { a: { x: 10, y: 1100 } },
    },
  });
  const identity = {
    deviceId: profile.deviceId,
    profileId: profile.id,
    screen: profile.screen,
  };

  assert.equal(retainedKeyboardCalibration(profile, identity), profile.keyboard);
  assert.equal(retainedKeyboardCalibration(profile, {
    ...identity,
    profileId: "replacement-hardware-profile",
  }), undefined);
  assert.equal(retainedKeyboardCalibration(profile, {
    ...identity,
    screen: { width: profile.screen.width, height: profile.screen.height + 1 },
  }), undefined);
});

test("keeps unverified or mismatched profiles gated", () => {
  assert.throws(
    () => parseScreenHandCalibrationProfile({
      ...profileInput(),
      verified: false,
    }),
    /人工验证/,
  );

  const profile = parseScreenHandCalibrationProfile(profileInput());
  assert.equal(
    calibrationReadiness(profile, {
      deviceId: "another-device",
      frame: profile.frame,
    }).ready,
    false,
  );
});

test("maps a frame point and rejects a point outside the verified inset", () => {
  const profile = parseScreenHandCalibrationProfile(profileInput());
  assert.deepEqual(
    calibratedMachinePoint(profile, { x: 360, y: 640 }),
    { x: 42, y: 89.5 },
  );
  assert.throws(
    () => calibratedMachinePoint(profile, { x: 0, y: 0 }),
    /安全范围/,
  );
});

test("maps the rectified operator viewport into the same machine space", () => {
  const profile = parseScreenHandCalibrationProfile(profileInput());
  assert.deepEqual(
    calibratedScreenPoint(profile, { x: 360, y: 640 }),
    { x: 42, y: 89.5 },
  );
  assert.throws(
    () => calibratedScreenPoint(profile, { x: 0, y: 0 }),
    /安全范围/,
  );
});

test("snaps only a small unreachable edge inset into the verified area", () => {
  const profile = parseScreenHandCalibrationProfile(profileInput());
  const mapped = calibratedReachableScreenPoint(profile, { x: 30, y: 640 });
  assert.equal(mapped.snapped, true);
  assert.deepEqual(mapped.requestedScreenPoint, { x: 30, y: 640 });
  assert.ok(mapped.screenPoint.x > 42 && mapped.screenPoint.x < 44);
  assert.ok(mapped.snapDistancePx > 12 && mapped.snapDistancePx < 14);
  assert.ok(mapped.machinePoint.x >= profile.safeMachineBounds.minimumX);

  const centre = calibratedReachableScreenPoint(profile, { x: 360, y: 640 });
  assert.equal(centre.snapped, false);
  assert.equal(centre.snapDistancePx, 0);
});

test("edge snapping fails closed for distant or invalid coordinates", () => {
  const profile = parseScreenHandCalibrationProfile(profileInput());
  assert.throws(
    () => calibratedReachableScreenPoint(profile, { x: 0, y: 0 }),
    /安全吸附上限/,
  );
  assert.throws(
    () => calibratedReachableScreenPoint(profile, { x: Number.NaN, y: 640 }),
    /有限数字/,
  );
});

test("accepts the production black arm profile", () => {
  const blackProfile = parseScreenHandCalibrationProfile(JSON.parse(
    readFileSync("build/black-arm-calibration.json", "utf8"),
  ));
  assert.equal(blackProfile.deviceId, "black-arm-01");
  assert.equal(blackProfile.tap.hoverZ, 1);
  assert.equal(blackProfile.tap.touchZ, 10);
  const center = calibratedScreenPoint(blackProfile, { x: 360, y: 780 });
  assert.deepEqual(center, { x: 43.61, y: 82.886 });
  // Camera pixels and rectified full-screen pixels now share the same physical
  // touch calibration. Safari's non-DOM toolbar remains reachable, while the
  // hard mechanical boundary still rejects the extreme bottom edge.
  assert.deepEqual(
    calibratedScreenPoint(blackProfile, { x: 352.285, y: 560.993 }),
    { x: 44.404, y: 104.022 },
  );
  assert.deepEqual(
    calibratedScreenPoint(blackProfile, { x: 360, y: 1420 }),
    { x: 43.502, y: 19.626 },
  );
  assert.throws(
    () => calibratedScreenPoint(blackProfile, { x: 360, y: 1520 }),
    /安全范围/,
  );
});
