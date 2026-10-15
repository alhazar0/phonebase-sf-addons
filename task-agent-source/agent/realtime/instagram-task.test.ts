import assert from "node:assert/strict";
import test from "node:test";

import {
  compileInstagramProfileTask,
  InstagramTaskCompileError,
  isInstagramProfileInspectionGoal,
} from "./instagram-task";

test("compiles the Chinese Instagram profile metrics task", () => {
  assert.deepEqual(
    compileInstagramProfileTask(
      "打开 Instagram，你搜索 Nonna Sofia。她是一个 AI 网红。看一下她最后发的视频有多少点赞和播放量。",
    ),
    {
      app: "Instagram",
      kind: "instagram_profile_inspection",
      targetQuery: "Nonna Sofia",
      targetHandle: null,
      searchPrefix: "nonnasofi",
      latestVideo: true,
      metrics: ["views", "likes"],
      taskEffect: "read_only",
    },
  );
});

test("prefers an explicit Instagram handle", () => {
  const result = compileInstagramProfileTask(
    "Open Instagram and find @nonnasofiahealth, then report the latest reel views",
  );
  assert.equal(result.targetQuery, "nonnasofiahealth");
  assert.equal(result.targetHandle, "nonnasofiahealth");
  assert.equal(result.searchPrefix, "nonnasofiahealth");
  assert.deepEqual(result.metrics, ["views"]);
});

test("detects only profile inspection tasks and rejects missing targets", () => {
  assert.equal(isInstagramProfileInspectionGoal("打开 Instagram 搜索 Nonna Sofia 的视频播放量"), true);
  assert.equal(isInstagramProfileInspectionGoal("打开 Instagram"), false);
  assert.throws(
    () => compileInstagramProfileTask("打开 Instagram 看播放量"),
    InstagramTaskCompileError,
  );
});
