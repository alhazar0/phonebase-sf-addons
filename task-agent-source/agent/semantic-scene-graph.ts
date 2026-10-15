import type { ScreenHandPoint, ScreenHandViewport } from "./action-contract";
import type { VisualChangeRegion } from "./frame-delta";
import type { VisualAffordance } from "./visual-affordance-detector";

export type SemanticNodeRole =
  | "text"
  | "button"
  | "input"
  | "navigation"
  | "app_icon"
  | "icon"
  | "control"
  | "container"
  | "scroll_region"
  | "overlay"
  | "keyboard";

export type SemanticSceneNode = {
  id: string;
  role: SemanticNodeRole;
  label: string;
  normalizedLabel: string;
  confidence: number;
  interactive: boolean;
  center: ScreenHandPoint;
  interactionPoint: ScreenHandPoint;
  bounds: { left: number; top: number; width: number; height: number };
  firstSeenSequence: number;
  lastSeenSequence: number;
  seenCount: number;
};

export type SemanticSceneRelationKind =
  | "contains"
  | "left_of"
  | "right_of"
  | "above"
  | "below";

export type SemanticSceneRelation = {
  kind: SemanticSceneRelationKind;
  fromNodeId: string;
  toNodeId: string;
  confidence: number;
};

export type SemanticSceneGraph = {
  version: "2026-09-01";
  revision: number;
  sequence: number;
  fingerprint: string;
  viewport: ScreenHandViewport;
  nodes: SemanticSceneNode[];
  relations: SemanticSceneRelation[];
  changedNodeIds: string[];
  changedRegions: VisualChangeRegion[];
  overlay: {
    active: boolean;
    confidence: number;
    nodeId: string | null;
    reason: string;
  };
};

export type SceneGraphInput = {
  sequence: number;
  fingerprint: string;
  viewport: ScreenHandViewport;
  scene: {
    kind: string;
    keyboardVisible: boolean;
  };
  elements: Array<{
    text: string;
    confidence: number;
    center: ScreenHandPoint;
    bounds: { left: number; top: number; width: number; height: number };
  }>;
  changedRegions?: VisualChangeRegion[];
  visualAffordances?: VisualAffordance[];
};

/**
 * Builds a small provider-neutral UI graph from visible camera evidence. OCR
 * remains the source of labels; geometry supplies roles and stable identities.
 * No application name or platform accessibility tree is required.
 */
export class SemanticSceneGraphTracker {
  private revision = 0;
  private nextNodeId = 1;
  private previous: SemanticSceneNode[] = [];

  update(input: SceneGraphInput): SemanticSceneGraph {
    this.revision += 1;
    const inferred = inferNodes(input);
    const available = new Set(this.previous.map((node) => node.id));
    const changedNodeIds: string[] = [];
    const nodes = inferred.map((candidate) => {
      const match = bestPreviousNode(candidate, this.previous, available, input.viewport);
      if (match) available.delete(match.id);
      const node: SemanticSceneNode = match ? {
        ...candidate,
        id: match.id,
        firstSeenSequence: match.firstSeenSequence,
        lastSeenSequence: input.sequence,
        seenCount: match.seenCount + 1,
      } : {
        ...candidate,
        id: `scene-node-${String(this.nextNodeId++).padStart(5, "0")}`,
        firstSeenSequence: input.sequence,
        lastSeenSequence: input.sequence,
        seenCount: 1,
      };
      if (!match || nodeChanged(match, node, input.changedRegions ?? [], input.viewport)) {
        changedNodeIds.push(node.id);
      }
      return node;
    });
    this.previous = nodes.map(cloneNode);
    const relations = inferRelations(nodes, input.viewport);
    const overlayNode = nodes.find((node) => node.role === "overlay") ?? null;
    return {
      version: "2026-09-01",
      revision: this.revision,
      sequence: input.sequence,
      fingerprint: input.fingerprint,
      viewport: { ...input.viewport },
      nodes,
      relations,
      changedNodeIds,
      changedRegions: (input.changedRegions ?? []).map((region) => ({ ...region })),
      overlay: overlayNode ? {
        active: true,
        confidence: overlayNode.confidence,
        nodeId: overlayNode.id,
        reason: overlayNode.label,
      } : {
        active: false,
        confidence: 0,
        nodeId: null,
        reason: "No popup or modal evidence was found.",
      },
    };
  }

