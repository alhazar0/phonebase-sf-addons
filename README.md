# Phonebase 旧金山补充包：3017 录制 + 3027 任务

这是已下载 `phonebase-sf-handoff` 的补充源码，不替换原来的 3020 Dashboard 和 3013 硬件控制服务。

| 目录/地址 | 内容 |
| --- | --- |
| `action-recorder/` → `http://127.0.0.1:3017` | 点击、滑动、轨迹录制，保存/导入导出工作流，循环回放 |
| `task-agent-source/` → `http://127.0.0.1:3027/health` | OCR 与模型辅助的文字任务后端，返回 JSON |
| `task-agent-source/` → `http://127.0.0.1:3011/tasks` | “给手机一个任务”文字输入和任务记录页面 |

3017 不需要模型 Key；3027 的当前任务规划链路需要配置 OpenRouter 或本机 Codex CLI。两项功能都需要原项目的真实设备、3013 API 和有效校准。

先读 `SF-ADDONS-HANDOFF.md`。源码来自开发工作区，包含未提交更新；不含 Git 历史、个人环境配置、模型密钥、租约、录制工作流、摄像头图片或旧现场校准。`task-agent-source/.openai/hosting.json` 是空的构建兼容占位，不绑定原网站。

不能直接假定旧 ScreenHand 客户端与新版 Phonebase 的全部字段、认证、动作类型完全兼容；现场 Codex 必须先检查与适配，再进行有限实机验收。不要启动补充源码里的另一套硬件控制程序。

本包测试结果见 `VALIDATION.txt`，来源和文件校验见 `SOURCE_MANIFEST.json`。旧金山机器的实机和网页验收尚待执行。
