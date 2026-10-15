import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import {
  createToolContactAnchorArtifact,
  fitToolContactAnchorCalibration,
  type ToolContactAnchorSample,
} from "../active-world/tool-contact-anchor";
import {
  createStationPlaneArtifact,
  stationPlaneFromProfile,
} from "../../auto-setup/station-plane";
import {
  bindRealtimeContactAnchorToProfile,
  loadRealtimeContactAnchor,
} from "./contact-anchor-loader";

const deviceId = "arm-01";
const profile: ScreenHandCalibrationProfile = {
  id: "station-profile-v1",
  deviceId,
  verified: true,
  verifiedAt: "2026-09-02T00:00:00.000Z",
  frame: { width: 720, height: 1_280 },
  screen: { width: 720, height: 1_560 },
  imagePoints: [
    { x: 80, y: 40 },
    { x: 640, y: 40 },
    { x: 640, y: 1_240 },
    { x: 80, y: 1_240 },
  ],
  machinePoints: [
    { x: 78, y: 158 },
    { x: 8, y: 158 },
    { x: 8, y: 6.333 },
    { x: 78, y: 6.333 },
  ],
  safeMachineBounds: {
    minimumX: 6,
    maximumX: 80,
    minimumY: 5,
    maximumY: 165,
  },
  tap: { hoverZ: 1, touchZ: 10, zStep: 0.5, feed: 3_000, dwellMs: 80 },
  placementCalibration: {
    method: "joint-camera-touch-v1",
    verifiedAt: "2026-09-02T00:00:00.000Z",
    cameraRmsePx: 1,
    cameraMaximumErrorPx: 2,
  },
};

function anchorSamples(): ToolContactAnchorSample[] {
  let sequence = 1;
  return [10, 70].flatMap((x) => [20, 150].flatMap((y) => [1, 9].map((z) => {
    const markerCameraPoint = { x: 100 + x * 2, y: 100 + y * 3 };
    return {
      sequence: sequence++,
      machinePoint: { x, y },
      physicalZMm: z,
      markerCameraPoint,
      contactTipCameraPoint: {
        x: markerCameraPoint.x + 2 + z * 0.1,
        y: markerCameraPoint.y - 3 + z * 0.2,
      },
      confidence: 0.98,
    };
  })));
}

test("loads a tool anchor only when it matches the station artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-anchor-loader-"));
  try {
    const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
    const anchor = createToolContactAnchorArtifact(fitToolContactAnchorCalibration({
      deviceId,
      stationPlaneSha256: station.sha256,
      sourceProfileId: profile.id,
      verifiedAt: "2026-09-02T08:00:00.000Z",
      frame: profile.frame,
      samples: anchorSamples(),
    }));
    await Promise.all([
      writeFile(
        join(directory, `${deviceId}.station-plane.json`),
        JSON.stringify(station),
      ),
      writeFile(
        join(directory, `${deviceId}.tool-contact-anchor.json`),
        JSON.stringify(anchor),
      ),
    ]);
    const loaded = await loadRealtimeContactAnchor(deviceId, directory);
    assert.equal(loaded.status, "ready", JSON.stringify(loaded));
    if (loaded.status === "ready") {
      assert.equal(loaded.stationPlaneSha256, station.sha256);
      assert.equal(loaded.artifact.sha256, anchor.sha256);
    }
    assert.equal(bindRealtimeContactAnchorToProfile(
      loaded,
      { ...profile, id: "replacement-profile" },
    ).reason, "artifact-profile-mismatch");
    assert.equal(bindRealtimeContactAnchorToProfile(
      loaded,
      { ...profile, frame: { width: 1_080, height: 1_920 } },
    ).reason, "artifact-frame-mismatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports missing, tampered, and cross-station artifacts without guessing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-anchor-loader-"));
  try {
    assert.deepEqual(await loadRealtimeContactAnchor(deviceId, directory), {
      status: "unavailable",
      reason: "station-plane-missing",
    });
    const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
    await writeFile(
      join(directory, `${deviceId}.station-plane.json`),
      JSON.stringify(station),
    );
    assert.deepEqual(await loadRealtimeContactAnchor(deviceId, directory), {
      status: "unavailable",
      reason: "tool-contact-anchor-missing",
    });
    const anchor = createToolContactAnchorArtifact(fitToolContactAnchorCalibration({
      deviceId,
      stationPlaneSha256: "b".repeat(64),
      sourceProfileId: profile.id,
      verifiedAt: "2026-09-02T08:00:00.000Z",
      frame: profile.frame,
      samples: anchorSamples(),
    }));
    await writeFile(
      join(directory, `${deviceId}.tool-contact-anchor.json`),
      JSON.stringify(anchor),
    );
    const mismatch = await loadRealtimeContactAnchor(deviceId, directory);
    assert.equal(mismatch.status, "invalid");
    assert.equal(mismatch.reason, "artifact-station-mismatch");
    await writeFile(
      join(directory, `${deviceId}.tool-contact-anchor.json`),
      JSON.stringify({ ...anchor, sha256: "0".repeat(64) }),
    );
    const tampered = await loadRealtimeContactAnchor(deviceId, directory);
    assert.equal(tampered.status, "invalid");
    assert.equal(tampered.reason, "artifact-invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
