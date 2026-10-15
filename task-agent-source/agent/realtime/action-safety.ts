import type { NormalizedPoint } from "./action-scheduler";

export type RealtimeActionPolicy = {
  mode: "full_access" | "read_only";
  app?: "instagram" | "tiktok" | "generic";
};

export class RealtimeActionSafetyError extends Error {
  readonly code = "READ_ONLY_ACTION_BLOCKED";
}

const MUTATION_LABEL = /(?:like|heart|follow|message|comment|share|send|publish|post|delete|remove|subscribe|点赞|关注|私信|评论|分享|发送|发布|删除)/iu;

/**
 * Fail-closed guard for inspection tasks. The normalized right rail is where
 * Instagram exposes Like, Comment and Share controls in full-screen Reels.
 * A read-only skill may open a reel, but it may never probe that rail.
 */
export function assertRealtimeTapAllowed(
  policy: RealtimeActionPolicy | undefined,
  point: NormalizedPoint,
  label: string,
) {
  if (policy?.mode !== "read_only") return;
  if (MUTATION_LABEL.test(label)) {
    throw new RealtimeActionSafetyError(
      `Read-only task blocked a mutation-labelled tap: ${label}.`,
    );
  }
  if (
    policy.app === "instagram" &&
    point.x >= 0.82 && point.x <= 1 &&
    point.y >= 0.46 && point.y <= 0.92
  ) {
    throw new RealtimeActionSafetyError(
      `Read-only Instagram task blocked the engagement rail at (${round(point.x)}, ${round(point.y)}).`,
    );
  }
}

export function assertRealtimeTextInputAllowed(
  policy: RealtimeActionPolicy | undefined,
  label: string,
) {
  if (policy?.mode !== "read_only") return;
  if (MUTATION_LABEL.test(label) || !/(?:search|query|lookup|搜索|查询)/iu.test(label)) {
    throw new RealtimeActionSafetyError(
      `Read-only task only permits text entry into a verified search field: ${label}.`,
    );
  }
}

export function assertRealtimePhoneKeyAllowed(
  policy: RealtimeActionPolicy | undefined,
  key: "back" | "home" | "enter" | "keyboard_next",
  label: string,
) {
  if (policy?.mode !== "read_only") return;
  if (key === "enter") {
    throw new RealtimeActionSafetyError(
      `Read-only task blocked Enter because it can submit external state: ${label}.`,
    );
  }
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
