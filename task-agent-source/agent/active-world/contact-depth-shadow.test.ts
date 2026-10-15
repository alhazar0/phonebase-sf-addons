import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateContactDepthShadow,
  evaluateTargetIntersectionContactDepthShadow,
  type CameraContactTargetSample,
  type CameraSurfaceLineSample,
  type CameraZTrajectorySample,
} from "./contact-depth-shadow";

const trajectory = [1, 3, 5, 7].map((commandedZMm, index) => ({
  sequence: 10 + index,
  commandedZMm,
  markerPoint: {
    x: 100 + (commandedZMm * 0.3),
    y: 50 + (commandedZMm * 5),
  },
  markerPointReference: "absolute-contact-camera-point",
  markerConfidence: 0.98,
  frameAgeMs: 20,
})) satisfies CameraZTrajectorySample[];

const surface = [0, 1, 2].map((index) => ({
  sequence: 20 + index,
  line: { a: 0, b: 1, c: -(95 + ((index - 1) * 0.2)) },
  confidence: 0.97,
  frameAgeMs: 25,
})) satisfies CameraSurfaceLineSample[];

const hardware = {
  hoverZMm: 1,
  minimumTouchZMm: 9.5,
  maximumTouchZMm: 10,
};

const targets = [0, 1, 2].map((index) => ({
  sequence: 30 + index,
  targetPoint: {
    x: 102.7 + ((index - 1) * 0.02),
    y: 95 + ((index - 1) * 0.08),
  },
  confidence: 0.98,
  frameAgeMs: 20,
})) satisfies CameraContactTargetSample[];

test("estimates camera-only surface depth but never unlocks contact", () => {
  const result = evaluateContactDepthShadow({ trajectory, surface, hardware });
  assert.equal(result.status, "estimated");
  assert.equal(result.reason, "surface-intersection-estimated");
  assert.ok(Math.abs((result.estimatedSurfaceZMm ?? 0) - 9) < 0.01);
  assert.ok(Math.abs((result.recommendedApproachZMm ?? 0) - 8.65) < 0.01);
  assert.ok((result.trajectoryPixelsPerMm ?? 0) > 5);
  assert.ok((result.trajectoryRmsePx ?? 1) < 0.01);
  assert.equal(result.wouldMoveHardware, false);
  assert.equal(result.actionReady, false);
  assert.ok(result.blockers.includes("capacitive_activation_unverified"));
});

test("holds when the camera angle cannot observe Z", () => {
  const topDown = trajectory.map((sample) => ({
    ...sample,
    markerPoint: {
      x: 100 + (sample.commandedZMm * 0.03),
      y: 50 + (sample.commandedZMm * 0.04),
    },
  }));
  const result = evaluateContactDepthShadow({
    trajectory: topDown,
    surface,
    hardware,
  });
  assert.equal(result.status, "hold");
  assert.equal(result.reason, "z-trajectory-unobservable");
  assert.equal(result.actionReady, false);
});

test("holds on unstable glass evidence or an unsafe inherited pressure range", () => {
  const unstable = surface.map((sample, index) => ({
    ...sample,
    line: { ...sample.line, c: -(92 + (index * 3)) },
  }));
  assert.equal(evaluateContactDepthShadow({
    trajectory,
    surface: unstable,
    hardware,
  }).reason, "surface-estimate-unstable");

  const shallowSurface = surface.map((sample) => ({
    ...sample,
    line: { a: 0, b: 1, c: -90 },
  }));
  assert.equal(evaluateContactDepthShadow({
    trajectory,
    surface: shallowSurface,
    hardware,
  }).reason, "existing-pressure-range-too-deep");
});

test("rejects stale, reordered, and malformed contact evidence", () => {
  assert.equal(evaluateContactDepthShadow({
    trajectory: trajectory.map((sample) => ({ ...sample, frameAgeMs: 500 })),
    surface,
    hardware,
  }).reason, "evidence-stale");
  assert.equal(evaluateContactDepthShadow({
    trajectory: [trajectory[1], trajectory[0], ...trajectory.slice(2)],
    surface,
    hardware,
  }).reason, "sequence-invalid");
  assert.equal(evaluateContactDepthShadow({
    trajectory: trajectory.map((sample, index) => index === 0
      ? { ...sample, commandedZMm: 0.5 }
      : sample),
    surface,
    hardware,
  }).reason, "trajectory-outside-hardware-range");
  assert.throws(() => evaluateContactDepthShadow({
    trajectory,
    surface: surface.map((sample) => ({
      ...sample,
      line: { a: 0, b: 0, c: 1 },
    })),
    hardware,
  }), /degenerate/);
});

test("estimates main-camera contact from the intended glass target", () => {
  const result = evaluateTargetIntersectionContactDepthShadow({
    trajectory,
    targets,
    hardware,
  });
  assert.equal(result.status, "estimated", JSON.stringify(result));
  assert.equal(result.reason, "target-intersection-estimated");
  assert.ok(Math.abs((result.estimatedSurfaceZMm ?? 0) - 9) < 0.01);
  assert.ok(Math.abs((result.recommendedApproachZMm ?? 0) - 8.65) < 0.01);
  assert.ok((result.targetSpreadPx ?? 1) < 0.1);
  assert.ok((result.targetTrajectoryMissPx ?? 1) < 0.1);
  assert.ok(result.blockers.includes("marker_contact_offset_unverified"));
  assert.equal(result.wouldMoveHardware, false);
  assert.equal(result.actionReady, false);
});

test("holds on an unstable projected target or a trajectory that misses it", () => {
  const unstableTargets = targets.map((sample, index) => index === 2
    ? { ...sample, targetPoint: { x: sample.targetPoint.x + 3, y: sample.targetPoint.y } }
    : sample);
  assert.equal(evaluateTargetIntersectionContactDepthShadow({
    trajectory,
    targets: unstableTargets,
    hardware,
  }).reason, "target-evidence-unstable");

  const missedTargets = targets.map((sample) => ({
    ...sample,
    targetPoint: { x: sample.targetPoint.x + 2, y: sample.targetPoint.y },
  }));
  assert.equal(evaluateTargetIntersectionContactDepthShadow({
    trajectory,
    targets: missedTargets,
    hardware,
  }).reason, "target-trajectory-miss");
});

test("target-intersection evidence keeps freshness and ordering fail-closed", () => {
  assert.equal(evaluateTargetIntersectionContactDepthShadow({
    trajectory,
    targets: targets.map((sample) => ({ ...sample, frameAgeMs: 500 })),
    hardware,
  }).reason, "evidence-stale");
  assert.equal(evaluateTargetIntersectionContactDepthShadow({
    trajectory,
    targets: [targets[1], targets[0], targets[2]],
    hardware,
  }).reason, "sequence-invalid");
  assert.throws(() => evaluateTargetIntersectionContactDepthShadow({
    trajectory,
    targets: targets.map((sample, index) => index === 0
      ? { ...sample, targetPoint: { x: Number.NaN, y: 95 } }
      : sample),
    hardware,
  }), /target evidence is malformed/);
});

test("rejects template-relative marker points as absolute contact evidence", () => {
  assert.throws(() => evaluateTargetIntersectionContactDepthShadow({
    trajectory: trajectory.map((sample) => ({
      ...sample,
      markerPointReference: "relative-template-center" as never,
    })),
    targets,
    hardware,
  }), /trajectory evidence is malformed/);
});
