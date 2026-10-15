import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { ScreenHandSemanticAction } from "./action-contract";
import { InMemoryAgentMemory } from "./agent-memory";
import type {
  AgentActionResult,
  AgentDevice,
  GeneralAgentDeviceClient,
} from "./general-agent-client";
import type { AgentPlan, ScreenObservation } from "./general-agent-contract";
import {
  assertGeneralPlanAllowed,
  GeneralMobileAgent,
  planAgentStep,
  planExecutionKey,
  planOutcomeVerified,
  planVisionModelProposal,
} from "./general-mobile-agent";
import { ScreenObserver, type AgentFrame } from "./screen-observer";
import { SemanticSceneGraphTracker } from "./semantic-scene-graph";
import type { VisionModelPlanner, VisionModelProposal } from "./vision-model-planner";
import type { VisionOcrResult } from "./vision-ocr";

test("plans Home before opening an app from an unknown page", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "text_ui",
    confidence: 0.7,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  const decision = planAgentStep(
    { type: "open_app", appName: "Anything" },
    observation,
    {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: false,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    },
  );
  assert.equal(decision.type, "action");
  if (decision.type === "action") {
    assert.equal(decision.plan.kind, "reach_home");
    assert.deepEqual(decision.plan.action, { type: "phone_key", key: "home" });
    assert.equal(decision.plan.completesGoal, false);
  }
});

test("wakes a sleeping screen before attempting system navigation", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "screen_off",
    confidence: 0.99,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  observation.elements = [];
  const decision = planAgentStep(
    { type: "navigate", key: "home" },
    observation,
    {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: false,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    },
  );
  assert.equal(decision.type, "action");
  if (decision.type !== "action") return;
  assert.equal(decision.plan.kind, "wake_screen");
  assert.deepEqual(
    decision.plan.action.type === "tap" ? decision.plan.action.point : null,
    { x: 360, y: 780 },
  );
  assert.equal(decision.plan.completesGoal, false);
});

test("plans an unlabeled icon tap only from an explicit spatial descriptor", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "text_ui",
    confidence: 0.8,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  observation.elements = [];
  observation.sceneGraph = new SemanticSceneGraphTracker().update({
    sequence: observation.sequence,
    fingerprint: observation.fingerprint,
    viewport: observation.viewport,
    scene: observation.scene,
    elements: [],
    visualAffordances: [{
      role: "navigation",
      label: "unlabeled top-right navigation",
      confidence: 0.9,
      center: { x: 650, y: 100 },
      bounds: { left: 618, top: 68, width: 64, height: 64 },
      source: "local_edges",
      edgeDensity: 0.3,
      localContrast: 80,
    }],
  });
  const decision = planAgentStep(
    {
      type: "tap_affordance",
      descriptor: { role: "icon", horizontal: "right", vertical: "top" },
    },
    observation,
    {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: false,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    },
  );
  assert.equal(decision.type, "action");
  if (decision.type !== "action") return;
  assert.equal(decision.plan.kind, "tap_affordance");
  assert.deepEqual(
    decision.plan.action.type === "tap" ? decision.plan.action.point : null,
    { x: 650, y: 100 },
  );

  const model = planVisionModelProposal(modelProposal({
    operation: "tap",
    target: "top-right icon",
    x: 0.1,
    y: 0.9,
    confidence: 0.92,
    rationale: "Use the visible toolbar icon.",
  }), observation);
  assert.equal(model.type, "action");
  if (model.type !== "action") return;
  assert.deepEqual(
    model.plan.action.type === "tap" ? model.plan.action.point : null,
    { x: 650, y: 100 },
  );
});

