import assert from "node:assert/strict";
import test from "node:test";

import type { ScreenObservation } from "./general-agent-contract";
import {
  interpretGeneralGoal,
  locateAppIcon,
  locateTextInObservation,
  locateVisualAffordance,
  parseVisualAffordanceDescriptor,
  swipePoints,
} from "./general-intent";
import { SemanticSceneGraphTracker } from "./semantic-scene-graph";

test("maps common Chinese and English goals to platform-neutral intents", () => {
  assert.deepEqual(interpretGeneralGoal("打开 Settings 应用"), {
    type: "open_app",
    appName: "Settings",
  });
  assert.deepEqual(interpretGeneralGoal("点击 Continue 按钮"), {
    type: "tap_text",
    text: "Continue",
  });
  assert.deepEqual(interpretGeneralGoal("向下滚动"), {
    type: "scroll",
    direction: "down",
  });
  assert.deepEqual(interpretGeneralGoal("返回首页"), {
    type: "navigate",
    key: "home",
  });
  assert.deepEqual(interpretGeneralGoal("请返回手机首页。"), {
    type: "navigate",
    key: "home",
  });
  assert.deepEqual(interpretGeneralGoal("回到手机主屏幕吧"), {
    type: "navigate",
    key: "home",
  });
  assert.equal(interpretGeneralGoal("分析这段视频为什么受欢迎").type, "unknown");
  assert.equal(
    interpretGeneralGoal("给19195525252打电话，并打开扬声器，10秒后挂掉").type,
    "unknown",
  );
  assert.deepEqual(interpretGeneralGoal("点击右上角图标"), {
    type: "tap_affordance",
    descriptor: { role: "icon", horizontal: "right", vertical: "top" },
  });
  assert.deepEqual(interpretGeneralGoal("tap the bottom-center button"), {
    type: "tap_affordance",
    descriptor: { role: "button", horizontal: "center", vertical: "bottom" },
  });
  assert.deepEqual(interpretGeneralGoal("点击关闭 X 图标"), {
    type: "tap_affordance",
    descriptor: {
      role: "icon",
      horizontal: null,
      vertical: null,
      symbol: "close",
    },
  });
  assert.deepEqual(interpretGeneralGoal("tap the back arrow"), {
    type: "tap_affordance",
    descriptor: {
      role: "icon",
      horizontal: null,
      vertical: null,
      symbol: "back",
    },
  });
  assert.deepEqual(interpretGeneralGoal("点击搜索图标"), {
    type: "tap_affordance",
    descriptor: {
      role: "icon",
      horizontal: null,
      vertical: null,
      symbol: "search",
    },
  });
  assert.deepEqual(interpretGeneralGoal("tap Search"), {
    type: "tap_text",
    text: "Search",
  });
  assert.equal(
    interpretGeneralGoal("打开 Phone，然后拨号并挂断").type,
    "unknown",
  );
});

test("grounds an unlabeled control from its explicit spatial descriptor", () => {
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
    visualAffordances: [
      visualAffordance("navigation", 650, 100),
      visualAffordance("icon", 80, 760),
    ],
  });
  const descriptor = parseVisualAffordanceDescriptor("top-right icon");
  assert.ok(descriptor);
  const target = locateVisualAffordance(descriptor, observation);
  assert.ok(target);
  assert.deepEqual(target.point, { x: 650, y: 100 });
});

test("treats a semantic Home app node as an icon for spatial grounding", () => {
  const observation = homeObservation();
  observation.sceneGraph = new SemanticSceneGraphTracker().update({
    sequence: observation.sequence,
    fingerprint: observation.fingerprint,
    viewport: observation.viewport,
    scene: observation.scene,
    elements: observation.elements,
  });
  const descriptor = parseVisualAffordanceDescriptor("top-right icon");
  assert.ok(descriptor);
  const target = locateVisualAffordance(descriptor, observation);
  assert.ok(target);
  assert.equal(target.label, "Four");
  assert.equal(target.point.x, 630);
  assert.ok(target.point.y < 260);
});

