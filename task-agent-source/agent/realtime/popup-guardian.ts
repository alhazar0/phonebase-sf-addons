import type { ScreenElement, ScreenObservation } from "../general-agent-contract";
import type { RealtimeActionScheduler } from "./action-scheduler";
import type {
  RealtimeScreenPerception,
  RuntimeScreenState,
} from "./screen-state";
import type { LatencyRecorder } from "./latency-recorder";

export type PopupVisualState = Pick<RuntimeScreenState, "observation">;

export type PopupCategory =
  | "permission"
  | "notifications"
  | "tracking"
  | "update"
  | "rating"
  | "network_error"
  | "authentication"
  | "generic";

export type PopupOperation = "tap" | "back";

export type PopupDecision = {
  category: PopupCategory;
  operation: PopupOperation;
  confidence: number;
  label: string;
  rationale: string;
  target?: { x: number; y: number };
};

export type PopupPolicy = {
  allowCapabilities?: ReadonlySet<PopupCapability>;
  retryNetworkErrors?: boolean;
  maximumAttemptsPerPopup?: number;
};

export type PopupCapability =
  | "camera"
  | "photos"
  | "microphone"
  | "notifications"
  | "tracking"
  | "contacts"
  | "location";

export type PopupHandlingResult = {
  detected: boolean;
  handled: boolean;
  decision?: PopupDecision;
  state: RuntimeScreenState;
  error?: string;
};

type PopupGuardianContext = {
  actions: RealtimeActionScheduler;
  perception: RealtimeScreenPerception;
  metrics: LatencyRecorder;
  signal: AbortSignal;
  emit: (phase: string, label: string, detail?: Record<string, unknown>) => void;
  policy?: PopupPolicy;
};

const FULL_SCREEN = { left: 0, top: 0, width: 1, height: 1 } as const;

/**
 * Handles visually recognized interruptions without pausing for an operator.
 * Every action is bounded per popup fingerprint, visually verified, and kept
 * separate from the task planner so an interrupted task can resume in place.
 */
export class RealtimePopupGuardian {
  private readonly attempts = new Map<string, number>();
  private handledCount = 0;

  constructor(private readonly context: PopupGuardianContext) {}

  get recoveries() {
    return this.handledCount;
  }

  detect(state: RuntimeScreenState) {
    return planPopupAction(state, this.context.policy);
  }

  async handle(state: RuntimeScreenState): Promise<PopupHandlingResult> {
    const decision = this.detect(state);
    if (!decision) return { detected: false, handled: false, state };

    const key = `${state.observation.fingerprint}:${decision.category}:${decision.label}`;
    const attempts = this.attempts.get(key) ?? 0;
    const maximumAttempts = this.context.policy?.maximumAttemptsPerPopup ?? 1;
    if (attempts >= maximumAttempts) {
      const error = `Popup ${decision.category} remained after ${attempts} autonomous attempt(s).`;
      this.context.emit("popup", "attempt-limit", {
        category: decision.category,
        label: decision.label,
        confidence: decision.confidence,
        error,
      });
      return { detected: true, handled: false, decision, state, error };
    }
    this.attempts.set(key, attempts + 1);
    this.context.emit("popup", "detected", {
      category: decision.category,
      operation: decision.operation,
      label: decision.label,
      confidence: decision.confidence,
      rationale: decision.rationale,
    });

    return this.context.metrics.measure(
      "recovery",
      `popup:${decision.category}`,
      async () => {
        try {
          const before = await this.context.actions.latestFrame();
          if (decision.operation === "tap" && decision.target) {
            await this.context.actions.tap(
              decision.target,
              `popup:${decision.category}:${decision.label}`,
              80,
              this.context.signal,
            );
          } else {
            await this.context.actions.phoneKey(
              "back",
              `popup:${decision.category}:back`,
              this.context.signal,
            );
          }
          const changed = await this.context.actions.waitForChange(before, FULL_SCREEN, {
            threshold: 0.012,
            timeoutMs: 3_500,
            signal: this.context.signal,
          });
          const recovered = await this.context.perception.waitFor(
            (candidate) => !planPopupAction(candidate, this.context.policy),
            {
              timeoutMs: 3_000,
              afterSequence: Math.max(before.sequence, changed.frame.sequence - 1),
              signal: this.context.signal,
            },
          );
          this.handledCount += 1;
          this.context.emit("popup", "cleared", {
            category: decision.category,
            label: decision.label,
            sequence: recovered.observation.sequence,
            resumedScreen: recovered.kind,
          });
          return { detected: true, handled: true, decision, state: recovered };
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          this.context.emit("popup", "clear-failed", {
            category: decision.category,
            label: decision.label,
            error,
          });
          return { detected: true, handled: false, decision, state, error };
        }
      },
      {
        category: decision.category,
        operation: decision.operation,
        label: decision.label,
      },
    );
  }
}