test("uses system search when an app is not visible instead of swiping into App Library", () => {
  const state = {
    requestedHome: false,
    homePageSwipes: 0,
    fieldFocused: false,
    appSearchOpened: false,
    appSearchTyped: false,
    keyboardLanguageSwitches: 0,
  };
  const first = planAgentStep(
    { type: "open_app", appName: "Telegram" },
    homeObservation(),
    state,
  );
  assert.equal(first.type, "action");
  if (first.type !== "action") return;
  assert.equal(first.plan.kind, "open_app_search");
  assert.equal(first.plan.action.type, "tap");

  state.appSearchOpened = true;
  const search = homeObservation();
  search.scene = { kind: "keyboard", confidence: 0.9, homeGridScore: 0, keyboardVisible: true };
  const type = planAgentStep({ type: "open_app", appName: "Telegram" }, search, state);
  assert.equal(type.type, "action");
  if (type.type !== "action") return;
  assert.equal(type.plan.kind, "search_app");
  assert.deepEqual(type.plan.action, { type: "input_text", text: "Telegram" });

  state.appSearchTyped = true;
  search.elements.push({
    id: "telegram-result",
    role: "text",
    text: "Telegram",
    confidence: 0.97,
    center: { x: 140, y: 300 },
    bounds: { left: 90, top: 285, width: 100, height: 30 },
  });
  const open = planAgentStep({ type: "open_app", appName: "Telegram" }, search, state);
  assert.equal(open.type, "action");
  if (open.type !== "action") return;
  assert.equal(open.plan.kind, "open_app_result");
  assert.deepEqual(open.plan.action.type === "tap" ? open.plan.action.point : null, { x: 140, y: 300 });
});

test("recovers Home and app launch from iOS system overview states", () => {
  const state = {
    requestedHome: false,
    homePageSwipes: 0,
    fieldFocused: false,
    appSearchOpened: false,
    appSearchTyped: false,
    keyboardLanguageSwitches: 0,
  };
  const switcher = homeObservation();
  switcher.scene = {
    kind: "app_switcher",
    confidence: 0.94,
    homeGridScore: 0.5,
    keyboardVisible: false,
  };
  const dismiss = planAgentStep({ type: "navigate", key: "home" }, switcher, state);
  assert.equal(dismiss.type, "action");
  if (dismiss.type !== "action") return;
  assert.equal(dismiss.plan.kind, "dismiss_app_switcher");
  assert.equal(dismiss.plan.action.type, "tap");
  assert.equal(dismiss.plan.completesGoal, true);

  const library = homeObservation();
  library.scene = {
    kind: "app_library",
    confidence: 0.98,
    homeGridScore: 0.4,
    keyboardVisible: false,
  };
  const leave = planAgentStep({ type: "navigate", key: "home" }, library, state);
  assert.equal(leave.type, "action");
  if (leave.type !== "action") return;
  assert.equal(leave.plan.kind, "leave_app_library");
  assert.equal(leave.plan.action.type, "swipe");

  const search = planAgentStep({ type: "open_app", appName: "Telegram" }, library, state);
  assert.equal(search.type, "action");
  if (search.type !== "action") return;
  assert.equal(search.plan.kind, "open_app_search");
  assert.equal(search.plan.action.type, "tap");
});

test("reuses an existing system-search result without typing the app name again", () => {
  const state = {
    requestedHome: false,
    homePageSwipes: 0,
    fieldFocused: false,
    appSearchOpened: false,
    appSearchTyped: false,
    keyboardLanguageSwitches: 0,
  };
  const search = homeObservation();
  search.scene = { kind: "keyboard", confidence: 0.9, homeGridScore: 0, keyboardVisible: true };
  search.elements = [
    {
      id: "top-hit",
      role: "text",
      text: "Top Hit",
      confidence: 0.95,
      center: { x: 80, y: 130 },
      bounds: { left: 40, top: 120, width: 80, height: 20 },
    },
    {
      id: "telegram",
      role: "text",
      text: "Telegram",
      confidence: 0.97,
      center: { x: 126, y: 323 },
      bounds: { left: 80, top: 310, width: 92, height: 26 },
    },
  ];
  const decision = planAgentStep({ type: "open_app", appName: "Telegram" }, search, state);
  assert.equal(decision.type, "action");
  if (decision.type !== "action") return;
  assert.equal(decision.plan.kind, "open_app_result");
  assert.equal(decision.plan.action.type, "tap");
  assert.deepEqual(decision.plan.action.type === "tap" ? decision.plan.action.point : null, {
    x: 126,
    y: 323 - 1_560 * 0.055,
  });
});

