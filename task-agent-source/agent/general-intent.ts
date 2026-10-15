import type { ScreenHandPoint, ScreenHandViewport } from "./action-contract";
import {
  keyboardUsesNonLatinInput,
  locateVisibleText,
  requestedClickTarget,
  requestedSwipe,
  requestedTextInput,
} from "./fast-intent";
import { requestedHomeApp } from "./fast-vision";
import type {
  GeneralAgentIntent,
  ScreenObservation,
  VisualAffordanceDescriptor,
} from "./general-agent-contract";
import type { VisionOcrResult } from "./vision-ocr";

export type LocatedTarget = {
  label: string;
  point: ScreenHandPoint;
  confidence: number;
};

export function interpretGeneralGoal(goal: string): GeneralAgentIntent {
  const normalized = goal.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  if (/^(?:请)?(?:返回|后退|退回|返回上一页|go back|back)(?:吧)?[。.!]?$/u.test(normalized)) {
    return { type: "navigate", key: "back" };
  }
  if (
    /^(?:请)?(?:(?:返回|回到|退回)(?:手机)?(?:的)?(?:首页|主屏幕)|(?:手机)?主屏幕|home|go home)(?:吧)?[。.!]?$/u
      .test(normalized)
  ) {
    return { type: "navigate", key: "home" };
  }
  if (/^(?:回车|确认|enter|press enter)$/u.test(normalized)) {
    return { type: "navigate", key: "enter" };
  }
  const textInput = requestedTextInput(goal);
  if (textInput) return { type: "input_text", ...textInput };
  const appName = requestedHomeApp(goal);
  if (appName) return { type: "open_app", appName };
  const affordance = parseVisualAffordanceDescriptor(goal, true);
  if (affordance) return { type: "tap_affordance", descriptor: affordance };
  const clickTarget = requestedClickTarget(goal);
  if (clickTarget) return { type: "tap_text", text: clickTarget };
  const swipe = requestedSwipe(goal, { width: 1_000, height: 1_000 });
  if (swipe) {
    const direction = swipe.name === "scroll down" ? "down"
      : swipe.name === "scroll up" ? "up"
      : swipe.name === "swipe left" ? "left"
      : "right";
    return { type: "scroll", direction };
  }
  return {
    type: "unknown",
    reason: "The local fast planner could not map this goal to a safe visual primitive.",
  };
}

export function parseVisualAffordanceDescriptor(
  value: string,
  requireTapVerb = false,
): VisualAffordanceDescriptor | null {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  if (
    requireTapVerb &&
    !/(?:点击|轻触|点按|按下|tap|click|press)/u.test(normalized)
  ) return null;
  const relativeTo = requestedRelativeAnchor(normalized);
  const symbol = relativeTo ? null : requestedVisualSymbol(normalized);
  const role: VisualAffordanceDescriptor["role"] | null = symbol
    ? "icon"
    : /(?:图标|icon|symbol)/u.test(normalized)
      ? "icon"
      : /(?:按钮|button)/u.test(normalized)
        ? "button"
        : /(?:控件|control|affordance)/u.test(normalized)
          ? "control"
          : null;
  if (!role) return null;
  const horizontal: VisualAffordanceDescriptor["horizontal"] = relativeTo
    ? null
    : /(?:左|left)/u.test(normalized)
    ? "left"
    : /(?:右|right)/u.test(normalized)
      ? "right"
      : /(?:水平)?(?:中间|中央|居中|center|centre)/u.test(normalized)
        ? "center"
        : null;
  const vertical: VisualAffordanceDescriptor["vertical"] = relativeTo
    ? null
    : /(?:顶部|上方|上面|上角|top)/u.test(normalized)
    ? "top"
    : /(?:底部|下方|下面|下角|bottom)/u.test(normalized)
      ? "bottom"
      : /(?:垂直)?(?:中间|中央|居中|middle)/u.test(normalized)
        ? "middle"
        : null;
  if (!horizontal && !vertical && !symbol && !relativeTo) return null;
  return {
    role,
    horizontal,
    vertical,
    ...(symbol ? { symbol } : {}),
    ...(relativeTo ? { relativeTo } : {}),
  };
}

