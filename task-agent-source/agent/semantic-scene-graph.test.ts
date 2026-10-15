import assert from "node:assert/strict";
import test from "node:test";

import { SemanticSceneGraphTracker } from "./semantic-scene-graph";

test("keeps semantic node identities stable across small camera movement", () => {
  const tracker = new SemanticSceneGraphTracker();
  const first = tracker.update(input(10, [
    ["Search", 330, 120],
    ["Work", 180, 360],
    ["Home", 90, 1_500],
    ["Profile", 630, 1_500],
  ]));
  const second = tracker.update(input(11, [
    ["Search", 333, 122],
    ["Work", 184, 362],
    ["Home", 92, 1_499],
    ["Profile", 628, 1_499],
  ], [{ left: 120, top: 300, width: 180, height: 160, score: 0.4 }]));
  const firstWork = first.nodes.find((node) => node.label === "Work");
  const secondWork = second.nodes.find((node) => node.label === "Work");
  assert.ok(firstWork && secondWork);
  assert.equal(secondWork.id, firstWork.id);
  assert.equal(secondWork.seenCount, 2);
  assert.ok(second.changedNodeIds.includes(secondWork.id));
});

test("infers platform-neutral controls, scroll regions, and popup overlays", () => {
  const tracker = new SemanticSceneGraphTracker();
  const graph = tracker.update(input(20, [
    ["App Would Like to Send You Notifications", 360, 520],
    ["Don't Allow", 230, 820],
    ["Allow", 490, 820],
    ["Detail one", 200, 330],
    ["Detail two", 200, 620],
    ["Detail three", 200, 1_050],
    ["Home", 90, 1_500],
    ["Profile", 630, 1_500],
  ]));
  assert.equal(graph.overlay.active, true);
  assert.ok(graph.nodes.some((node) => node.role === "button" && node.label === "Allow"));
  assert.ok(graph.nodes.some((node) => node.role === "navigation" && node.label === "Home"));
  assert.ok(graph.nodes.some((node) => node.role === "scroll_region"));
});

test("projects a Home label to the physical center of its app icon", () => {
  const tracker = new SemanticSceneGraphTracker();
  const graph = tracker.update({
    ...input(30, [["ObscureApp", 90, 260]]),
    scene: { kind: "home_grid", keyboardVisible: false },
  });
  const app = graph.nodes.find((node) => node.role === "app_icon");
  assert.ok(app);
  assert.equal(app.interactionPoint.x, 90);
  assert.ok(app.interactionPoint.y < 260);
});

test("tracks a provider-neutral unlabeled icon across camera movement", () => {
  const tracker = new SemanticSceneGraphTracker();
  const first = tracker.update({
    ...input(40, []),
    visualAffordances: [affordance(640, 110)],
  });
  const second = tracker.update({
    ...input(41, []),
    visualAffordances: [affordance(644, 112)],
  });
  const firstIcon = first.nodes.find((node) => node.role === "navigation");
  const secondIcon = second.nodes.find((node) => node.role === "navigation");
  assert.ok(firstIcon && secondIcon);
  assert.equal(secondIcon.id, firstIcon.id);
  assert.equal(secondIcon.seenCount, 2);
  assert.equal(secondIcon.interactive, true);
});

test("does not duplicate a labeled button with its visual outline", () => {
  const graph = new SemanticSceneGraphTracker().update({
    ...input(50, [["Continue", 360, 1_180]]),
    visualAffordances: [{
      ...affordance(360, 1_180),
      role: "control",
      label: "unlabeled bottom-center control",
      bounds: { left: 170, top: 1_130, width: 380, height: 100 },
    }],
  });
  assert.equal(graph.nodes.filter((node) => node.interactive).length, 1);
  assert.ok(graph.nodes.some((node) => node.role === "button" && node.label === "Continue"));
});

test("builds bounded container and directional relations from visible geometry", () => {
  const graph = new SemanticSceneGraphTracker().update({
    ...input(60, [
      ["Search", 340, 120],
      ["Result title", 300, 430],
      ["Result details", 300, 700],
      ["More information", 300, 970],
      ["Another row", 300, 1_180],
      ["Final row", 300, 1_290],
    ]),
    visualAffordances: [affordance(640, 120)],
  });
  const search = graph.nodes.find((node) => node.label === "Search");
  const icon = graph.nodes.find((node) => node.label.startsWith("unlabeled"));
  const scroll = graph.nodes.find((node) => node.role === "scroll_region");
  const result = graph.nodes.find((node) => node.label === "Result details");
  assert.ok(search && icon && scroll && result);
  assert.ok(graph.relations.some((relation) =>
    relation.kind === "right_of" &&
    relation.fromNodeId === icon.id &&
    relation.toNodeId === search.id
  ));
  assert.ok(graph.relations.some((relation) =>
    relation.kind === "contains" &&
    relation.fromNodeId === scroll.id &&
    relation.toNodeId === result.id
  ));
});

test("does not promote Home app artwork into a visual symbol control", () => {
  const tracker = new SemanticSceneGraphTracker();
  const homeSearchLookalike = {
    ...affordance(610, 170),
    label: "search",
    symbol: "search" as const,
    symbolConfidence: 0.91,
  };
  const graph = tracker.update({
    ...input(70, [["Home", 540, 250]]),
    scene: { kind: "home_grid", keyboardVisible: false },
    visualAffordances: [homeSearchLookalike],
  });
  assert.equal(graph.nodes.some((node) => node.label === "search"), false);

  const bottomSystemSearch = tracker.update({
    ...input(71, [["Home", 540, 250]]),
    scene: { kind: "home_grid", keyboardVisible: false },
    visualAffordances: [{
      ...homeSearchLookalike,
      center: { x: 360, y: 1_300 },
      bounds: { left: 320, top: 1_270, width: 80, height: 60 },
    }],
  });
  assert.ok(bottomSystemSearch.nodes.some((node) => node.label === "search"));
});

function input(
  sequence: number,
  labels: Array<[string, number, number]>,
  changedRegions: Array<{ left: number; top: number; width: number; height: number; score: number }> = [],
) {
  return {
    sequence,
    fingerprint: `frame-${sequence}`,
    viewport: { width: 720, height: 1_560 },
    scene: { kind: "text_ui", keyboardVisible: false },
    elements: labels.map(([text, x, y]) => ({
      text,
      confidence: 0.95,
      center: { x, y },
      bounds: { left: x - 70, top: y - 16, width: 140, height: 32 },
    })),
    changedRegions,
  };
}

function affordance(x: number, y: number) {
  return {
    role: "navigation" as const,
    label: "unlabeled top-right navigation",
    confidence: 0.88,
    center: { x, y },
    bounds: { left: x - 32, top: y - 32, width: 64, height: 64 },
    source: "local_edges" as const,
    edgeDensity: 0.28,
    localContrast: 70,
  };
}