test("targets the icon above an app label when OCR damages the Suggestions header", () => {
  const state = {
    requestedHome: false,
    homePageSwipes: 0,
    fieldFocused: false,
    appSearchOpened: false,
    appSearchTyped: false,
    keyboardLanguageSwitches: 0,
  };
  const search = homeObservation();
  search.scene = { kind: "keyboard", confidence: 0.9, homeGridScore: 0, keyboardVisible: true };
  search.elements = [
    textElement("Sir Suggestions", 130, 132),
    textElement("Telegram", 282, 320),
    textElement("Instagram", 437, 318),
  ];
  const decision = planAgentStep({ type: "open_app", appName: "Instagram" }, search, state);
  assert.equal(decision.type, "action");
  if (decision.type !== "action" || decision.plan.action.type !== "tap") return;
  assert.deepEqual(decision.plan.action.point, {
    x: 437,
    y: 318 - 1_560 * 0.055,
  });
});

test("normalizes a non-Latin keyboard before calibrated text entry", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "keyboard",
    confidence: 0.9,
    homeGridScore: 0,
    keyboardVisible: true,
  };
  observation.elements = [textElement("深航方案", 200, 950)];
  const decision = planAgentStep(
    { type: "input_text", field: "Search", text: "screenhand" },
    observation,
    {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: true,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    },
  );
  assert.equal(decision.type, "action");
  if (decision.type !== "action") return;
  assert.equal(decision.plan.kind, "prepare_keyboard");
  assert.deepEqual(decision.plan.action, {
    type: "phone_key",
    key: "keyboard_next",
  });
});

test("focuses a search field instead of its right-aligned submit button", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "text_ui",
    confidence: 0.9,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  observation.elements = [textElement("Search", 648, 125)];
  const decision = planAgentStep(
    { type: "input_text", field: "Search", text: "robotqa" },
    observation,
    {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: false,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    },
  );
  assert.equal(decision.type, "action");
  if (decision.type !== "action" || decision.plan.action.type !== "tap") return;
  assert.equal(decision.plan.kind, "focus_field");
  assert.deepEqual(decision.plan.action.point, { x: 288, y: 125 });
});

test("infers a populated search bar from the widest top-toolbar text", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "text_ui",
    confidence: 0.9,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  observation.elements = [
    textElement("12:55", 100, 59),
    {
      ...textElement("cat in the hat in snapchat trend", 305, 130),
      bounds: { left: 100, top: 112, width: 405, height: 34 },
    },
    textElement("Videos Users", 324, 200),
  ];
  const decision = planAgentStep(
    { type: "input_text", field: "Search", text: "robotqa" },
    observation,
    {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: false,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    },
  );
  assert.equal(decision.type, "action");
  if (decision.type !== "action" || decision.plan.action.type !== "tap") return;
  assert.deepEqual(decision.plan.action.point, { x: 288, y: 130 });
});

test("dry run returns a coordinate plan without executing hardware", async () => {
  const client = await fakeClient();
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({ recognize: async () => homeOcr() }),
    memory: new InMemoryAgentMemory(),
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "打开 ObscureApp 应用",
    mode: "dry_run",
    maxSteps: 4,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "planned");
  assert.equal(result.plan?.kind, "open_app");
  assert.equal(result.plan?.action.type, "tap");
  assert.equal(client.actions.length, 0);
});

test("generic agent handles a visible popup before the original task without a model", async () => {
  const client = await fakeClient();
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({
      ocrMode: "fast",
      recognize: async () => popupOcr(),
    }),
    memory: new InMemoryAgentMemory(),
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "点击 Continue 按钮",
    mode: "dry_run",
    maxSteps: 4,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "planned");
  assert.equal(result.plan?.kind, "popup_guardian");
  assert.equal(result.plan?.action.type, "tap");
  if (result.plan?.action.type === "tap") {
    assert.deepEqual(result.plan.action.point, { x: 240, y: 820 });
  }
  assert.equal(client.actions.length, 0);
  assert.ok(result.events.some((event) =>
    event.phase === "recover" && event.data?.source === "local_scene_graph"
  ));
});