export function locateVisualAffordance(
  descriptor: VisualAffordanceDescriptor,
  observation: ScreenObservation,
): LocatedTarget | null {
  const graph = observation.sceneGraph;
  if (!graph) return null;
  const roles = descriptor.symbol
    ? new Set(["icon", "navigation", "app_icon", "button", "control"])
    : descriptor.role === "icon"
      ? new Set(["icon", "navigation", "app_icon"])
      : descriptor.role === "button"
        ? new Set(["button", "control"])
        : new Set(["icon", "navigation", "button", "control", "input"]);
  const expectedX = descriptor.horizontal === "left" ? 0.14
    : descriptor.horizontal === "right" ? 0.86
      : 0.5;
  const expectedY = descriptor.vertical === "top" ? 0.1
    : descriptor.vertical === "bottom" ? 0.9
      : 0.5;
  const relationScores = descriptor.relativeTo
    ? relatedTargetScores(descriptor.relativeTo, graph)
    : null;
  if (descriptor.relativeTo && !relationScores) return null;
  const candidates = graph.nodes
    .filter((node) =>
      node.interactive &&
      roles.has(node.role) &&
      (!descriptor.symbol || normalize(node.label) === descriptor.symbol) &&
      (!relationScores || relationScores.has(node.id))
    )
    .map((node) => {
      const x = node.interactionPoint.x / Math.max(1, observation.viewport.width);
      const y = node.interactionPoint.y / Math.max(1, observation.viewport.height);
      const horizontalMatch = descriptor.horizontal === null ||
        descriptor.horizontal === "left" && x <= 0.42 ||
        descriptor.horizontal === "right" && x >= 0.58 ||
        descriptor.horizontal === "center" && x >= 0.3 && x <= 0.7;
      const verticalMatch = descriptor.vertical === null ||
        descriptor.vertical === "top" && y <= 0.34 ||
        descriptor.vertical === "bottom" && y >= 0.66 ||
        descriptor.vertical === "middle" && y >= 0.3 && y <= 0.7;
      const distance = Math.hypot(
        descriptor.horizontal === null ? 0 : x - expectedX,
        descriptor.vertical === null ? 0 : y - expectedY,
      );
      const visualBonus = node.label.startsWith("unlabeled ") ? 0.1 : 0;
      const stabilityBonus = Math.min(0.05, Math.max(0, node.seenCount - 1) * 0.02);
      return {
        node,
        matched: horizontalMatch && verticalMatch,
        score: node.confidence + visualBonus + stabilityBonus - distance * 0.32 +
          (relationScores?.get(node.id) ?? 0) * 0.24,
      };
    })
    .filter((candidate) => candidate.matched && candidate.node.confidence >= 0.5)
    .sort((left, right) => right.score - left.score ||
      right.node.confidence - left.node.confidence);
  const selected = candidates[0]?.node;
  if (
    (descriptor.symbol || descriptor.relativeTo) && candidates[1] &&
    candidates[1].score >= candidates[0].score - 0.08
  ) return null;
  return selected ? {
    label: selected.label,
    point: { ...selected.interactionPoint },
    confidence: Math.min(0.99, selected.confidence + (selected.seenCount >= 2 ? 0.03 : 0)),
  } : null;
}

