import type { ScreenObservation, ScreenElement } from "../general-agent-contract";

export type PageKind = "unknown" | "screen_off" | "home" | "clock" | "search" | "content_feed" | "conversation" | "conversation_list" | "profile" | "settings";
export type PageCandidate = { kind: PageKind; score: number; evidence: string[] };
export type LocalPageState = {
  page: PageKind;
  source: "current_evidence" | "recent_context" | "insufficient_evidence";
  overlay: "none" | "comments" | "dialog";
  keyboard: boolean;
  candidates: PageCandidate[];
  evidence: string[];
  stableFrames: number;
  method: "local-feature-rules+temporal";
  scoreIsProbability: false;
};

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().trim();

/** A transparent, untrained baseline. Scores are evidence weights, NOT probabilities. */
export class LocalPageTracker {
  private previous: { sequence: number; capturedAt: number; width: number; height: number; state: LocalPageState } | null = null;
  private candidate: PageKind = "unknown";
  private streak = 0;
  private remembered: { page: PageKind; at: number } | null = null;

  reset() {
    this.previous = null;
    this.candidate = "unknown";
    this.streak = 0;
    this.remembered = null;
  }

  observe(observation: ScreenObservation): LocalPageState {
    const { sequence, capturedAt, viewport, scene } = observation;
    if (this.previous && (sequence < this.previous.sequence || capturedAt < this.previous.capturedAt ||
      capturedAt - this.previous.capturedAt > 5_000 || viewport.width !== this.previous.width || viewport.height !== this.previous.height)) this.reset();
    if (this.previous?.sequence === sequence) return this.previous.state;
    const elements = observation.elements.filter(item => item.confidence >= 0.45);
    const top = (item: ScreenElement) => item.center.y / viewport.height < 0.28;
    const bottom = (item: ScreenElement) => item.center.y / viewport.height > 0.7;
    const right = (item: ScreenElement) => item.center.x / viewport.width > 0.73 && item.center.y / viewport.height > 0.18 && item.center.y / viewport.height < 0.85;
    const count = (pattern: RegExp, region: (item: ScreenElement) => boolean = () => true) =>
      elements.filter(item => region(item) && pattern.test(normalize(item.text))).length;
    const candidates: PageCandidate[] = [];
    const add = (kind: PageKind, signals: Array<[number, boolean | number, string]>) => {
      const supported = signals.filter(([, present]) => Boolean(present));
      if (supported.length) candidates.push({ kind, score: Math.min(1, supported.reduce((sum, [weight]) => sum + weight, 0)), evidence: supported.map(([, , detail]) => detail) });
    };

    add("screen_off", [[1, scene.kind === "screen_off" && elements.length === 0, "画面接近全黑且没有可读文字；可能息屏或被遮挡"]]);
    add("home", [
      [0.6, scene.kind === "home_grid" && scene.homeGridScore >= 0.65, "检测到应用图标网格"],
      [0.2, elements.length >= 12, "多组图标文字"],
      [0.15, new Set(elements.map(item => Math.round(item.center.x / viewport.width * 5))).size >= 4, "文字分布在多个列位置"],
    ]);
    add("clock", [
      [0.65, count(/^(world clock|世界时钟)$/, top), "顶部为世界时钟标题"],
      [0.25, count(/\d{1,2}:\d{2}/) >= 2, "出现多个时间值"],
      [0.1, count(/^(alarm|stopwatch|timers?|闹钟|秒表|计时器)$/, bottom), "底部为时钟导航"],
    ]);
    add("search", [
      [0.4, count(/^(search(?: .{0,30})?|搜索(?:.{0,12})?)$/, top), "顶部有搜索入口或搜索框文字"],
      [0.25, count(/^(cancel|取消)$/, top), "搜索区域旁有取消"],
      [0.3, count(/^(recent searches|search history|search results|搜索历史|最近搜索|搜索结果|no results.*)$/), "出现搜索历史或结果标签"],
      [0.15, scene.keyboardVisible, "键盘可见"],
    ]);
    add("content_feed", [
      [0.4, count(/^(for you|推荐)$/, top) && count(/^(following|关注)$/, top), "顶部同时出现推荐与关注分页"],
      [0.3, count(/^(\d[\d.,]*[kmb万亿]?|likes?|comments?|shares?|点赞|评论|分享)$/, right) >= 3, "右侧中部出现多组互动数字或标签"],
      [0.2, count(/^(home|friends|inbox|profile|首页|朋友|收件箱|我)$/, bottom) >= 2, "底部有内容应用导航"],
      [0.1, count(/^@\S+/), "内容区域含作者标识"],
    ]);
    add("conversation_list", [
      [0.5, count(/^(chats|messages|inbox|聊天|消息|收件箱)$/, top), "顶部为会话列表标题"],
      [0.2, count(/^(search|搜索)$/, top), "会话列表搜索入口"],
      [0.25, count(/\d{1,2}:\d{2}|yesterday|昨天/) >= 2, "多行消息时间"],
    ]);
    add("conversation", [
      [0.45, count(/^(message|type a message.*|send a message.*|消息|输入消息.*|发送消息.*)$/, bottom), "底部有消息输入区域"],
      [0.25, count(/^(send|发送)$/, bottom), "底部有发送控件"],
      [0.2, count(/\d{1,2}:\d{2}/) >= 2, "消息区域出现多个时间标记"],
      [0.1, observation.visualAffordances?.some(item => item.symbol === "back" && item.center.y / viewport.height < 0.25) ?? false, "顶部有返回图标"],
    ]);
    add("profile", [
      [0.4, count(/^\d*\s*(followers|粉丝)$/), "粉丝统计标签"],
      [0.25, count(/^\d*\s*(following|关注)$/), "关注统计标签"],
      [0.3, count(/^(edit profile|编辑资料|编辑主页)$/), "编辑资料入口"],
      [0.15, count(/^\d*\s*(posts|作品|帖子)$/), "作品统计标签"],
    ]);
    add("settings", [
      [0.5, count(/^(settings|设置)$/, top), "顶部为设置标题"],
      [0.3, count(/^(privacy|notifications|account|security|隐私|通知|账户|账号|安全)$/) >= 2, "出现多项设置类别"],
      [0.15, count(/^(general|display.*|sound.*|通用|显示.*|声音.*)$/), "出现系统设置项"],
    ]);

    const commentHeading = count(/^(?:\d[\d.,kmb万]*\s*)?(?:comments?|评论)(?:\s*\d[\d.,kmb万]*)?$/,
      item => item.center.x / viewport.width > 0.18 && item.center.x / viewport.width < 0.8 && item.center.y / viewport.height < 0.7);
    const commentComposer = count(/^(add (?:a )?comment.*|write (?:a )?comment.*|添加评论.*|发表评论.*|说点什么.*)$/, bottom);
    const replies = count(/^(reply|回复)$/) >= 2;
    const dialog = Boolean(observation.sceneGraph?.overlay.active) || Boolean(
      count(/^(allow|允许|同意)$/) && count(/^(don.t allow|deny|不允许|拒绝)$/));
    const overlay = dialog ? "dialog" : commentComposer && (commentHeading || replies) ? "comments" : "none";
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const margin = (best?.score ?? 0) - (candidates[1]?.score ?? 0);
    const eligible = best && best.score >= 0.72 && margin >= 0.12 && (best.evidence.length >= 2 || best.kind === "screen_off");
    const proposed = eligible ? best.kind : "unknown";
    this.streak = proposed === this.candidate ? this.streak + 1 : 1;
    this.candidate = proposed;
    let page: PageKind = proposed !== "unknown" && (this.streak >= 2 || (best?.score ?? 0) >= 0.95) ? proposed : "unknown";
    let source: LocalPageState["source"] = page === "unknown" ? "insufficient_evidence" : "current_evidence";
    let evidence = page === "unknown" ? ["证据不足、候选冲突或等待下一张独立画面确认"] : [...best!.evidence];
    if (overlay !== "none" && page === "unknown" && this.remembered && capturedAt - this.remembered.at <= 5_000) {
      page = this.remembered.page;
      source = "recent_context";
      evidence = ["覆盖层遮挡基础页面，暂沿用最近 5 秒内已确认的页面；未重新验证底层内容"];
    }
    if (source === "current_evidence" && overlay === "none") this.remembered = { page, at: capturedAt };
    if (overlay === "comments") evidence.push("评论输入区与评论标题/重复回复共同支持评论面板");
    if (overlay === "dialog") evidence.push("检测到覆盖层或允许/拒绝按钮组合");
    const stableFrames = this.previous?.state.page === page && this.previous.state.overlay === overlay ? this.previous.state.stableFrames + 1 : 1;
    const state: LocalPageState = { page, source, overlay, keyboard: scene.keyboardVisible, candidates: candidates.slice(0, 3), evidence, stableFrames, method: "local-feature-rules+temporal", scoreIsProbability: false };
    this.previous = { sequence, capturedAt, width: viewport.width, height: viewport.height, state };
    return state;
  }
}
