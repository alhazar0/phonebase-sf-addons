import assert from "node:assert/strict";
import test from "node:test";

import { compileRealtimeTask } from "./task-program";

test("compiles the Chinese TikTok benchmark into one deterministic program", () => {
  assert.deepEqual(
    compileRealtimeTask(
      "打开tiktok 刷视频2分钟 点赞4个作品 评论两个 内容随机，然后到搜索框搜索 alhazar 看看有啥好内容给我汇报",
    ),
    {
      app: "tiktok",
      browseDurationMs: 120_000,
      browseVideoCount: 0,
      likeCount: 4,
      commentCount: 2,
      searchQuery: "alhazar",
      inspectResultCount: 8,
      report: true,
      returnHome: false,
    },
  );
});

test("compiles an equivalent English task", () => {
  const program = compileRealtimeTask(
    "Open TikTok, browse 2 minutes, like 4 videos, comment 2, search for alhazar and report",
  );
  assert.equal(program.app.toLowerCase(), "tiktok");
  assert.equal(program.browseDurationMs, 120_000);
  assert.equal(program.browseVideoCount, 0);
  assert.equal(program.likeCount, 4);
  assert.equal(program.commentCount, 2);
  assert.equal(program.searchQuery, "alhazar");
  assert.equal(program.report, true);
  assert.equal(program.returnHome, false);
});

test("compiles a bounded video-count task and terminal Home checkpoint", () => {
  const chinese = compileRealtimeTask("打开 TikTok，浏览三个视频，然后返回手机首页");
  assert.equal(chinese.browseDurationMs, 0);
  assert.equal(chinese.browseVideoCount, 3);
  assert.equal(chinese.returnHome, true);

  const english = compileRealtimeTask("Open TikTok, watch 3 videos, then return to the home screen");
  assert.equal(english.browseVideoCount, 3);
  assert.equal(english.returnHome, true);
});

test("does not confuse a duration with a video-count target", () => {
  const program = compileRealtimeTask("打开 TikTok 刷视频2分钟");
  assert.equal(program.browseDurationMs, 120_000);
  assert.equal(program.browseVideoCount, 0);
});
