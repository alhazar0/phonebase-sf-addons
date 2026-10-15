import assert from "node:assert/strict";
import test from "node:test";

import { ScreenHandGeneralAgentClient } from "./general-agent-client";

test("action client uses one idempotent POST and long-polls without a capability preflight", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const client = new ScreenHandGeneralAgentClient(
    "fixture-device",
    "http://127.0.0.1:3013",
    2_000,
    async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      if (init?.method === "POST") {
        return Response.json({
          result: { receipt: { id: "receipt-1", status: "accepted" } },
        });
      }
      return Response.json({
        receipt: { id: "receipt-1", status: "completed", durationMs: 80 },
      });
    },
  );
  const result = await client.executeAction(
    { type: "phone_key", key: "back" },
    undefined,
    { idempotencyKey: "stable-action-1" },
  );
  assert.equal(result.receipt.status, "completed");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(JSON.parse(requests[0].body), {
    idempotencyKey: "stable-action-1",
    action: { type: "phone_key", key: "back" },
  });
  assert.match(requests[1].url, /actions\/receipt-1\?waitMs=/);
  assert.equal(requests.some((request) => /devices\/fixture-device$/.test(request.url)), false);
});
