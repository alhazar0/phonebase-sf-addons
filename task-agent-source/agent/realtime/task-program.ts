export type RealtimeTaskProgram = {
  app: string;
  browseDurationMs: number;
  browseVideoCount: number;
  likeCount: number;
  commentCount: number;
  searchQuery: string | null;
  inspectResultCount: number;
  report: boolean;
  returnHome: boolean;
};

export function compileRealtimeTask(goal: string): RealtimeTaskProgram {
  const normalized = goal.normalize("NFKC").trim();
  const app = normalized.match(/(?:打开|open)\s*([a-z0-9._-]+)/iu)?.[1] ?? "TikTok";
  const minutes = numberBefore(normalized, /分钟/u) ??
    numberBefore(normalized, /minutes?/iu) ?? 0;
  const seconds = numberBefore(normalized, /秒/u) ??
    numberBefore(normalized, /seconds?/iu) ?? 0;
  const browseVideoCount = browseCount(normalized) ?? 0;
  const likeCount = numberNear(normalized, /点赞|likes?/iu) ?? 0;
  const commentCount = numberNear(normalized, /评论|comments?/iu) ?? 0;
  const searchQuery = normalized.match(/(?:搜索|search(?:\s+for)?)\s*[“"']?([a-z0-9._-]{1,40})/iu)?.[1] ?? null;
  return {
    app,
    browseDurationMs: Math.max(0, minutes * 60_000 + seconds * 1_000),
    browseVideoCount,
    likeCount,
    commentCount,
    searchQuery,
    inspectResultCount: searchQuery ? 8 : 0,
    report: /汇报|报告|总结|report|summar/i.test(normalized),
    returnHome: /(?:返回|回到)(?:手机)?(?:首页|主屏幕)|return\s+(?:to\s+)?(?:the\s+)?(?:phone\s+)?home(?:\s+screen)?/iu.test(normalized),
  };
}

function browseCount(value: string) {
  const chinese = value.match(
    new RegExp(`(?:刷|浏览|观看|看)\\s*(${NUMBER_SOURCE})\\s*(?:个|条)?\\s*(?:视频|作品)`, "iu"),
  );
  if (chinese?.[1]) return parseCount(chinese[1]);
  const english = value.match(
    new RegExp(`(?:browse|watch|view)\\s*(?:through\\s*)?(${NUMBER_SOURCE})\\s*(?:videos?|posts?)`, "iu"),
  );
  return english?.[1] ? parseCount(english[1]) : null;
}

function numberBefore(value: string, suffix: RegExp) {
  const match = value.match(new RegExp(`(${NUMBER_SOURCE})\\s*(?:${suffix.source})`, suffix.flags));
  return match?.[1] ? parseCount(match[1]) : null;
}

function numberNear(value: string, keyword: RegExp) {
  const before = value.match(new RegExp(`(${NUMBER_SOURCE})\\s*(?:个|次|条)?\\s*(?:${keyword.source})`, keyword.flags));
  if (before?.[1]) return parseCount(before[1]);
  const after = value.match(new RegExp(`(?:${keyword.source})\\s*(${NUMBER_SOURCE})`, keyword.flags));
  return after?.[1] ? parseCount(after[1]) : null;
}

function parseCount(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[value] ?? 0;
}

const NUMBER_SOURCE = "[0-9]+|一|二|两|三|四|五|六|七|八|九|十";