test("generic popup recovery visually clears the interruption and resumes the task", async () => {
  const first = await imageFrame(255, 1);
  const second = await imageFrame(0, 2);
  let current = first;
  const actions: ScreenHandSemanticAction[] = [];
  const client: GeneralAgentDeviceClient = {
    async getDevice() {
      return {
        id: "black-arm-01",
        connected: true,
        status: "running",
        screen: {
          width: 720,
          height: 1_560,
          rawWidth: 720,
          rawHeight: 1_560,
          rectified: false,
          imagePoints: null,
          calibrationId: "test",
        },
        capabilities: { actions: {} },
      };
    },
    async getScreenshot() {
      return current;
    },
    async waitForNewScreenshot() {
      return second;
    },
    async executeAction(action) {
      actions.push(action);
      current = second;
      return {
        receipt: { id: "popup-receipt", status: "completed" },
        elapsedMs: 50,
        response: {},
      };
    },
  };
  let ocrCall = 0;
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({
      ocrMode: "fast",
      recognize: async () => ocrCall++ === 0 ? popupOcr() : homeOcr(),
    }),
    memory: new InMemoryAgentMemory(),
    verificationTimeoutMs: 1_000,
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "返回首页",
    mode: "execute",
    maxSteps: 4,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "completed");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "tap");
  assert.equal(result.metrics.recoveries, 1);
});

test("execute mode waits for receipt and verifies a changed camera frame", async () => {
  const client = await fakeClient();
  let ocrCall = 0;
  const memory = new InMemoryAgentMemory();
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({
      recognize: async () => ocrCall++ === 0 ? homeOcr() : appOcr(),
    }),
    memory,
    verificationTimeoutMs: 1_000,
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "open ObscureApp app",
    mode: "execute",
    maxSteps: 4,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "completed");
  assert.equal(client.actions.length, 1);
  assert.equal(client.actions[0].type, "tap");
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].success, true);
  assert.equal(result.metrics.actions, 1);
  const timing = result.metrics.runtimeTiming?.timing;
  assert.equal(timing?.schemaVersion, "screenhand.runtime-timing.v1");
  assert.ok((timing?.segmentSamples.frameTransport.count ?? 0) >= 1);
  assert.ok((timing?.segmentSamples.perception.count ?? 0) >= 1);
  assert.ok((timing?.segmentSamples.planning.count ?? 0) >= 1);
  assert.ok((timing?.segmentSamples.physicalMotion.count ?? 0) >= 1);
  assert.ok((timing?.segmentSamples.phoneAnimation.count ?? 0) >= 1);
  assert.ok((timing?.segmentSamples.verification.count ?? 0) >= 1);
});

test("dry run never invokes recovery hardware when observation fails", async () => {
  let actionCalls = 0;
  const client: GeneralAgentDeviceClient = {
    getDevice: async () => { throw new Error("offline"); },
    getScreenshot: async () => { throw new Error("no frame"); },
    waitForNewScreenshot: async () => { throw new Error("no frame"); },
    executeAction: async () => {
      actionCalls += 1;
      throw new Error("must not execute");
    },
  };
  const agent = new GeneralMobileAgent(client, {
    memory: new InMemoryAgentMemory(),
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "返回首页",
    mode: "dry_run",
    maxSteps: 8,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "failed");
  assert.equal(actionCalls, 0);
  assert.equal(result.metrics.actions, 0);
});

test("an unknown natural-language goal uses the optional vision model without moving in dry run", async () => {
  const client = await fakeClient();
  const planner: VisionModelPlanner = {
    plan: async () => modelProposal({
      operation: "tap",
      target: "Settings",
      x: 0.25,
      y: 0.5,
      confidence: 0.91,
      rationale: "The Settings control is visible.",
    }),
  };
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({ recognize: async () => appOcr() }),
    memory: new InMemoryAgentMemory(),
    modelPlanner: planner,
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "完成当前页面中的下一步任务",
    mode: "dry_run",
    maxSteps: 3,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "planned");
  assert.equal(result.plan?.kind, "model");
  assert.deepEqual(
    result.plan?.action.type === "tap" ? result.plan.action.point : null,
    { x: 180, y: 780 },
  );
  assert.equal(result.metrics.modelRuns, 1);
  assert.equal(client.actions.length, 0);
});