test("grounds one visual symbol and rejects two equally plausible symbols", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "text_ui",
    confidence: 0.8,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  observation.elements = [];
  const close = {
    ...visualAffordance("navigation", 650, 120),
    label: "close",
    symbol: "close" as const,
    symbolConfidence: 0.91,
  };
  observation.sceneGraph = new SemanticSceneGraphTracker().update({
    sequence: observation.sequence,
    fingerprint: observation.fingerprint,
    viewport: observation.viewport,
    scene: observation.scene,
    elements: [],
    visualAffordances: [close],
  });
  const descriptor = parseVisualAffordanceDescriptor("click the close icon");
  assert.ok(descriptor);
  assert.deepEqual(locateVisualAffordance(descriptor, observation)?.point, { x: 650, y: 120 });

  observation.sceneGraph = new SemanticSceneGraphTracker().update({
    sequence: observation.sequence + 1,
    fingerprint: `${observation.fingerprint}-ambiguous`,
    viewport: observation.viewport,
    scene: observation.scene,
    elements: [],
    visualAffordances: [
      close,
      {
        ...close,
        center: { x: 70, y: 120 },
        bounds: { left: 40, top: 90, width: 60, height: 60 },
        confidence: 0.9,
      },
    ],
  });
  assert.equal(locateVisualAffordance(descriptor, observation), null);
});

test("grounds an unlabeled control relative to visible text without global coordinates", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "text_ui",
    confidence: 0.8,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  observation.elements = [{
    text: "Search",
    confidence: 0.96,
    center: { x: 340, y: 130 },
    bounds: { left: 280, top: 110, width: 120, height: 40 },
  }];
  observation.sceneGraph = new SemanticSceneGraphTracker().update({
    sequence: observation.sequence,
    fingerprint: observation.fingerprint,
    viewport: observation.viewport,
    scene: observation.scene,
    elements: observation.elements,
    visualAffordances: [visualAffordance("navigation", 640, 130)],
  });
  const descriptor = parseVisualAffordanceDescriptor("tap the icon to the right of Search");
  assert.deepEqual(descriptor, {
    role: "icon",
    horizontal: null,
    vertical: null,
    relativeTo: { label: "search", relation: "right_of" },
  });
  assert.deepEqual(locateVisualAffordance(descriptor, observation)?.point, { x: 640, y: 130 });
  assert.deepEqual(
    parseVisualAffordanceDescriptor("点击 Search 右边的图标"),
    {
      role: "icon",
      horizontal: null,
      vertical: null,
      relativeTo: { label: "search", relation: "right_of" },
    },
  );
});

test("locates an arbitrary app icon from generic grid geometry", () => {
  const observation = homeObservation();
  const target = locateAppIcon("ObscureApp", observation);
  assert.ok(target);
  assert.equal(target.label, "ObscureApp");
  assert.equal(target.point.x, 90);
  assert.ok(target.point.y < 260);
  assert.ok(target.point.y > 150);
});

test("uses screen-relative swipe geometry", () => {
  assert.deepEqual(swipePoints("left", { width: 720, height: 1_560 }), {
    start: { x: 561.6, y: 811.2 },
    end: { x: 158.4, y: 811.2 },
  });
});

test("grounds visible controls through the stable semantic scene graph", () => {
  const observation = homeObservation();
  observation.scene = {
    kind: "text_ui",
    confidence: 0.9,
    homeGridScore: 0,
    keyboardVisible: false,
  };
  observation.elements = [{
    id: "continue",
    role: "text",
    text: "Continue",
    confidence: 0.94,
    center: { x: 510, y: 880 },
    bounds: { left: 440, top: 858, width: 140, height: 44 },
  }];
  observation.sceneGraph = new SemanticSceneGraphTracker().update({
    sequence: observation.sequence,
    fingerprint: observation.fingerprint,
    viewport: observation.viewport,
    scene: observation.scene,
    elements: observation.elements,
  });
  const target = locateTextInObservation("Continue", observation);
  assert.ok(target);
  assert.deepEqual(target.point, { x: 510, y: 880 });
  assert.ok(target.confidence >= 0.94);
});

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

function visualAffordance(role: "icon" | "navigation", x: number, y: number) {
  return {
    role,
    label: `unlabeled ${role}`,
    confidence: 0.88,
    center: { x, y },
    bounds: { left: x - 30, top: y - 30, width: 60, height: 60 },
    source: "local_edges" as const,
    edgeDensity: 0.3,
    localContrast: 70,
  };
}
