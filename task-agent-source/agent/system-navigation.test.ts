import assert from "node:assert/strict";
import test from "node:test";
import { parseScreenHandCalibrationProfile } from "./calibration-profile";
import {
  phoneNavigationAvailability,
  planKeyboardNext,
  planPhoneNavigation,
  PhoneNavigationUnavailableError,
} from "./system-navigation";

function gestureProfile(width: number, height: number) {
  return parseScreenHandCalibrationProfile({
    id: `gesture-${width}x${height}`,
    deviceId: `phone-${width}x${height}`,
    verified: true,
    verifiedAt: "2026-08-29T00:00:00Z",
    frame: { width: 720, height: 1280 },
    screen: { width, height },
    imagePoints: [
      { x: 0, y: 0 },
      { x: 720, y: 0 },
      { x: 720, y: 1280 },
      { x: 0, y: 1280 },
    ],
    machinePoints: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 200 },
      { x: 0, y: 200 },
    ],
    safeMachineBounds: {
      minimumX: 1,
      maximumX: 99,
      minimumY: 1,
      maximumY: 199,
    },
    tap: {
      hoverZ: 1,
      touchZ: 10,
      zStep: 0.5,
      feed: 3000,
      dwellMs: 80,
    },
  });
}

for (const [width, height] of [[720, 1280], [1080, 2400]] as const) {
  test(`plans scale-independent edge navigation for ${width}x${height}`, () => {
    const profile = gestureProfile(width, height);
    const back = planPhoneNavigation(profile, "back");
    assert.equal(back.action, "swipe");
    if (back.action !== "swipe") return;
    assert.equal(back.strategy, "left-edge-back-gesture");
    assert.ok(back.start.screenPoint.x / width <= 0.025);
    assert.ok(back.end.screenPoint.x / width >= 0.4);

    const home = planPhoneNavigation(profile, "home");
    assert.equal(home.action, "swipe");
    if (home.action !== "swipe") return;
    assert.equal(home.strategy, "bottom-edge-home-gesture");
    assert.ok(home.start.screenPoint.y / height >= 0.975);
    assert.ok(home.end.screenPoint.y / height <= 0.221);

    const enter = planPhoneNavigation(profile, "enter");
    assert.equal(enter.action, "tap");
    assert.equal(phoneNavigationAvailability(profile).home.available, true);
  });
}

test("prefers a calibrated physical Home button when one exists", () => {
  const base = gestureProfile(720, 1280);
  const profile = parseScreenHandCalibrationProfile({
    ...base,
    navigation: {
      home: {
        strategy: "physical-button",
        machinePoint: { x: 50, y: 190 },
        durationMs: 120,
        source: "legacy-ios-16x9-geometry-v1",
      },
    },
  });
  const home = planPhoneNavigation(profile, "home");
  assert.equal(home.action, "tap");
  assert.equal(home.strategy, "physical-home-button");
});

test("adapts a saved Face ID profile to current screen-relative Home geometry", () => {
  const base = gestureProfile(720, 1_560);
  const profile = parseScreenHandCalibrationProfile({
    ...base,
    navigation: {
      home: {
        strategy: "screen-swipe",
        startPoint: { x: 360, y: 1_450 },
        endPoint: { x: 360, y: 1_100 },
        durationMs: 320,
        source: "ios-face-id-home-v1",
      },
    },
  });
  const home = planPhoneNavigation(profile, "home");
  assert.equal(home.action, "swipe");
  if (home.action !== "swipe") return;
  assert.equal(home.strategy, "bottom-edge-home-gesture");
  assert.ok(home.start.screenPoint.y / profile.screen.height >= 0.975);
  assert.ok(home.end.screenPoint.y / profile.screen.height <= 0.221);
  assert.notDeepEqual(home.start.screenPoint, profile.navigation?.home.strategy === "screen-swipe"
    ? profile.navigation.home.startPoint
    : null);
});

test("fails closed when the robot cannot enter a system edge activation band", () => {
  const base = gestureProfile(720, 1280);
  const profile = parseScreenHandCalibrationProfile({
    ...base,
    safeMachineBounds: {
      minimumX: 10,
      maximumX: 90,
      minimumY: 10,
      maximumY: 190,
    },
  });
  assert.throws(
    () => planPhoneNavigation(profile, "back"),
    PhoneNavigationUnavailableError,
  );
  assert.throws(
    () => planPhoneNavigation(profile, "home"),
    PhoneNavigationUnavailableError,
  );
  assert.equal(phoneNavigationAvailability(profile).back.available, false);
});

test("reports the minimum placement correction when Home is outside reach", () => {
  const base = gestureProfile(720, 1280);
  const profile = parseScreenHandCalibrationProfile({
    ...base,
    safeMachineBounds: {
      minimumX: 1,
      maximumX: 99,
      minimumY: 1,
      maximumY: 190,
    },
  });
  const availability = phoneNavigationAvailability(profile).home;
  assert.equal(availability.available, false);
  if (availability.available) return;
  assert.equal(availability.requiredPlacement?.direction, "toward-screen-top");
  assert.ok((availability.requiredPlacement?.minimumMm ?? 0) > 4);
});

test("uses only the calibration travel for an otherwise unreachable Home edge", () => {
  const base = gestureProfile(720, 1280);
  const profile = parseScreenHandCalibrationProfile({
    ...base,
    safeMachineBounds: {
      minimumX: 1,
      maximumX: 99,
      minimumY: 1,
      maximumY: 190,
    },
  });
  const edgeMachineBounds = {
    minimumX: 0.2,
    maximumX: 99.8,
    minimumY: 0.2,
    maximumY: 199.5,
  };
  const home = planPhoneNavigation(profile, "home", { edgeMachineBounds });
  assert.equal(home.action, "system_edge_swipe");
  if (home.action !== "system_edge_swipe") return;
  assert.equal(home.durationMs, 250);
  assert.equal(home.boundary, "maximumY");
  assert.ok(home.start.machinePoint.y > profile.safeMachineBounds.maximumY);
  assert.ok(home.start.machinePoint.y < edgeMachineBounds.maximumY);
  assert.ok(home.end.machinePoint.y <= profile.safeMachineBounds.maximumY);
  assert.equal(
    phoneNavigationAvailability(profile, { edgeMachineBounds }).home.available,
    true,
  );
});

test("plans the keyboard language key only through bounded calibration travel", () => {
  const profile = gestureProfile(720, 1_560);
  const plan = planKeyboardNext(profile, {
    minimumX: 0.2,
    maximumX: 99.8,
    minimumY: 0.2,
    maximumY: 205,
  });
  assert.equal(plan.action, "system_edge_tap");
  assert.equal(plan.strategy, "keyboard-language-key");
  assert.ok(
    plan.target.machinePoint.y < profile.safeMachineBounds.minimumY ||
      plan.target.machinePoint.y > profile.safeMachineBounds.maximumY,
  );
});
