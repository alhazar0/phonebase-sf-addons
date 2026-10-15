import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import type { ScreenQuad, VisionScreenCandidate } from "../vision-screen";
import {
  createToolContactAnchorArtifact,
  fitToolContactAnchorCalibration,
  type ToolContactAnchorSample,
} from "./tool-contact-anchor";
import { VisualServoShadowCoordinator } from "./visual-servo-shadow";

const phone: ScreenQuad = [
  { x: 74, y: 20 },
  { x: 166, y: 20 },
  { x: 166, y: 220 },
  { x: 74, y: 220 },
];
const calibration = {
  id: "fixture",
  deviceId: "fixture",
  verified: true,
  verifiedAt: new Date().toISOString(),
  frame: { width: 240, height: 240 },
  screen: { width: 720, height: 1_560 },
  imagePoints: phone,
  machinePoints: [
    { x: 80, y: 160 },
    { x: 10, y: 160 },
    { x: 10, y: 10 },
    { x: 80, y: 10 },
  ],
  safeMachineBounds: {
    minimumX: 10,
    maximumX: 80,
    minimumY: 10,
    maximumY: 160,
  },
  tap: { hoverZ: 1, touchZ: 10, zStep: 0.5, feed: 3_000, dwellMs: 40 },
} satisfies ScreenHandCalibrationProfile;

test("coordinates slow phone tracking and fast tip tracking without motor access", async () => {
  const detector = async (): Promise<VisionScreenCandidate> => ({
    confidence: 0.98,
    topLeft: phone[0],
    topRight: phone[1],
    bottomRight: phone[2],
    bottomLeft: phone[3],
    areaRatio: 0.32,
  });
  const coordinator = new VisualServoShadowCoordinator({
    calibration,
    frame: { width: 240, height: 240 },
    referencePoints: phone,
    planeDetector: detector,
    // Keep the slow-plane branch deterministic even when the full test suite
    // makes the first Sharp decode take longer than a wall-clock interval.
    planeIntervalMs: 60_000,
  });
  const kinematics = {
    point: { x: 45, y: 85 },
    physicalZMm: 1,
    observedAt: Date.now(),
    safeForTemplateCalibration: true,
  };
  const first = await cameraFrame(1, 120, 120);
  const initialized = await coordinator.observe(first, kinematics);
  assert.equal(initialized.templateCalibrated, true);
  coordinator.beginAction({
    executionId: "action-1",
    label: "fixture tap",
    action: {
      type: "tap",
      point: { x: 400, y: 780 },
      viewport: calibration.screen,
      frameSequence: 1,
      durationMs: 60,
    },
  });
  const second = await cameraFrame(2, 120, 120);
  const observed = await coordinator.observe(second, {
    ...kinematics,
    observedAt: Date.now(),
  });
  assert.equal(observed.planeUpdated, false);
  assert.equal(observed.tip?.status, "tracking", JSON.stringify(observed.tip));
  assert.equal(observed.correction?.status, "correct");
  assert.equal(observed.correction?.wouldMoveHardware, false);
  assert.equal(observed.wouldMoveHardware, false);
  coordinator.finishAction("action-1");
  assert.equal(coordinator.summary().activeTarget, false);
});

test("records distinct physical-Z approach samples without treating them as contact", async () => {
  const detector = async (): Promise<VisionScreenCandidate> => ({
    confidence: 0.98,
    topLeft: phone[0],
    topRight: phone[1],
    bottomRight: phone[2],
    bottomLeft: phone[3],
    areaRatio: 0.32,
  });
  const coordinator = new VisualServoShadowCoordinator({
    calibration,
    frame: { width: 240, height: 240 },
    referencePoints: phone,
    planeDetector: detector,
    planeIntervalMs: 60_000,
  });
  const kinematics = (physicalZMm: number) => ({
    point: { x: 45, y: 85 },
    physicalZMm,
    observedAt: Date.now(),
    safeForTemplateCalibration: physicalZMm === 1,
  });
  await coordinator.observe(await cameraFrame(10, 120, 120), kinematics(1));
  coordinator.beginAction({
    executionId: "action-contact-shadow",
    label: "center tap",
    action: {
      type: "tap",
      point: { x: 360, y: 780 },
      viewport: calibration.screen,
      frameSequence: 10,
      durationMs: 60,
    },
  });

  const hover = await coordinator.observe(
    await cameraFrame(11, 120, 120),
    kinematics(1),
  );
  assert.equal(hover.contactDepthSample?.physicalZMm, 1);
  assert.equal(
    hover.contactDepthSample?.markerPointReference,
    "tracked-template-anchor-camera-point",
  );
  assert.equal(hover.contactDepthSample?.eligibleForContactEstimate, false);
  assert.equal(hover.contactDepthSample?.wouldMoveHardware, false);

  const repeated = await coordinator.observe(
    await cameraFrame(12, 120, 120),
    kinematics(1),
  );
  assert.equal(repeated.contactDepthSample, null);
  const deeper = await coordinator.observe(
    await cameraFrame(13, 121, 120),
    kinematics(2),
  );
  assert.equal(deeper.contactDepthSample?.physicalZMm, 2);
  const release = await coordinator.observe(
    await cameraFrame(14, 120, 120),
    kinematics(1.5),
  );
  assert.equal(release.contactDepthSample, null);
  const afterRelease = await coordinator.observe(
    await cameraFrame(15, 122, 120),
    kinematics(3),
  );
  assert.equal(afterRelease.contactDepthSample, null);
  assert.equal(coordinator.summary().contactDepthActionsObserved, 1);
  assert.equal(coordinator.summary().contactDepthSamples, 2);
});