test("does not ask a vision model to reinterpret Home app artwork as a symbol", async () => {
  const client = await fakeClient();
  let modelCalls = 0;
  const planner: VisionModelPlanner = {
    plan: async () => {
      modelCalls += 1;
      return modelProposal({
        operation: "tap",
        target: "search",
        x: 0.85,
        y: 0.1,
        confidence: 0.99,
        rationale: "A Home app logo resembles Search.",
      });
    },
  };
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({ recognize: async () => homeOcr() }),
    memory: new InMemoryAgentMemory(),
    modelPlanner: planner,
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "点击搜索图标",
    mode: "dry_run",
    maxSteps: 3,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "blocked");
  assert.equal(modelCalls, 0);
  assert.equal(result.metrics.modelRuns, 0);
  assert.equal(client.actions.length, 0);
});

test("a model-driven action must be re-observed before the model can complete the goal", async () => {
  const client = await fakeClient();
  let calls = 0;
  const planner: VisionModelPlanner = {
    plan: async () => calls++ === 0
      ? modelProposal({
          operation: "tap",
          target: "Continue",
          x: 0.5,
          y: 0.75,
          confidence: 0.9,
          rationale: "The next safe control is visible.",
        })
      : modelProposal({
          operation: "complete",
          confidence: 0.94,
          rationale: "The destination screen is now visible.",
        }),
  };
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({ recognize: async () => appOcr() }),
    memory: new InMemoryAgentMemory(),
    modelPlanner: planner,
    verificationTimeoutMs: 1_000,
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "继续直到出现目标页",
    mode: "execute",
    maxSteps: 3,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "completed");
  assert.equal(client.actions.length, 1);
  assert.equal(calls, 2);
  assert.equal(result.metrics.modelRuns, 2);
});

test("permits the same grounded model action on a newly verified screen but not the same screen", () => {
  const plan: AgentPlan = {
    kind: "model",
    action: {
      type: "tap",
      point: { x: 680, y: 900 },
      viewport: { width: 720, height: 1_560 },
      frameSequence: 10,
    },
    label: "tap Like",
    rationale: "The current post is not liked.",
    confidence: 0.95,
    completesGoal: false,
    requiresVisualChange: true,
  };
  const first = homeObservation();
  const second = homeObservation();
  second.fingerprint = "next-video";
  assert.equal(planExecutionKey(plan, first), planExecutionKey(plan, first));
  assert.notEqual(planExecutionKey(plan, first), planExecutionKey(plan, second));
});

test("maps a model-requested dwell to a bounded wait without requiring screen change", () => {
  const decision = planVisionModelProposal(modelProposal({
    operation: "wait",
    durationMs: 10_000,
    confidence: 0.98,
    rationale: "The requested call dwell has started.",
  }), homeObservation());
  assert.equal(decision.type, "action");
  if (decision.type !== "action") return;
  assert.deepEqual(decision.plan.action, { type: "wait", durationMs: 10_000 });
  assert.equal(decision.plan.requiresVisualChange, false);
  assert.equal(decision.plan.completesGoal, false);
});

test("Home verification rejects an app switcher and requires a home grid", () => {
  const before = homeObservation();
  before.scene = {
    kind: "keyboard",
    confidence: 0.9,
    homeGridScore: 0,
    keyboardVisible: true,
  };
  const switcher = homeObservation();
  switcher.fingerprint = "switcher";
  switcher.changeRatio = 0.2;
  switcher.scene = {
    kind: "text_ui",
    confidence: 0.8,
    homeGridScore: 0.2,
    keyboardVisible: false,
  };
  const home = homeObservation();
  home.fingerprint = "home-after";
  home.changeRatio = 0.3;
  const plan = {
    kind: "navigate" as const,
    action: { type: "phone_key" as const, key: "home" as const },
    label: "home navigation",
    rationale: "test",
    confidence: 1,
    completesGoal: true,
    requiresVisualChange: true,
  };
  assert.equal(planOutcomeVerified(plan, before, switcher), false);
  assert.equal(planOutcomeVerified(plan, before, home), true);
});

