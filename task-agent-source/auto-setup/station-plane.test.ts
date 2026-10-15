import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenHandCalibrationProfile } from "../agent/calibration-profile";
import {
  attachOnScreenNavigationEvidence,
  attachPhysicalHomeButtonEvidence,
  buildUnknownPhonePlacementCandidate,
  createStationPlaneArtifact,
  parseStationPlaneArtifact,
  stationPlaneFromProfile,
} from "./station-plane";

const profile: ScreenHandCalibrationProfile = {
  id: "station-profile-v1",
  deviceId: "arm-01",
  verified: true,
  verifiedAt: "2026-09-01T00:00:00.000Z",
  frame: { width: 720, height: 1280 },
  screen: { width: 720, height: 1560 },
  imagePoints: [
    { x: 80, y: 40 },
    { x: 640, y: 40 },
    { x: 640, y: 1240 },
    { x: 80, y: 1240 },
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
  tap: { hoverZ: 1, touchZ: 10, zStep: 0.5, feed: 9_000, dwellMs: 80 },
  placementCalibration: {
    method: "joint-camera-touch-v1",
    verifiedAt: "2026-09-01T00:00:00.000Z",
    cameraRmsePx: 2.1,
    cameraMaximumErrorPx: 3.4,
  },
};

const movementBounds = {
  minimumX: 5.8,
  maximumX: 80,
  minimumY: 5,
  maximumY: 165,
};

function observations(
  points: ScreenHandCalibrationProfile["imagePoints"],
) {
  return [0, 1, 2].map((index) => ({
    sequence: 100 + index,
    frame: { width: 720, height: 1280 },
    points: points.map((point) => ({
      x: point.x + (index - 1) * 0.25,
      y: point.y + (index - 1) * 0.2,
    })) as ScreenHandCalibrationProfile["imagePoints"],
    confidence: 0.97,
    score: 0.91,
    runnerUpScore: null,
    elapsedMs: 45,
  }));
}

test("extracts and hash-verifies a phone-independent station plane", () => {
  const artifact = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  assert.equal(parseStationPlaneArtifact(artifact).sha256, artifact.sha256);
  assert.throws(() => parseStationPlaneArtifact({
    ...artifact,
    calibration: {
      ...artifact.calibration,
      machinePoints: artifact.calibration.machinePoints.map((point, index) =>
        index === 0 ? { ...point, x: point.x + 1 } : point
      ),
    },
  }), /hash does not match/);
});

test("maps an unknown modern phone in Shadow but never inherits touch depth", () => {
  const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  const candidate = buildUnknownPhonePlacementCandidate({
    station,
    observations: observations(profile.imagePoints),
    movementBounds,
    now: new Date("2026-09-01T01:02:03.000Z"),
  });
  assert.equal(candidate.navigationAssessment, "edge_gesture_candidate");
  assert.equal(candidate.xyReady, true);
  assert.equal(candidate.touchDepthReady, false);
  assert.equal(candidate.actionReady, false);
  assert.equal(
    candidate.contactDepthAssessment.strategy,
    "camera-surface-intersection-v1",
  );
  assert.equal(candidate.contactDepthAssessment.actionReady, false);
  assert.equal(candidate.elapsedMs, 45);
  assert.ok(candidate.blockers.includes("touch_depth_unverified"));
  assert.ok(candidate.canonicalScreen.height > 1_500);
  assert.ok(candidate.maximumDeviationPx < 1);
});

test("flags a 16:9-class display for physical Home-button evidence", () => {
  const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  const legacyPoints = [
    { x: 120, y: 170 },
    { x: 600, y: 170 },
    { x: 600, y: 1_020 },
    { x: 120, y: 1_020 },
  ] as ScreenHandCalibrationProfile["imagePoints"];
  const candidate = buildUnknownPhonePlacementCandidate({
    station,
    observations: observations(legacyPoints),
    movementBounds,
  });
  assert.equal(candidate.navigationAssessment, "physical_home_button_candidate");
  assert.ok(candidate.blockers.includes("physical_home_button_evidence_required"));
  assert.equal(candidate.actionReady, false);
});

test("maps detected physical Home evidence but keeps its contact locked", () => {
  const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  const candidate = buildUnknownPhonePlacementCandidate({
    station,
    observations: observations(profile.imagePoints),
    movementBounds,
  });
  const attached = attachPhysicalHomeButtonEvidence({
    candidate,
    station,
    observation: {
      version: 1,
      mode: "shadow",
      status: "detected",
      reason: "centered-circular-button",
      point: { x: 360, y: 1250 },
      normalizedPoint: { x: 0.5, belowScreenWidths: 0.04 },
      radiusScreenWidths: 0.05,
      confidence: 0.96,
      score: 0.96,
      runnerUpScore: 0.7,
      contrast: 32,
      angularCoverage: 0.91,
      polarity: 0.9,
      circularity: 0.94,
      evaluatedCandidates: 500,
      wouldMoveHardware: false,
      actionReady: false,
    },
    movementBounds,
  });
  assert.equal(attached.navigationAssessment, "physical_home_button_candidate");
  assert.equal(
    attached.physicalHomeButtonEvidence?.withinMovementBounds,
    true,
  );
  assert.ok(attached.blockers.includes("physical_home_button_contact_unverified"));
  assert.equal(attached.actionReady, false);
});

test("records a detected gesture handle but keeps the edge gesture locked", () => {
  const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  const candidate = buildUnknownPhonePlacementCandidate({
    station,
    observations: observations(profile.imagePoints),
    movementBounds,
  });
  const attached = attachOnScreenNavigationEvidence({
    candidate,
    station,
    observation: {
      version: 1,
      mode: "shadow",
      status: "detected",
      strategy: "gesture_handle",
      confidence: 0.94,
      homePoint: null,
      gestureHandleBounds: { left: 270, top: 1_520, width: 180, height: 12 },
      threeButtonCenters: null,
      wouldMoveHardware: false,
      actionReady: false,
    },
    movementBounds,
  });
  assert.equal(attached.navigationAssessment, "edge_gesture_candidate");
  assert.equal(attached.onScreenNavigationEvidence?.machinePoint, null);
  assert.ok(attached.blockers.includes("gesture_navigation_contact_unverified"));
  assert.equal(attached.actionReady, false);
});

test("maps on-screen three-button Home but keeps physical contact locked", () => {
  const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  const candidate = buildUnknownPhonePlacementCandidate({
    station,
    observations: observations(profile.imagePoints),
    movementBounds,
  });
  const attached = attachOnScreenNavigationEvidence({
    candidate,
    station,
    observation: {
      version: 1,
      mode: "shadow",
      status: "detected",
      strategy: "three_button",
      confidence: 0.91,
      homePoint: { x: 360, y: 1_522 },
      gestureHandleBounds: null,
      threeButtonCenters: [
        { x: 180, y: 1_522 },
        { x: 360, y: 1_522 },
        { x: 540, y: 1_522 },
      ],
      wouldMoveHardware: false,
      actionReady: false,
    },
    movementBounds,
  });
  assert.equal(attached.navigationAssessment, "on_screen_home_button_candidate");
  assert.equal(attached.onScreenNavigationEvidence?.withinMovementBounds, true);
  assert.ok(attached.onScreenNavigationEvidence?.machinePoint);
  assert.ok(attached.blockers.includes("on_screen_home_button_contact_unverified"));
  assert.equal(attached.actionReady, false);
});

test("locks navigation when physical and on-screen Home evidence conflict", () => {
  const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  const candidate = buildUnknownPhonePlacementCandidate({
    station,
    observations: observations(profile.imagePoints),
    movementBounds,
  });
  const onScreen = attachOnScreenNavigationEvidence({
    candidate,
    station,
    observation: {
      version: 1,
      mode: "shadow",
      status: "detected",
      strategy: "gesture_handle",
      confidence: 0.94,
      homePoint: null,
      gestureHandleBounds: { left: 270, top: 1_520, width: 180, height: 12 },
      threeButtonCenters: null,
      wouldMoveHardware: false,
      actionReady: false,
    },
    movementBounds,
  });
  const conflicted = attachPhysicalHomeButtonEvidence({
    candidate: onScreen,
    station,
    observation: {
      version: 1,
      mode: "shadow",
      status: "detected",
      reason: "centered-circular-button",
      point: { x: 360, y: 1_250 },
      normalizedPoint: { x: 0.5, belowScreenWidths: 0.04 },
      radiusScreenWidths: 0.05,
      confidence: 0.96,
      score: 0.96,
      runnerUpScore: 0.7,
      contrast: 32,
      angularCoverage: 0.91,
      polarity: 0.9,
      circularity: 0.94,
      evaluatedCandidates: 500,
      wouldMoveHardware: false,
      actionReady: false,
    },
    movementBounds,
  });
  assert.equal(conflicted.navigationAssessment, "unknown");
  assert.ok(conflicted.blockers.includes("navigation_evidence_conflict"));
  assert.equal(conflicted.actionReady, false);
});

test("rejects inaccurate station evidence and ambiguous phone frames", () => {
  assert.throws(() => stationPlaneFromProfile({
    ...profile,
    placementCalibration: {
      ...profile.placementCalibration!,
      cameraMaximumErrorPx: 7,
    },
  }), /too high/);
  const station = createStationPlaneArtifact(stationPlaneFromProfile(profile));
  const ambiguous = observations(profile.imagePoints).map((observation) => ({
    ...observation,
    runnerUpScore: 0.86,
  }));
  assert.throws(() => buildUnknownPhonePlacementCandidate({
    station,
    observations: ambiguous,
    movementBounds,
  }), /ambiguous/);
});