  reset() {
    this.revision = 0;
    this.nextNodeId = 1;
    this.previous = [];
  }
}

function inferRelations(
  nodes: SemanticSceneNode[],
  viewport: ScreenHandViewport,
): SemanticSceneRelation[] {
  const relations: SemanticSceneRelation[] = [];
  const structuralRoles = new Set<SemanticNodeRole>([
    "container", "scroll_region", "overlay", "keyboard",
  ]);
  for (const parent of nodes.filter((node) => structuralRoles.has(node.role))) {
    const horizontalPadding = viewport.width * 0.025;
    const verticalPadding = viewport.height * 0.018;
    const expanded = {
      left: Math.max(0, parent.bounds.left - horizontalPadding),
      top: Math.max(0, parent.bounds.top - verticalPadding),
      width: Math.min(
        viewport.width,
        parent.bounds.left + parent.bounds.width + horizontalPadding,
      ) - Math.max(0, parent.bounds.left - horizontalPadding),
      height: Math.min(
        viewport.height,
        parent.bounds.top + parent.bounds.height + verticalPadding,
      ) - Math.max(0, parent.bounds.top - verticalPadding),
    };
    for (const child of nodes) {
      if (child.id === parent.id || structuralRoles.has(child.role)) continue;
      const overlap = boundsIntersectionArea(expanded, child.bounds);
      const childArea = Math.max(1, child.bounds.width * child.bounds.height);
      const centerInside = pointInsideBounds(child.center, expanded);
      if (!centerInside && overlap / childArea < 0.55) continue;
      relations.push({
        kind: "contains",
        fromNodeId: parent.id,
        toNodeId: child.id,
        confidence: round(Math.min(
          parent.confidence,
          child.confidence,
          0.72 + 0.24 * Math.min(1, overlap / childArea),
        )),
      });
    }
  }

  const spatial = nodes.filter((node) => !structuralRoles.has(node.role));
  for (const from of spatial) {
    for (const to of spatial) {
      if (from.id === to.id || (!from.interactive && !to.interactive)) continue;
      const deltaX = to.center.x - from.center.x;
      const deltaY = to.center.y - from.center.y;
      const horizontalAlignmentLimit = Math.max(
        viewport.height * 0.035,
        (from.bounds.height + to.bounds.height) * 1.25,
      );
      const verticalAlignmentLimit = Math.max(
        viewport.width * 0.055,
        (from.bounds.width + to.bounds.width) * 0.72,
      );
      if (
        Math.abs(deltaX) >= viewport.width * 0.025 &&
        Math.abs(deltaX) <= viewport.width * 0.62 &&
        Math.abs(deltaY) <= horizontalAlignmentLimit
      ) {
        const confidence = directionalRelationConfidence(
          Math.abs(deltaX),
          Math.abs(deltaY),
          viewport.width * 0.62,
          horizontalAlignmentLimit,
          from,
          to,
        );
        if (confidence >= 0.55) {
          relations.push({
            kind: deltaX > 0 ? "left_of" : "right_of",
            fromNodeId: from.id,
            toNodeId: to.id,
            confidence,
          });
        }
      }
      if (
        Math.abs(deltaY) >= viewport.height * 0.018 &&
        Math.abs(deltaY) <= viewport.height * 0.48 &&
        Math.abs(deltaX) <= verticalAlignmentLimit
      ) {
        const confidence = directionalRelationConfidence(
          Math.abs(deltaY),
          Math.abs(deltaX),
          viewport.height * 0.48,
          verticalAlignmentLimit,
          from,
          to,
        );
        if (confidence >= 0.55) {
          relations.push({
            kind: deltaY > 0 ? "above" : "below",
            fromNodeId: from.id,
            toNodeId: to.id,
            confidence,
          });
        }
      }
    }
  }
  return relations
    .sort((left, right) =>
      right.confidence - left.confidence ||
      left.kind.localeCompare(right.kind) ||
      left.fromNodeId.localeCompare(right.fromNodeId) ||
      left.toNodeId.localeCompare(right.toNodeId)
    )
    .slice(0, 512)
    .sort((left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.fromNodeId.localeCompare(right.fromNodeId) ||
      left.toNodeId.localeCompare(right.toNodeId)
    );
}

function directionalRelationConfidence(
  primaryDistance: number,
  alignmentDistance: number,
  primaryLimit: number,
  alignmentLimit: number,
  from: SemanticSceneNode,
  to: SemanticSceneNode,
) {
  const proximity = 1 - Math.min(1, primaryDistance / Math.max(1, primaryLimit));
  const alignment = 1 - Math.min(1, alignmentDistance / Math.max(1, alignmentLimit));
  const evidence = Math.min(from.confidence, to.confidence);
  return round(0.34 * proximity + 0.42 * alignment + 0.24 * evidence);
}

function pointInsideBounds(
  point: ScreenHandPoint,
  bounds: { left: number; top: number; width: number; height: number },
) {
  return point.x >= bounds.left && point.x <= bounds.left + bounds.width &&
    point.y >= bounds.top && point.y <= bounds.top + bounds.height;
}

function boundsIntersectionArea(
  left: { left: number; top: number; width: number; height: number },
  right: { left: number; top: number; width: number; height: number },
) {
  const width = Math.max(0, Math.min(
    left.left + left.width,
    right.left + right.width,
  ) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(
    left.top + left.height,
    right.top + right.height,
  ) - Math.max(left.top, right.top));
  return width * height;
}

type InferredNode = Omit<SemanticSceneNode, "id" | "firstSeenSequence" | "lastSeenSequence" | "seenCount">;

function inferNodes(input: SceneGraphInput): InferredNode[] {
  const { viewport } = input;
  const overlayEvidence = detectOverlayEvidence(input.elements);
  const nodes = input.elements
    .filter((element) => element.text.trim() && element.confidence >= 0.25)
    .map((element): InferredNode => {
      const label = element.text.trim();
      const role = inferElementRole(label, element.center, input);
      const interactionPoint = role === "app_icon"
        ? {
            x: element.center.x,
            y: Math.max(0, element.center.y - Math.max(
              viewport.height * 0.045,
              Math.min(viewport.height * 0.075, element.bounds.height * 3.6),
            )),
          }
        : { ...element.center };
      return {
        role,
        label,
        normalizedLabel: normalize(label),
        confidence: round(element.confidence),
        interactive: ["button", "input", "navigation", "app_icon"].includes(role),
        center: { ...element.center },
        interactionPoint,
        bounds: { ...element.bounds },
      };
    });

  for (const affordance of input.visualAffordances ?? []) {
    if (
      affordance.confidence < 0.5 ||
      homeGridArtworkSymbol(affordance, input, overlayEvidence !== null) ||
      visualAffordanceDuplicatesNode(affordance, nodes, viewport)
    ) continue;
    nodes.push({
      role: affordance.role,
      label: affordance.label,
      normalizedLabel: normalize(affordance.label),
      confidence: round(affordance.confidence),
      interactive: true,
      center: { ...affordance.center },
      interactionPoint: { ...affordance.center },
      bounds: { ...affordance.bounds },
    });
  }

  const topElements = input.elements.filter((element) => element.center.y <= viewport.height * 0.17);
  if (topElements.length >= 2) {
    nodes.push(structuralNode("container", "top toolbar", enclosingBounds(topElements, viewport), 0.76));
  }
  const bottomNavigation = nodes.filter((node) =>
    node.role === "navigation" && node.center.y >= viewport.height * 0.82
  );
  if (bottomNavigation.length >= 2) {
    nodes.push(structuralNode(
      "container",
      "bottom navigation",
      enclosingNodeBounds(bottomNavigation, viewport),
      0.9,
    ));
  }
  const contentElements = input.elements.filter((element) =>
    element.center.y >= viewport.height * 0.17 && element.center.y <= viewport.height * 0.84
  );
  if (contentElements.length >= 5 && verticalSpread(contentElements) >= viewport.height * 0.28) {
    const bounds = enclosingBounds(contentElements, viewport);
    nodes.push(structuralNode("scroll_region", "primary scroll region", bounds, 0.78));
  }
  if (input.scene.keyboardVisible) {
    nodes.push(structuralNode("keyboard", "visible keyboard", {
      left: 0,
      top: viewport.height * 0.58,
      width: viewport.width,
      height: viewport.height * 0.42,
    }, 0.96));
  }
  if (overlayEvidence) {
    const central = input.elements.filter((element) =>
      element.center.y >= viewport.height * 0.16 && element.center.y <= viewport.height * 0.92
    );
    nodes.push(structuralNode(
      "overlay",
      overlayEvidence.label,
      central.length ? enclosingBounds(central, viewport) : {
        left: viewport.width * 0.08,
        top: viewport.height * 0.2,
        width: viewport.width * 0.84,
        height: viewport.height * 0.6,
      },
      overlayEvidence.confidence,
    ));
  }
  return nodes;
}

function homeGridArtworkSymbol(
  affordance: VisualAffordance,
  input: SceneGraphInput,
  overlayVisible: boolean,
) {
  if (
    input.scene.kind !== "home_grid" ||
    overlayVisible ||
    affordance.symbol === undefined
  ) return false;
  const yRatio = affordance.center.y / Math.max(1, input.viewport.height);
  // A Home grid is made of arbitrary app artwork. Shape semantics inside that
  // artwork are not UI controls, even when a logo resembles Search, Add, Close,
  // or Back. System affordances below the grid remain eligible, and a detected
  // overlay is handled independently rather than hidden by this guard.
  return yRatio >= 0.06 && yRatio <= 0.76;
}

function visualAffordanceDuplicatesNode(
  affordance: VisualAffordance,
  nodes: InferredNode[],
  viewport: ScreenHandViewport,
) {
  const diagonal = Math.hypot(viewport.width, viewport.height);
  return nodes.some((node) => {
    if (!node.interactive) return false;
    const inside = node.interactionPoint.x >= affordance.bounds.left &&
      node.interactionPoint.x <= affordance.bounds.left + affordance.bounds.width &&
      node.interactionPoint.y >= affordance.bounds.top &&
      node.interactionPoint.y <= affordance.bounds.top + affordance.bounds.height;
    const distance = Math.hypot(
      node.interactionPoint.x - affordance.center.x,
      node.interactionPoint.y - affordance.center.y,
    );
    return inside || distance <= Math.max(
      18,
      Math.min(affordance.bounds.width, affordance.bounds.height) * 0.42,
      diagonal * 0.035,
    );
  });
}

function inferElementRole(
  label: string,
  center: ScreenHandPoint,
  input: SceneGraphInput,
): SemanticNodeRole {
  const normalized = normalize(label);
  const y = center.y / Math.max(1, input.viewport.height);
  if (input.scene.kind === "home_grid" && y >= 0.08 && y <= 0.9) return "app_icon";
  if (
    (y <= 0.17 || y >= 0.82) &&
    /^(?:back|home|search|discover|friends|inbox|profile|settings|chats|calls|contacts|next|done|cancel|返回|首页|搜索|发现|朋友|收件箱|个人资料|设置|聊天|通话|联系人|下一步|完成|取消)$/u.test(normalized)
  ) return "navigation";
  if (
    /(?:search|message|email|username|password|phone number|write a comment|add comment|搜索|消息|邮箱|用户名|密码|手机号|写评论|添加评论)/u.test(normalized) &&
    !/^(?:send|发送)$/u.test(normalized)
  ) return "input";
  if (
    /^(?:allow|don'?t allow|continue|next|done|ok|cancel|close|skip|retry|try again|send|post|publish|submit|follow|like|comment|reply|save|edit|delete|later|not now|允许|不允许|继续|下一步|完成|好|取消|关闭|跳过|重试|发送|发布|提交|关注|点赞|评论|回复|保存|编辑|删除|稍后|暂不)$/u.test(normalized)
  ) return "button";
  return "text";
}

function structuralNode(
  role: Extract<SemanticNodeRole, "container" | "scroll_region" | "overlay" | "keyboard">,
  label: string,
  bounds: { left: number; top: number; width: number; height: number },
  confidence: number,
): InferredNode {
  const center = {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  };
  return {
    role,
    label,
    normalizedLabel: normalize(label),
    confidence,
    interactive: role === "scroll_region",
    center,
    interactionPoint: { ...center },
    bounds,
  };
}

function bestPreviousNode(
  candidate: InferredNode,
  previous: SemanticSceneNode[],
  available: Set<string>,
  viewport: ScreenHandViewport,
) {
  const diagonal = Math.hypot(viewport.width, viewport.height);
  return previous
    .filter((node) => available.has(node.id) && node.role === candidate.role)
    .map((node) => {
      const labelScore = textSimilarity(node.normalizedLabel, candidate.normalizedLabel);
      const distance = Math.hypot(
        node.interactionPoint.x - candidate.interactionPoint.x,
        node.interactionPoint.y - candidate.interactionPoint.y,
      );
      const locationScore = Math.max(0, 1 - distance / Math.max(24, diagonal * 0.12));
      return { node, score: labelScore * 0.72 + locationScore * 0.28, distance };
    })
    .filter((candidate) => candidate.score >= 0.62 && candidate.distance <= diagonal * 0.12)
    .sort((left, right) => right.score - left.score || left.distance - right.distance)[0]?.node ?? null;
}

function nodeChanged(
  previous: SemanticSceneNode,
  current: SemanticSceneNode,
  regions: VisualChangeRegion[],
  viewport: ScreenHandViewport,
) {
  if (previous.normalizedLabel !== current.normalizedLabel) return true;
  if (Math.hypot(previous.center.x - current.center.x, previous.center.y - current.center.y) >
    Math.hypot(viewport.width, viewport.height) * 0.012) return true;
  return regions.some((region) => pointInside(current.center, region));
}

function detectOverlayEvidence(elements: SceneGraphInput["elements"]) {
  const text = elements.map((element) => normalize(element.text)).join(" ");
  if (!text) return null;
  if (/(?:security check|verification code|captcha|安全验证|验证码)/u.test(text)) {
    return { label: "authentication overlay", confidence: 0.98 };
  }
  const explicitDialog = /(?:would like to|allow .{0,40} to (?:access|use|track)|send you notifications|permission (?:is )?(?:required|needed)|new version|update available|rate (?:this|us)|network error|connection failed|想访问|需要.{0,20}权限|发送通知|版本更新|评分|网络错误|连接失败)/u.test(text);
  const dialogAction = /(?:don'?t allow|allow|not now|later|cancel|retry|try again|不允许|允许|暂不|稍后|取消|重试)/u.test(text);
  if (explicitDialog && dialogAction) {
    return { label: "interrupting overlay", confidence: 0.92 };
  }
  return null;
}

function enclosingBounds(
  elements: SceneGraphInput["elements"],
  viewport: ScreenHandViewport,
) {
  return boundedBounds(elements.map((element) => element.bounds), viewport);
}

function enclosingNodeBounds(nodes: InferredNode[], viewport: ScreenHandViewport) {
  return boundedBounds(nodes.map((node) => node.bounds), viewport);
}

function boundedBounds(
  bounds: Array<{ left: number; top: number; width: number; height: number }>,
  viewport: ScreenHandViewport,
) {
  const left = Math.max(0, Math.min(...bounds.map((item) => item.left)));
  const top = Math.max(0, Math.min(...bounds.map((item) => item.top)));
  const right = Math.min(viewport.width, Math.max(...bounds.map((item) => item.left + item.width)));
  const bottom = Math.min(viewport.height, Math.max(...bounds.map((item) => item.top + item.height)));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function verticalSpread(elements: SceneGraphInput["elements"]) {
  const ys = elements.map((element) => element.center.y);
  return Math.max(...ys) - Math.min(...ys);
}

function pointInside(point: ScreenHandPoint, region: VisualChangeRegion) {
  return point.x >= region.left && point.x <= region.left + region.width &&
    point.y >= region.top && point.y <= region.top + region.height;
}

function textSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

function levenshtein(left: string, right: string) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[right.length];
}

function cloneNode(node: SemanticSceneNode): SemanticSceneNode {
  return {
    ...node,
    center: { ...node.center },
    interactionPoint: { ...node.interactionPoint },
    bounds: { ...node.bounds },
  };
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[’']/g, "'")
    .replace(/[^\p{Letter}\p{Number}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
