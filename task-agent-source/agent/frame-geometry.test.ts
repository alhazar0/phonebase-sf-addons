import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseScreenHandCalibrationProfile } from "./calibration-profile";
import {
  frameGeometryFor,
  framePointToScreenPoint,
} from "./frame-geometry";

const profile = parseScreenHandCalibrationProfile(JSON.parse(
  readFileSync("build/black-arm-calibration.json", "utf8"),
));

test("rectifies the physical camera with its measured screen corners", () => {
  const geometry = frameGeometryFor({
    dataUrl: "data:image/jpeg;base64,AA==",
    width: profile.frame.width,
    height: profile.frame.height,
    capturedAt: Date.now(),
    source: "black-arm-built-in-uvc",
    deviceId: profile.deviceId,
    role: "verification",
  }, profile);

  assert.equal(geometry.rectified, true);
  assert.deepEqual(geometry.imagePoints, profile.imagePoints);
  assert.equal(geometry.width, profile.screen.width);
  assert.equal(geometry.height, profile.screen.height);
});

test("never applies physical-camera perspective to wired iPhone video", () => {
  const geometry = frameGeometryFor({
    dataUrl: "data:image/jpeg;base64,AA==",
    width: 720,
    height: 1280,
    capturedAt: Date.now(),
    source: "iphone-wired-usb-video",
    deviceId: profile.deviceId,
    role: "control",
  }, profile);

  assert.equal(geometry.rectified, false);
  assert.equal(geometry.imagePoints, null);
  assert.equal(geometry.calibrationId, profile.id);
  assert.equal(geometry.width, profile.screen.width);
  assert.equal(geometry.height, profile.screen.height);
  assert.equal(geometry.rawWidth, 720);
  assert.equal(geometry.rawHeight, 1280);
});

test("does not reuse another device's screen geometry", () => {
  const geometry = frameGeometryFor({
    dataUrl: "data:image/jpeg;base64,AA==",
    width: 720,
    height: 1280,
    capturedAt: Date.now(),
    source: "iphone-wired-usb-video",
    deviceId: "another-device",
    role: "control",
  }, profile);

  assert.equal(geometry.calibrationId, null);
  assert.deepEqual(
    { width: geometry.width, height: geometry.height },
    { width: 720, height: 1280 },
  );
});

test("maps raw physical-camera points into calibrated screen coordinates", () => {
  const frame = {
    dataUrl: "data:image/jpeg;base64,AA==",
    width: profile.frame.width,
    height: profile.frame.height,
    capturedAt: Date.now(),
    source: "black-arm-built-in-uvc",
    deviceId: profile.deviceId,
    role: "verification" as const,
  };
  const expected = [
    { x: 0, y: 0 },
    { x: profile.screen.width, y: 0 },
    { x: profile.screen.width, y: profile.screen.height },
    { x: 0, y: profile.screen.height },
  ];

  profile.imagePoints.forEach((point, index) => {
    const mapped = framePointToScreenPoint(frame, profile, point, profile.frame);
    assert.ok(Math.abs(mapped.x - expected[index].x) < 0.001);
    assert.ok(Math.abs(mapped.y - expected[index].y) < 0.001);
  });
});

test("scales raw wired-video points into the canonical screen viewport", () => {
  const mapped = framePointToScreenPoint({
    dataUrl: "data:image/jpeg;base64,AA==",
    width: 720,
    height: 1280,
    capturedAt: Date.now(),
    source: "iphone-wired-usb-video",
    deviceId: profile.deviceId,
    role: "control",
  }, profile, { x: 360, y: 640 }, { width: 720, height: 1280 });

  assert.deepEqual(mapped, { x: 360, y: 780 });
});

test("rejects a viewport unrelated to the referenced frame", () => {
  assert.throws(() => framePointToScreenPoint({
    dataUrl: "data:image/jpeg;base64,AA==",
    width: profile.frame.width,
    height: profile.frame.height,
    capturedAt: Date.now(),
    source: "black-arm-built-in-uvc",
    deviceId: profile.deviceId,
    role: "verification",
  }, profile, { x: 1, y: 1 }, { width: 400, height: 800 }), RangeError);
});