export function planPopupAction(
  state: PopupVisualState,
  policy: PopupPolicy = {},
): PopupDecision | null {
  const viewport = state.observation.viewport;
  const readable = state.observation.elements
    .filter((element) => element.confidence >= 0.3)
    .map((element) => ({ element, value: normalize(element.text) }))
    .filter((candidate) => candidate.value);
  const joined = readable.map((candidate) => candidate.value).join(" ");
  const category = popupCategory(joined);
  if (!category) return null;

  const capability = permissionCapability(joined);
  const allowsCapability = capability && policy.allowCapabilities?.has(capability);
  const buttons = readable.filter(({ element }) =>
    element.center.y >= viewport.height * 0.18 &&
    element.center.y <= viewport.height * 0.92 &&
    element.bounds.height <= viewport.height * 0.09
  );

  if (category === "network_error" && policy.retryNetworkErrors !== false) {
    const retry = bestButton(buttons, RETRY_BUTTONS);
    if (retry) return tapDecision(category, retry.element, "retry", 0.96, state.observation);
  }

  if ((category === "permission" || category === "notifications" || category === "tracking") && allowsCapability) {
    const allow = bestButton(buttons, ALLOW_BUTTONS);
    if (allow) return tapDecision(category, allow.element, "allow", 0.94, state.observation);
  }

  const dismiss = bestButton(buttons, DISMISS_BUTTONS);
  if (dismiss) {
    return tapDecision(category, dismiss.element, normalize(dismiss.element.text), 0.97, state.observation);
  }

  if (category === "update") {
    const later = bestButton(buttons, LATER_BUTTONS);
    if (later) return tapDecision(category, later.element, "later", 0.95, state.observation);
  }

  if (category === "authentication") {
    return {
      category,
      operation: "back",
      confidence: 0.96,
      label: "leave-authentication-challenge",
      rationale: "A security or verification challenge interrupted the task; leave it and resume from a saved checkpoint.",
    };
  }

  const close = bestButton(buttons, CLOSE_BUTTONS);
  if (close) return tapDecision(category, close.element, "close", 0.88, state.observation);

  const visualClose = unambiguousVisualClose(state.observation);
  if (visualClose) {
    return {
      category,
      operation: "tap",
      confidence: visualClose.confidence,
      label: "close-symbol",
      rationale: "The interruption has one high-confidence local X symbol in its navigation region.",
      target: {
        x: visualClose.interactionPoint.x / viewport.width,
        y: visualClose.interactionPoint.y / viewport.height,
      },
    };
  }

  return {
    category,
    operation: "back",
    confidence: 0.78,
    label: "dismiss-with-back",
    rationale: "The interruption is recognizable, but no unambiguous text button is visible.",
  };
}

function unambiguousVisualClose(observation: ScreenObservation) {
  const candidates = (observation.sceneGraph?.nodes ?? [])
    .filter((node) =>
      node.interactive &&
      normalize(node.label) === "close" &&
      ["icon", "navigation", "control"].includes(node.role) &&
      node.confidence >= 0.8
    )
    .sort((left, right) => right.confidence - left.confidence ||
      right.seenCount - left.seenCount);
  if (!candidates.length) return null;
  if (
    candidates[1] &&
    candidates[1].confidence >= candidates[0].confidence - 0.08
  ) return null;
  return candidates[0];
}

export function isPopupState(state: PopupVisualState) {
  return Boolean(planPopupAction(state));
}