function requestedRelativeAnchor(
  value: string,
): VisualAffordanceDescriptor["relativeTo"] | null {
  const english = value.match(
    /(?:icon|symbol|button|control)\s+(?:to\s+the\s+)?(left|right|above|below)\s+of\s+["“”']?([^"“”']+?)["“”']?(?:[。.!])?$/u,
  );
  if (english) {
    const label = cleanRelativeAnchor(english[2]);
    if (label) return { label, relation: relationName(english[1]) };
  }
  const chinese = value.match(
    /(?:请)?(?:点击|轻触|点按|按下)?\s*["“”']?(.{1,48}?)["“”']?\s*(左边|左侧|右边|右侧|上方|上面|下方|下面)(?:的)?\s*(?:图标|按钮|控件)/u,
  );
  if (!chinese) return null;
  const label = cleanRelativeAnchor(chinese[1]);
  return label ? { label, relation: relationName(chinese[2]) } : null;
}

function cleanRelativeAnchor(value: string) {
  return value
    .replace(/^(?:please|the|请|这个|该)\s*/u, "")
    .replace(/["“”'。.!]+$/u, "")
    .trim();
}

function relationName(value: string) {
  if (/^(?:left|左)/u.test(value)) return "left_of" as const;
  if (/^(?:right|右)/u.test(value)) return "right_of" as const;
  if (/^(?:above|上)/u.test(value)) return "above" as const;
  return "below" as const;
}

function relatedTargetScores(
  relativeTo: NonNullable<VisualAffordanceDescriptor["relativeTo"]>,
  graph: NonNullable<ScreenObservation["sceneGraph"]>,
) {
  const requested = normalize(relativeTo.label);
  const anchors = graph.nodes
    .map((node) => {
      const label = normalize(node.label);
      const exact = label === requested;
      const contains = requested.length >= 3 &&
        (label.includes(requested) || requested.includes(label));
      return {
        node,
        matched: exact || contains,
        score: (exact ? 1 : contains ? 0.76 : 0) + node.confidence * 0.1,
      };
    })
    .filter((candidate) => candidate.matched && candidate.node.confidence >= 0.35)
    .sort((left, right) => right.score - left.score);
  if (!anchors.length) return null;
  if (anchors[1] && anchors[1].score >= anchors[0].score - 0.08) return null;
  const anchorId = anchors[0].node.id;
  const scores = new Map<string, number>();
  for (const relation of graph.relations) {
    if (
      relation.kind !== relativeTo.relation ||
      relation.toNodeId !== anchorId
    ) continue;
    scores.set(
      relation.fromNodeId,
      Math.max(scores.get(relation.fromNodeId) ?? 0, relation.confidence),
    );
  }
  return scores.size ? scores : null;
}

function requestedVisualSymbol(value: string) {
  if (
    /(?:(?:关闭|close|dismiss)[\s_-]*(?:的)?[\s_-]*(?:x|×|叉号|图标|icon)|(?:x|×|叉号)[\s_-]*(?:图标|icon|按钮|button)?)/u
      .test(value)
  ) return "close" as const;
  if (
    /(?:返回|后退|back)[\s_-]*(?:的)?[\s_-]*(?:箭头|图标|arrow|chevron|icon)/u.test(value)
  ) return "back" as const;
  if (/(?:加号|新增图标|plus[\s_-]*(?:sign|icon)|add[\s_-]+icon)/u.test(value)) {
    return "add" as const;
  }
  if (
    /(?:(?:搜索|search)[\s_-]*(?:的)?[\s_-]*(?:图标|icon|symbol)|放大镜(?:图标)?|magnifying[\s_-]*glass(?:[\s_-]*icon)?)/u
      .test(value)
  ) return "search" as const;
  return null;
}

export function locateTextInObservation(
  target: string,
  observation: ScreenObservation,
): LocatedTarget | null {
  const semantic = locateSemanticNode(target, observation, [
    "button", "input", "navigation", "text",
  ]);
  if (semantic) return semantic;
  const ocr = observationAsOcr(observation);
  const match = locateVisibleText(target, ocr, observation.viewport);
  return match ? {
    label: match.recognizedLabel,
    point: match.point,
    confidence: match.confidence,
  } : null;
}

export function observationUsesNonLatinKeyboard(observation: ScreenObservation) {
  return observation.scene.keyboardVisible &&
    keyboardUsesNonLatinInput(observationAsOcr(observation));
}

/**
 * Finds an app icon without an app allowlist. Home screens arrange short labels
 * in repeated rows beneath similarly sized icons, so the target label and grid
 * geometry are enough to infer the icon center above it.
 */
export function locateAppIcon(
  appName: string,
  observation: ScreenObservation,
): LocatedTarget | null {
  if (observation.scene.homeGridScore < 0.42) return null;
  const semantic = locateSemanticNode(appName, observation, ["app_icon"]);
  if (semantic) return semantic;
  const label = locateTextInObservation(appName, observation);
  if (!label) return null;
  const matchingElement = observation.elements
    .filter((element) => normalize(element.text) === normalize(label.label))
    .sort((left, right) => right.confidence - left.confidence)[0];
  const labelHeight = matchingElement?.bounds.height ?? observation.viewport.height * 0.018;
  const offset = Math.max(
    observation.viewport.height * 0.045,
    Math.min(observation.viewport.height * 0.075, labelHeight * 3.6),
  );
  return {
    label: label.label,
    confidence: Math.min(label.confidence, observation.scene.homeGridScore),
    point: {
      x: clamp(label.point.x, 0, observation.viewport.width),
      y: clamp(label.point.y - offset, 0, observation.viewport.height),
    },
  };
}

export function locateSemanticNode(
  target: string,
  observation: ScreenObservation,
  roles?: ReadonlyArray<NonNullable<ScreenObservation["sceneGraph"]>["nodes"][number]["role"]>,
): LocatedTarget | null {
  const requested = normalize(target);
  if (requested.length < 2 || !observation.sceneGraph) return null;
  const allowed = roles ? new Set(roles) : null;
  const candidates = observation.sceneGraph.nodes
    .filter((node) => !allowed || allowed.has(node.role))
    .map((node) => {
      const label = normalize(node.label);
      const exact = label === requested;
      const contains = requested.length >= 4 && (label.includes(requested) || requested.includes(label));
      const token = node.normalizedLabel.split(/\s+/u).some((part) => normalize(part) === requested);
      const roleScore = node.interactive ? 0.08 : 0;
      const stabilityScore = Math.min(0.06, Math.max(0, node.seenCount - 1) * 0.02);
      return {
        node,
        matched: exact || contains || token,
        score: (exact ? 1 : token ? 0.9 : contains ? 0.76 : 0) + roleScore + stabilityScore,
      };
    })
    .filter((candidate) => candidate.matched && candidate.node.confidence >= 0.35)
    .sort((left, right) => right.score - left.score || right.node.confidence - left.node.confidence);
  const selected = candidates[0]?.node;
  return selected ? {
    label: selected.label,
    point: { ...selected.interactionPoint },
    confidence: Math.min(0.99, selected.confidence + Math.min(0.04, selected.seenCount * 0.01)),
  } : null;
}

export function swipePoints(
  direction: "down" | "up" | "left" | "right",
  viewport: ScreenHandViewport,
) {
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.52;
  if (direction === "down") {
    return {
      start: { x: centerX, y: viewport.height * 0.76 },
      end: { x: centerX, y: viewport.height * 0.28 },
    };
  }
  if (direction === "up") {
    return {
      start: { x: centerX, y: viewport.height * 0.28 },
      end: { x: centerX, y: viewport.height * 0.76 },
    };
  }
  if (direction === "left") {
    return {
      start: { x: viewport.width * 0.78, y: centerY },
      end: { x: viewport.width * 0.22, y: centerY },
    };
  }
  return {
    start: { x: viewport.width * 0.22, y: centerY },
    end: { x: viewport.width * 0.78, y: centerY },
  };
}

function observationAsOcr(observation: ScreenObservation): VisionOcrResult {
  return {
    ok: true,
    imageWidth: observation.viewport.width,
    imageHeight: observation.viewport.height,
    elapsedMs: observation.ocrElapsedMs,
    items: observation.elements.map((element) => ({
      text: element.text,
      confidence: element.confidence,
      left: element.bounds.left,
      top: element.bounds.top,
      width: element.bounds.width,
      height: element.bounds.height,
      centerX: element.center.x,
      centerY: element.center.y,
    })),
  };
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
