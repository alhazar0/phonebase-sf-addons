import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import type { ScreenHandSemanticAction } from "./action-contract";
import { readTransitionJournal } from "./active-world/transition-journal";
import { InMemoryAgentMemory } from "./agent-memory";
import type {
  AgentActionResult,
  AgentDevice,
  GeneralAgentDeviceClient,
} from "./general-agent-client";
import { GeneralMobileAgent } from "./general-mobile-agent";
import { ScreenObserver, type AgentFrame } from "./screen-observer";
import type { VisionOcrResult } from "./vision-ocr";

test("platform-neutral agent records a verified camera transition", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-general-world-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const first = await imageFrame(255, 40);
  const second = await imageFrame(0, 41);
  const client = new FixtureClient(first, second);
  let recognition = 0;
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({
      ocrMode: "fast",
      recognize: async () => recognition++ === 0
        ? ocr(["Continue", "Welcome"])
        : ocr(["Done", "Success"]),
    }),
    memory: new InMemoryAgentMemory(),
    activeWorld: { artifactDirectory: directory },
    verificationTimeoutMs: 500,
  });
  const result = await agent.run({
    deviceId: "fixture",
    goal: "点击 Continue",
    mode: "execute",
    maxSteps: 2,
    timeoutMs: 2_000,
  });
  assert.equal(result.status, "completed", JSON.stringify({
    reason: result.reason,
    events: result.events,
  }));
  assert.equal(client.actions.length, 1);
  assert.equal(result.activeWorld?.observations, 2);
  assert.equal(result.activeWorld?.transitions, 1);
  assert.equal(result.activeWorld?.verifiedTransitions, 1);
  assert.equal(result.activeWorld?.speculations, 1);
  assert.equal(result.activeWorld?.eligibleSpeculations, 0);
  assert.equal(result.activeWorld?.criticEvaluations, 1);
  assert.equal(result.activeWorld?.criticAccepted, 1);
  assert.equal(result.activeWorld?.criticRejected, 0);
  assert.ok(result.activeWorld?.journalPath.startsWith(directory));
  const records = await readTransitionJournal(result.activeWorld!.journalPath);
  const transition = records.find((record) => record.event.type === "transition");
  assert.ok(transition?.event.type === "transition");
  assert.equal(transition.event.transition.action.action.type, "tap");
  assert.equal(transition.event.transition.precondition?.sequence, 40);
  assert.equal(transition.event.transition.postcondition?.sequence, 41);
  const speculation = records.find((record) => record.event.type === "speculative_hover");
  assert.ok(speculation?.event.type === "speculative_hover");
  assert.equal(speculation.event.decision.eligible, false);
  assert.equal(speculation.event.decision.reason, "belief-uncertain");
  assert.equal(speculation.event.decision.wouldMoveHardware, false);
  const critic = records.find((record) => record.event.type === "critic_evaluation");
  assert.ok(critic?.event.type === "critic_evaluation");
  assert.equal(critic.event.decision.accepted, true);
  assert.equal(critic.event.decision.wouldChangeExecution, false);
});

class FixtureClient implements GeneralAgentDeviceClient {
  readonly actions: ScreenHandSemanticAction[] = [];

  constructor(
    private readonly first: AgentFrame,
    private readonly second: AgentFrame,
  ) {}

  async getDevice(): Promise<AgentDevice> {
    return {
      id: "fixture",
      connected: true,
      status: "running",
      screen: {
        width: 720,
        height: 1_560,
        rawWidth: 720,
        rawHeight: 1_560,
        rectified: false,
        imagePoints: null,
        calibrationId: "fixture",
      },
      capabilities: { actions: {} },
    };
  }

  async getScreenshot() {
    return this.first;
  }

  async waitForNewScreenshot() {
    return this.second;
  }

  async executeAction(action: ScreenHandSemanticAction): Promise<AgentActionResult> {
    this.actions.push(action);
    return {
      receipt: { id: "receipt-general", status: "completed" },
      elapsedMs: 80,
      response: {},
    };
  }
}

async function imageFrame(value: number, sequence: number): Promise<AgentFrame> {
  const bytes = await sharp({
    create: {
      width: 72,
      height: 156,
      channels: 3,
      background: { r: value, g: value, b: value },
    },
  }).jpeg().toBuffer();
  return {
    bytes,
    mimeType: "image/jpeg",
    width: 720,
    height: 1_560,
    sequence,
    capturedAt: Date.now(),
  };
}

function ocr(labels: string[]): VisionOcrResult {
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: labels.map((text, index) => ({
      text,
      confidence: 0.96,
      left: 250,
      top: 300 + index * 80,
      width: 220,
      height: 40,
      centerX: 360,
      centerY: 320 + index * 80,
    })),
  };
}