function popupCategory(value: string): PopupCategory | null {
  if (/(?:captcha|security check|verification code|verify (?:your|it.s) you|account (?:is )?(?:locked|suspended)|验证码|安全验证|账号.{0,4}(?:冻结|锁定))/.test(value)) {
    return "authentication";
  }
  if (
    /(?:no internet|network error|connection (?:failed|lost)|couldn.t connect|网络.{0,4}(?:错误|异常)|连接失败)/.test(value) ||
    /(?:something went wrong|unable to (?:connect|load)|加载失败).{0,30}(?:try again|retry|重试)/.test(value)
  ) {
    return "network_error";
  }
  if (/(?:allow .* to track|ask app not to track|tracking activity|跨 app 跟踪|跟踪您)/.test(value)) {
    return "tracking";
  }
  if (/(?:would like to send you notifications|send you notifications|turn on notifications|推送通知|发送通知|通知权限)/.test(value) &&
    /(?:allow|don.t allow|not now|settings|允许|不允许|设置)/.test(value)) {
    return "notifications";
  }
  if (/(?:would like to access|would like to use|allow .{0,40} to (?:access|use)|permission (?:is )?(?:required|needed)|access your (?:photos|camera|microphone|contacts|location)|想访问|需要.{0,20}权限|允许.{0,20}(?:照片|相机|麦克风|通讯录|位置))/.test(value)) {
    return "permission";
  }
  if (/(?:new version|update (?:is )?available|upgrade now|版本更新|发现新版本|立即更新)/.test(value)) {
    return "update";
  }
  if (/(?:rate (?:this|us|the) app|enjoying .*\?|write a review|给.{0,10}评分|喜欢.{0,10}吗|评价应用)/.test(value)) {
    return "rating";
  }
  if (/(?:save (?:your )?login info|remember (?:me|this account)|turn on .* sync|保存登录信息|记住账号)/.test(value)) {
    return "generic";
  }
  return null;
}

function permissionCapability(value: string): PopupCapability | null {
  if (/(?:photo|相册|照片)/.test(value)) return "photos";
  if (/(?:camera|相机)/.test(value)) return "camera";
  if (/(?:microphone|麦克风)/.test(value)) return "microphone";
  if (/(?:notification|通知)/.test(value)) return "notifications";
  if (/(?:track|跟踪)/.test(value)) return "tracking";
  if (/(?:contact|通讯录|联系人)/.test(value)) return "contacts";
  if (/(?:location|位置|定位)/.test(value)) return "location";
  return null;
}

function tapDecision(
  category: PopupCategory,
  element: ScreenElement,
  label: string,
  confidence: number,
  observation: ScreenObservation,
): PopupDecision {
  const semantic = observation.sceneGraph?.nodes
    .filter((node) => node.interactive && normalize(node.label) === normalize(element.text))
    .sort((left, right) => right.seenCount - left.seenCount || right.confidence - left.confidence)[0];
  const point = semantic?.interactionPoint ?? element.center;
  return {
    category,
    operation: "tap",
    confidence: Math.min(confidence, Math.max(0.6, element.confidence)),
    label,
    rationale: `The popup exposes an unambiguous ${label} action.`,
    target: {
      x: point.x / observation.viewport.width,
      y: point.y / observation.viewport.height,
    },
  };
}

function bestButton(
  candidates: Array<{ element: ScreenElement; value: string }>,
  patterns: readonly RegExp[],
) {
  return candidates
    .filter((candidate) => patterns.some((pattern) => pattern.test(candidate.value)))
    .sort((left, right) => right.element.confidence - left.element.confidence)[0] ?? null;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[’']/g, "'")
    .replace(/[^\p{Letter}\p{Number}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DISMISS_BUTTONS = [
  /^(?:not now|no thanks|maybe later|cancel|skip|don.t allow|deny|continue without|暂不|以后再说|不用了|取消|跳过|不允许|拒绝)$/,
] as const;
const LATER_BUTTONS = [/^(?:later|remind me later|not now|稍后|以后再说|暂不更新)$/] as const;
const ALLOW_BUTTONS = [
  /^(?:allow|ok|continue|allow while using app|allow full access|允许|好|继续|使用 app 时允许|全部允许)$/,
] as const;
const RETRY_BUTTONS = [/^(?:retry|try again|reload|重试|再试一次|重新加载)$/] as const;
const CLOSE_BUTTONS = [/^(?:close|done|got it|ok|关闭|完成|知道了|好)$/] as const;
