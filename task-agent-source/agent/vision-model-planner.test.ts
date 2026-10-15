import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenObservation } from "./general-agent-contract";
import type { AgentFrame } from "./screen-observer";
import { OpenAIVisionPlanner } from "./vision-model-planner";

test("OpenAI visual planner sends a camera frame with strict structured output", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const planner = new OpenAIVisionPlanner({
    apiKey: "test-key",
    model: "test-vision-model",
    serviceTier: "priority",
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          operation: "tap",
          target: "Continue",
          text: null,
          x: 0.5,
          y: 0.75,
          startX: null,
          startY: null,
          endX: null,
          endY: null,
          durationMs: null,
          confidence: 0.93,
          rationale: "Continue is visible and safe.",
        }),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const proposal = await planner.plan({
    goal: "continue",
    step: 1,
    frame: testFrame(),
    observation: testObservation(),
  });

  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.equal(requestBody.model, "test-vision-model");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.service_tier, "priority");
  assert.equal(proposal.operation, "tap");
  assert.equal(proposal.x, 0.5);
  const input = requestBody.input as Array<Record<string, unknown>>;
  const content = input[0].content as Array<Record<string, unknown>>;
  assert.match(String(content[1].image_url), /^data:image\/jpeg;base64,/);
  const text = requestBody.text as Record<string, unknown>;
  const format = text.format as Record<string, unknown>;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
});

test("OpenAI visual planner rejects malformed normalized coordinates", async () => {
  const planner = new OpenAIVisionPlanner({
    apiKey: "test-key",
    fetchImplementation: async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        operation: "tap",
        target: "Bad",
        text: null,
        x: 1.2,
        y: 0.5,
        startX: null,
        startY: null,
        endX: null,
        endY: null,
        durationMs: null,
        confidence: 0.9,
        rationale: "Malformed fixture.",
      }),
    }), { status: 200 }),
  });
  await assert.rejects(
    planner.plan({
      goal: "tap",
      step: 1,
      frame: testFrame(),
      observation: testObservation(),
    }),
    /invalid x/i,
  );
});

test("visual planner discovers OpenRouter configuration without changing OpenAI defaults", {
  concurrency: false,
}, () => {
  const previous = {
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    openAiApiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    model: process.env.SCREENHAND_VISION_MODEL,
  };
  try {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.SCREENHAND_VISION_MODEL;
    const planner = OpenAIVisionPlanner.fromEnvironment();
    assert.ok(planner);
    assert.equal(
      (planner as unknown as { baseUrl: URL }).baseUrl.href,
      "https://openrouter.ai/api/v1/",
    );
  } finally {
    restoreEnvironment("OPENROUTER_API_KEY", previous.openRouterApiKey);
    restoreEnvironment("OPENAI_API_KEY", previous.openAiApiKey);
    restoreEnvironment("OPENAI_BASE_URL", previous.baseUrl);
    restoreEnvironment("SCREENHAND_VISION_MODEL", previous.model);
  }
});

function testFrame(): AgentFrame {
  return {
    bytes: Buffer.from("camera-frame"),
    mimeType: "image/jpeg",
    width: 720,
    height: 1_560,
    sequence: 7,
    capturedAt: 1_000,
  };
}

function testObservation(): ScreenObservation {
  return {
    sequence: 7,
    capturedAt: 1_000,
    viewport: { width: 720, height: 1_560 },
    fingerprint: "fixture",
    changeRatio: null,
    changeKind: "first",
    ocrCacheHit: false,
    ocrElapsedMs: 10,
    observationElapsedMs: 12,
    averageTextConfidence: 0.9,
    textSignature: new Set(["continue"]),
    elements: [{
      id: "text-0",
      role: "text",
      text: "Continue",
      confidence: 0.9,
      center: { x: 360, y: 1_100 },
      bounds: { left: 300, top: 1_080, width: 120, height: 40 },
    }],
    scene: {
      kind: "text_ui",
      confidence: 0.8,
      homeGridScore: 0.1,
      keyboardVisible: false,
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