test("anchors the real tip before evaluating target-intersection depth", async () => {
  const stationPlaneSha256 = "a".repeat(64);
  const detector = async (): Promise<VisionScreenCandidate> => ({
    confidence: 0.98,
    topLeft: phone[0],
    topRight: phone[1],
    bottomRight: phone[2],
    bottomLeft: phone[3],
    areaRatio: 0.32,
  });
  const coordinator = new VisualServoShadowCoordinator({
    calibration,
    frame: { width: 240, height: 240 },
    referencePoints: phone,
    planeDetector: detector,
    planeIntervalMs: 60_000,
    contactAnchor: {
      artifact: contactAnchorArtifact(stationPlaneSha256),
      stationPlaneSha256,
    },
    contactDepthHardware: {
      hoverZMm: 1,
      minimumTouchZMm: 9.5,
      maximumTouchZMm: 10,
    },
  });
  const kinematics = (physicalZMm: number) => ({
    point: { x: 45, y: 85 },
    physicalZMm,
    observedAt: Date.now(),
    safeForTemplateCalibration: physicalZMm === 1,
  });
  await coordinator.observe(await cameraFrame(20, 120, 120), kinematics(1));
  coordinator.beginAction({
    executionId: "action-anchored-contact",
    label: "center anchored tap",
    action: {
      type: "tap",
      point: { x: 360, y: 780 },
      viewport: calibration.screen,
      frameSequence: 20,
      durationMs: 60,
    },
  });
  for (const [index, z] of [1, 3, 5, 7].entries()) {
    const observation = await coordinator.observe(
      await cameraFrame(21 + index, 120, 120),
      kinematics(z),
    );
    assert.equal(observation.contactDepthSample?.eligibleForContactEstimate, true);
    assert.equal(
      observation.contactDepthSample?.contactTipPointReference,
      "absolute-contact-camera-point",
    );
  }
  coordinator.finishAction("action-anchored-contact");
  const summary = coordinator.summary();
  assert.equal(summary.anchoredContactDepthSamples, 4);
  assert.equal(summary.contactDepthEvaluations, 1);
  assert.equal(summary.lastContactDepthEvaluation?.result.status, "estimated");
  assert.equal(
    summary.lastContactDepthEvaluation?.result.reason,
    "target-intersection-estimated",
  );
  assert.equal(summary.lastContactDepthEvaluation?.result.estimatedSurfaceZMm, 9);
  assert.equal(summary.lastContactDepthEvaluation?.result.actionReady, false);
});

function contactAnchorArtifact(stationPlaneSha256: string) {
  let sequence = 1;
  const samples: ToolContactAnchorSample[] = [];
  for (const x of [10, 80]) {
    for (const y of [10, 160]) {
      for (const z of [1, 10]) {
        const markerCameraPoint = { x: 100, y: 100 };
        samples.push({
          sequence: sequence++,
          machinePoint: { x, y },
          physicalZMm: z,
          markerCameraPoint,
          contactTipCameraPoint: {
            x: markerCameraPoint.x,
            y: markerCameraPoint.y + 18 - (2 * z),
          },
          confidence: 0.99,
        });
      }
    }
  }
  return createToolContactAnchorArtifact(fitToolContactAnchorCalibration({
    deviceId: calibration.deviceId,
    stationPlaneSha256,
    sourceProfileId: calibration.id,
    verifiedAt: "2026-09-02T08:00:00.000Z",
    frame: calibration.frame,
    samples,
  }));
}

async function cameraFrame(sequence: number, x: number, y: number) {
  const bytes = await sharp({
    create: { width: 240, height: 240, channels: 3, background: "#5ca8c7" },
  }).composite([{
    input: Buffer.from(`
      <svg width="240" height="240" xmlns="http://www.w3.org/2000/svg">
        <path d="M ${x - 11} ${y + 10} Q ${x} ${y - 13} ${x + 11} ${y + 10}"
          fill="none" stroke="#111" stroke-width="7"/>
        <circle cx="${x}" cy="${y}" r="3" fill="#eee"/>
      </svg>
    `),
  }]).jpeg({ quality: 95 }).toBuffer();
  return {
    bytes,
    width: 240,
    height: 240,
    sequence,
    capturedAt: Date.now(),
  };
}
