import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { rectifyFrame, renderModelScreenFrame } from "./rectify-frame";

test("rectifies an encoded camera frame into the requested screen size", async () => {
  const rawWidth = 64;
  const rawHeight = 96;
  const input = await sharp({
    create: {
      width: rawWidth,
      height: rawHeight,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  }).jpeg().toBuffer();
  const result = await rectifyFrame(input, {
    rawWidth,
    rawHeight,
    screenWidth: 72,
    screenHeight: 120,
    imagePoints: [
      { x: 0, y: 0 },
      { x: rawWidth - 1, y: 0 },
      { x: rawWidth - 1, y: rawHeight - 1 },
      { x: 0, y: rawHeight - 1 },
    ],
  });
  const metadata = await sharp(result).metadata();

  assert.equal(metadata.width, 72);
  assert.equal(metadata.height, 120);
  assert.equal(metadata.format, "jpeg");
});

test("pre-scales model pixels while preserving canonical logical dimensions", async () => {
  const input = await sharp({
    create: {
      width: 72,
      height: 120,
      channels: 3,
      background: { r: 20, g: 80, b: 160 },
    },
  }).jpeg().toBuffer();
  const result = await renderModelScreenFrame(input, {
    width: 72,
    height: 120,
    rawWidth: 72,
    rawHeight: 120,
    rectified: false,
    imagePoints: null,
    calibrationId: "test-calibration",
  }, 256);
  const metadata = await sharp(result.bytes).metadata();

  assert.equal(result.logicalWidth, 72);
  assert.equal(result.logicalHeight, 120);
  assert.equal(result.imageWidth, 72);
  assert.equal(result.imageHeight, 120);
  assert.equal(metadata.width, 72);
  assert.equal(metadata.height, 120);
});

test("limits a canonical model frame to the configured long edge", async () => {
  const input = await sharp({
    create: {
      width: 180,
      height: 390,
      channels: 3,
      background: { r: 90, g: 50, b: 10 },
    },
  }).jpeg().toBuffer();
  const result = await renderModelScreenFrame(input, {
    width: 180,
    height: 390,
    rawWidth: 180,
    rawHeight: 390,
    rectified: false,
    imagePoints: null,
    calibrationId: "test-calibration",
  }, 256);

  assert.equal(result.logicalWidth, 180);
  assert.equal(result.logicalHeight, 390);
  assert.equal(result.imageWidth, 118);
  assert.equal(result.imageHeight, 256);
  assert.deepEqual(
    await sharp(result.bytes).metadata().then(({ width, height }) => ({ width, height })),
    { width: 118, height: 256 },
  );
});

test("warps a rectified camera directly into the bounded model raster", async () => {
  const rawWidth = 72;
  const rawHeight = 128;
  const input = await sharp({
    create: {
      width: rawWidth,
      height: rawHeight,
      channels: 3,
      background: { r: 60, g: 90, b: 120 },
    },
  }).jpeg().toBuffer();
  const result = await renderModelScreenFrame(input, {
    width: 720,
    height: 1_560,
    rawWidth,
    rawHeight,
    rectified: true,
    imagePoints: [
      { x: 3, y: 2 },
      { x: 68, y: 2 },
      { x: 70, y: 125 },
      { x: 1, y: 125 },
    ],
    calibrationId: "camera-profile",
  }, 256);

  assert.equal(result.logicalWidth, 720);
  assert.equal(result.logicalHeight, 1_560);
  assert.equal(result.imageWidth, 118);
  assert.equal(result.imageHeight, 256);
  assert.deepEqual(
    await sharp(result.bytes).metadata().then(({ width, height }) => ({ width, height })),
    { width: 118, height: 256 },
  );
});

test("keeps a sharper local-vision raster without enlarging the model input", async () => {
  const input = await sharp({
    create: {
      width: 360,
      height: 780,
      channels: 3,
      background: { r: 30, g: 60, b: 90 },
    },
  }).jpeg().toBuffer();
  const result = await renderModelScreenFrame(input, {
    width: 360,
    height: 780,
    rawWidth: 360,
    rawHeight: 780,
    rectified: false,
    imagePoints: null,
    calibrationId: "test-calibration",
  }, 256, 512);

  assert.deepEqual(
    await sharp(result.bytes).metadata().then(({ width, height }) => ({ width, height })),
    { width: 118, height: 256 },
  );
  assert.ok(result.localVisionBytes);
  assert.deepEqual(
    await sharp(result.localVisionBytes).metadata().then(({ width, height }) => ({ width, height })),
    { width: 236, height: 512 },
  );
});
