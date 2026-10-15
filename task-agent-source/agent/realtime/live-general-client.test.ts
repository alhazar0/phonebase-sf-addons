import assert from "node:assert/strict";
import test from "node:test";

import type { GeneralAgentDeviceClient } from "../general-agent-client";
import { LiveGeneralAgentClient } from "./live-general-client";
import type { RealtimeFrameHub } from "./frame-hub";

test("generic realtime client reads the live frame hub and preserves action idempotency", async () => {
  const frame = {
    bytes: Buffer.from("live"),
    mimeType: "image/jpeg" as const,
    width: 720,
    height: 1_560,
    sequence: 12,
    capturedAt: 1,
  };
  const calls: string[] = [];
  const control = {
    executeAction: async (_action, _signal, options) => {
      calls.push(options?.idempotencyKey ?? "missing");
      return {
        receipt: { id: "receipt", status: "completed" as const },
        elapsedMs: 10,
        response: {},
      };
    },
  } as GeneralAgentDeviceClient;
  const frames = {
    latestModelFrame: async () => frame,
    waitForModelFrame: async () => ({ ...frame, sequence: 13 }),
  } as unknown as RealtimeFrameHub;
  const client = new LiveGeneralAgentClient(control, frames);
  assert.equal((await client.getScreenshot()).sequence, 12);
  assert.equal((await client.waitForNewScreenshot(12, 100)).sequence, 13);
  await client.executeAction(
    { type: "phone_key", key: "back" },
    undefined,
    { idempotencyKey: "action-1" },
  );
  assert.deepEqual(calls, ["action-1"]);
});