test("dismissing App Switcher verifies Home rather than any unrelated page", () => {
  const before = homeObservation();
  before.scene = {
    kind: "app_switcher",
    confidence: 0.94,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  const decision = planAgentStep(
    { type: "navigate", key: "home" },
    before,
    {
      requestedHome: false,
      homePageSwipes: 0,
      fieldFocused: false,
      appSearchOpened: false,
      appSearchTyped: false,
      keyboardLanguageSwitches: 0,
    },
  );
  assert.equal(decision.type, "action");
  if (decision.type !== "action") return;
  const unrelated = homeObservation();
  unrelated.fingerprint = "ordinary-app";
  unrelated.changeRatio = 0.3;
  unrelated.scene = {
    kind: "text_ui",
    confidence: 0.8,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  const home = homeObservation();
  home.fingerprint = "verified-home";
  home.changeRatio = 0.3;
  assert.equal(planOutcomeVerified(decision.plan, before, unrelated), false);
  assert.equal(planOutcomeVerified(decision.plan, before, home), true);
});

test("text entry is verified by visible OCR content rather than any screen change", () => {
  const before = homeObservation();
  before.scene = {
    kind: "keyboard",
    confidence: 0.9,
    homeGridScore: 0,
    keyboardVisible: true,
  };
  const plan = {
    kind: "input_text" as const,
    action: { type: "input_text" as const, text: "screenhand" },
    label: "type screenhand",
    rationale: "test",
    confidence: 0.95,
    completesGoal: true,
    requiresVisualChange: true,
  };
  const unrelated = homeObservation();
  unrelated.fingerprint = "unrelated-change";
  unrelated.changeRatio = 0.2;
  unrelated.elements = [textElement("Search suggestions", 300, 180)];
  assert.equal(planOutcomeVerified(plan, before, unrelated), false);

  const typed = homeObservation();
  typed.fingerprint = "typed-change";
  typed.changeRatio = 0.2;
  typed.elements = [textElement("screenhand", 240, 110)];
  assert.equal(planOutcomeVerified(plan, before, typed), true);

  const resultOnly = homeObservation();
  resultOnly.fingerprint = "matching-result-change";
  resultOnly.changeRatio = 0.2;
  resultOnly.elements = [textElement("screenhand", 240, 420)];
  assert.equal(planOutcomeVerified(plan, before, resultOnly), false);
});

test("long text entry can be verified from its auto-scrolled suffix", () => {
  const before = homeObservation();
  const after = homeObservation();
  after.fingerprint = "long-text-change";
  after.changeRatio = 0.2;
  after.elements = [textElement("omatically", 320, 120)];
  const plan = {
    kind: "model" as const,
    action: {
      type: "input_text" as const,
      text: "This is sending from robot automatically",
    },
    label: "type message",
    rationale: "test",
    confidence: 0.95,
    completesGoal: false,
    requiresVisualChange: true,
  };
  assert.equal(planOutcomeVerified(plan, before, after), true);
});

test("a failed completion action is not retried indefinitely", async () => {
  const client = await fakeClient();
  client.waitForNewScreenshot = async () => client.getScreenshot();
  const agent = new GeneralMobileAgent(client, {
    observer: new ScreenObserver({ recognize: async () => homeOcr() }),
    memory: new InMemoryAgentMemory(),
    verificationTimeoutMs: 10,
  });
  const result = await agent.run({
    deviceId: "black-arm-01",
    goal: "点击 ObscureApp",
    mode: "execute",
    maxSteps: 8,
    timeoutMs: 2_000,
  });
  assert.equal(result.status, "blocked");
  assert.equal(client.actions.length, 1);
  assert.equal(result.metrics.recoveries, 0);
});

test("generic full access still requires the requested external effect", () => {
  const observation = homeObservation();
  const plan = {
    kind: "model" as const,
    action: {
      type: "tap" as const,
      point: { x: 360, y: 780 },
      viewport: observation.viewport,
      frameSequence: observation.sequence,
    },
    label: "tap Like",
    rationale: "fixture",
    confidence: 0.9,
    completesGoal: false,
    requiresVisualChange: true,
  };
  assert.doesNotThrow(() => assertGeneralPlanAllowed(
    plan,
    observation,
    "full_access",
    "给第二个作品点赞",
  ));
  assert.throws(() => assertGeneralPlanAllowed(
    plan,
    observation,
    "full_access",
    "只查看第二个作品",
  ), /did not request/i);
  assert.throws(() => assertGeneralPlanAllowed(
    plan,
    observation,
    "read_only",
    "给第二个作品点赞",
  ), /read-only/i);
});

async function fakeClient() {
  const first = await imageFrame(255, 1);
  const second = await imageFrame(0, 2);
  return new class implements GeneralAgentDeviceClient {
    readonly actions: ScreenHandSemanticAction[] = [];

    async getDevice(): Promise<AgentDevice> {
      return {
        id: "black-arm-01",
        connected: true,
        status: "running",
        screen: {
          width: 720,
          height: 1_560,
          rawWidth: 720,
          rawHeight: 1_560,
          rectified: false,
          imagePoints: null,
          calibrationId: "test",
        },
        capabilities: { actions: {} },
      };
    }

    async getScreenshot() {
      return first;
    }

    async waitForNewScreenshot() {
      return second;
    }

    async executeAction(action: ScreenHandSemanticAction): Promise<AgentActionResult> {
      this.actions.push(action);
      return {
        receipt: { id: "receipt-1", status: "completed" },
        elapsedMs: 80,
        response: {},
      };
    }
  }();
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

function homeOcr(): VisionOcrResult {
  const labels = [
    ["ObscureApp", 90, 260], ["Two", 270, 260],
    ["Three", 450, 260], ["Four", 630, 260],
    ["Five", 90, 520], ["Six", 270, 520],
    ["Seven", 450, 520], ["Eight", 630, 520],
  ] as const;
  return ocr(labels);
}

function appOcr(): VisionOcrResult {
  return ocr([["Welcome", 360, 200], ["Continue", 360, 1_200]] as const);
}

function popupOcr(): VisionOcrResult {
  return ocr([
    ["App Would Like to Send You Notifications", 360, 570],
    ["Notifications may include alerts and sounds", 360, 660],
    ["Don't Allow", 240, 820],
    ["Allow", 480, 820],
  ] as const);
}

function ocr(labels: ReadonlyArray<readonly [string, number, number]>): VisionOcrResult {
  return {
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 12,
    items: labels.map(([text, centerX, centerY]) => ({
      text,
      confidence: 0.95,
      left: centerX - 45,
      top: centerY - 10,
      width: 90,
      height: 20,
      centerX,
      centerY,
    })),
  };
}

function homeObservation(): ScreenObservation {
  const labels = [
    ["ObscureApp", 90, 260], ["Two", 270, 260],
    ["Three", 450, 260], ["Four", 630, 260],
    ["Five", 90, 520], ["Six", 270, 520],
    ["Seven", 450, 520], ["Eight", 630, 520],
  ] as const;
  return {
    sequence: 10,
    capturedAt: Date.now(),
    viewport: { width: 720, height: 1_560 },
    fingerprint: "home",
    changeRatio: null,
    changeKind: "first",
    ocrCacheHit: false,
    ocrElapsedMs: 20,
    observationElapsedMs: 25,
    averageTextConfidence: 0.95,
    textSignature: new Set(labels.map(([text]) => text.toLocaleLowerCase("en-US"))),
    elements: labels.map(([text, x, y], index) => ({
      id: `text-${index}`,
      role: "text",
      text,
      confidence: 0.95,
      center: { x, y },
      bounds: { left: x - 45, top: y - 10, width: 90, height: 20 },
    })),
    scene: {
      kind: "home_grid",
      confidence: 0.8,
      homeGridScore: 0.8,
      keyboardVisible: false,
    },
  };
}

function textElement(text: string, x: number, y: number) {
  return {
    id: `text-${text.toLocaleLowerCase("en-US").replace(/\s+/g, "-")}`,
    role: "text" as const,
    text,
    confidence: 0.95,
    center: { x, y },
    bounds: { left: x - 45, top: y - 10, width: 90, height: 20 },
  };
}

function modelProposal(
  overrides: Partial<VisionModelProposal> & Pick<VisionModelProposal, "operation" | "confidence" | "rationale">,
): VisionModelProposal {
  return {
    target: null,
    text: null,
    x: null,
    y: null,
    startX: null,
    startY: null,
    endX: null,
    endY: null,
    durationMs: null,
    ...overrides,
  };
}
