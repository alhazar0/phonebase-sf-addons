import assert from "node:assert/strict";
import test from "node:test";

import type { AgentDevice } from "../general-agent-client";
import { deviceKinematics } from "./visual-servo-stream";

function device(physicalZ?: number): AgentDevice {
  return {
    id: "fixture",
    connected: true,
    status: "online",
    screen: null,
    capabilities: { actions: {} },
    state: {
      grbl: {
        state: "Idle",
        x: 45,
        y: 85,
        z: 0,
        ...(physicalZ === undefined ? {} : { physicalZ }),
      },
    },
  };
}

test("keeps normalized and physical Z in their distinct coordinate spaces", () => {
  const kinematics = deviceKinematics(device(1));
  assert.deepEqual(kinematics?.point, { x: 45, y: 85 });
  assert.equal(kinematics?.physicalZMm, 1);
  assert.equal(kinematics?.safeForTemplateCalibration, true);
});

test("never infers physical Z when the bridge omits it", () => {
  const kinematics = deviceKinematics(device());
  assert.equal(kinematics?.physicalZMm, null);
  assert.equal(kinematics?.safeForTemplateCalibration, true);
});
