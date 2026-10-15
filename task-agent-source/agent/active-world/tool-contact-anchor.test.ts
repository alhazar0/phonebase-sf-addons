import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolContactAnchorArtifact,
  fitToolContactAnchorCalibration,
  parseToolContactAnchorArtifact,
  projectContactTipCameraPoint,
  type ToolContactAnchorSample,
} from "./tool-contact-anchor";

const stationPlaneSha256 = "a".repeat(64);
const frame = { width: 720, height: 1_280 };

function samples(): ToolContactAnchorSample[] {
  let sequence = 1;
  const output: ToolContactAnchorSample[] = [];
  for (const x of [10, 70]) {
    for (const y of [20, 150]) {
      for (const z of [1, 9]) {
        const markerCameraPoint = {
          x: 120 + x * 3 + z * 0.4,
          y: 80 + y * 4 + z * 1.5,
        };
        const offset = {
          x: 2 + x * 0.01 - y * 0.005 + z * 0.2,
          y: -3 + x * 0.004 + y * 0.006 + z * 0.3,
        };
        output.push({
          sequence: sequence++,
          machinePoint: { x, y },
          physicalZMm: z,
          markerCameraPoint,
          contactTipCameraPoint: {
            x: markerCameraPoint.x + offset.x,
            y: markerCameraPoint.y + offset.y,
          },
          confidence: 0.98,
        });
      }
    }
  }
  return output;
}

function artifact() {
  return createToolContactAnchorArtifact(fitToolContactAnchorCalibration({
    deviceId: "arm-01",
    stationPlaneSha256,
    sourceProfileId: "station-profile-v1",
    verifiedAt: "2026-09-02T08:00:00.000Z",
    frame,
    samples: samples(),
  }));
}

test("fits and hash-verifies a station-level tool-to-contact anchor", () => {
  const value = artifact();
  const parsed = parseToolContactAnchorArtifact(value);
  assert.equal(parsed.sha256, value.sha256);
  assert.equal(parsed.calibration.evidence.sampleCount, 8);
  assert.ok(parsed.calibration.evidence.rmsePx < 0.001);
  assert.throws(() => parseToolContactAnchorArtifact({
    ...value,
    calibration: {
      ...value.calibration,
      offsetModel: {
        ...value.calibration.offsetModel,
        x: [99, ...value.calibration.offsetModel.x.slice(1)],
      },
    },
  }), /hash does not match/);
});

test("projects a tracked tool anchor into an absolute contact-tip point", () => {
  const result = projectContactTipCameraPoint({
    artifact: artifact(),
    deviceId: "arm-01",
    stationPlaneSha256,
    sourceProfileId: "station-profile-v1",
    frame,
    machinePoint: { x: 40, y: 85 },
    physicalZMm: 5,
    markerCameraPoint: { x: 300, y: 500 },
    markerConfidence: 0.97,
    frameAgeMs: 20,
  });
  assert.equal(result.status, "anchored", JSON.stringify(result));
  assert.equal(result.pointReference, "absolute-contact-camera-point");
  assert.deepEqual(result.estimatedOffsetPx, { x: 2.975, y: -0.83 });
  assert.deepEqual(result.contactTipCameraPoint, { x: 302.975, y: 499.17 });
  assert.equal(result.eligibleForContactDepthEstimate, true);
  assert.equal(result.wouldMoveHardware, false);
  assert.equal(result.actionReady, false);
});

test("fails closed outside its station, profile, frame, or calibrated volume", () => {
  const base = {
    artifact: artifact(),
    deviceId: "arm-01",
    stationPlaneSha256,
    sourceProfileId: "station-profile-v1",
    frame,
    machinePoint: { x: 40, y: 85 },
    physicalZMm: 5,
    markerCameraPoint: { x: 300, y: 500 },
    markerConfidence: 0.97,
    frameAgeMs: 20,
  };
  assert.equal(projectContactTipCameraPoint({
    ...base,
    stationPlaneSha256: "b".repeat(64),
  }).reason, "station-mismatch");
  assert.equal(projectContactTipCameraPoint({
    ...base,
    sourceProfileId: "another-profile",
  }).reason, "profile-mismatch");
  assert.equal(projectContactTipCameraPoint({
    ...base,
    frame: { width: 1_080, height: 1_920 },
  }).reason, "frame-mismatch");
  assert.equal(projectContactTipCameraPoint({
    ...base,
    physicalZMm: 10,
  }).reason, "outside-calibrated-volume");
  assert.equal(projectContactTipCameraPoint({
    ...base,
    markerConfidence: 0.5,
  }).reason, "marker-confidence-low");
  assert.equal(projectContactTipCameraPoint({
    ...base,
    frameAgeMs: 500,
  }).reason, "frame-stale");
  assert.equal(projectContactTipCameraPoint({
    ...base,
    markerCameraPoint: { x: -1, y: 500 },
  }).reason, "outside-calibrated-volume");
});

test("rejects sparse, degenerate, or inaccurate factory evidence", () => {
  const base = {
    deviceId: "arm-01",
    stationPlaneSha256,
    sourceProfileId: "station-profile-v1",
    verifiedAt: "2026-09-02T08:00:00.000Z",
    frame,
  };
  assert.throws(() => fitToolContactAnchorCalibration({
    ...base,
    samples: samples().slice(0, 7),
  }), /at least 8/);
  assert.throws(() => fitToolContactAnchorCalibration({
    ...base,
    samples: samples().map((sample) => ({
      ...sample,
      physicalZMm: 1,
    })),
  }), /span the required/);
  assert.throws(() => fitToolContactAnchorCalibration({
    ...base,
    samples: samples().map((sample, index) => index === 7
      ? {
          ...sample,
          contactTipCameraPoint: {
            x: sample.contactTipCameraPoint.x + 10,
            y: sample.contactTipCameraPoint.y - 10,
          },
        }
      : sample),
  }), /outside tolerance/);
});
