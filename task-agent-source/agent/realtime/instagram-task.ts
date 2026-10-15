export type InstagramProfileInspectionProgram = {
  app: "Instagram";
  kind: "instagram_profile_inspection";
  targetQuery: string;
  targetHandle: string | null;
  searchPrefix: string;
  latestVideo: true;
  metrics: Array<"views" | "likes">;
  taskEffect: "read_only";
};

export class InstagramTaskCompileError extends Error {}

export function compileInstagramProfileTask(goal: string): InstagramProfileInspectionProgram {
  const normalized = goal.normalize("NFKC").trim();
  const targetHandle = normalized.match(/@([a-z0-9._]{2,40})/iu)?.[1] ?? null;
  const targetQuery = cleanTarget(
    targetHandle ??
      capture(normalized, /(?:搜索|查找|找(?:到)?|search(?:\s+for)?|find)\s*[“"']?([^。！？，,;；\n]{2,80})/iu) ??
      capture(normalized, /[“"']([^”"']{2,80})[”"']/u) ??
      "",
  );
  if (!targetQuery) {
    throw new InstagramTaskCompileError(
      "Instagram profile inspection requires a profile name or @handle after search/find.",
    );
  }
  const compact = targetQuery
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}._]+/gu, "");
  const searchPrefix = targetHandle ?? compact.slice(0, Math.min(9, compact.length));
  if (searchPrefix.length < 2) {
    throw new InstagramTaskCompileError("Instagram search target is too short.");
  }
  const metrics: Array<"views" | "likes"> = [];
  if (/播放|观看|浏览|views?|plays?/iu.test(normalized)) metrics.push("views");
  if (/点赞|likes?/iu.test(normalized)) metrics.push("likes");
  if (!metrics.length) metrics.push("views", "likes");
  return {
    app: "Instagram",
    kind: "instagram_profile_inspection",
    targetQuery,
    targetHandle,
    searchPrefix,
    latestVideo: true,
    metrics,
    taskEffect: "read_only",
  };
}

export function isInstagramProfileInspectionGoal(goal: string) {
  const normalized = goal.normalize("NFKC").toLocaleLowerCase("en-US");
  return /(?:instagram|\bins\b|\big\b)/u.test(normalized) &&
    /(?:搜索|查找|找(?:到)?|search|find|主页|profile|视频|reel|播放|view|点赞|like)/u.test(normalized);
}

function capture(value: string, pattern: RegExp) {
  return value.match(pattern)?.[1] ?? null;
}

function cleanTarget(value: string) {
  return value
    .replace(/^[\s@]+|[\s。！？，,;；]+$/gu, "")
    .replace(/(?:她|他|它|这个|该)?(?:是|是一位|是一个).*/u, "")
    .replace(/(?:的)?(?:主页|profile|账号|account)$/iu, "")
    .trim();
}
