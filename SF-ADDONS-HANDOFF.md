# 给旧金山 Codex 的补充交接

## 目标和顺序

继续原来的单台机械臂任务：先完成 `phonebase-sf-handoff` 的硬件连接、当地 IP、3020 网页、3013 API、3036 文件传输。再接入本包的录制回放和文字任务。保留原项目，补充包解压到旁边独立目录，不互相覆盖。

先读两个项目各自的 AGENTS.md。安装 Node >=22.13 及原项目需要的依赖。本包不带 node_modules，模型密钥和现场配置另行提供。

## 3017 录制回放

来源是 `screenhand-action-recorder/action-recorder` 的完整当前源码，与之前整理的 RPA 包中录制器文件逐个核对一致。

先检查 `action-recorder/server.mjs` 和 `public/workflow.js`，然后：

```bash
npm test --prefix action-recorder
SCREENHAND_RECORDER_UPSTREAM=http://127.0.0.1:3013 npm start --prefix action-recorder
```

打开 `http://127.0.0.1:3017`。上游必须是唯一运行中的 Phonebase 控制平面。

先禁用 Execute while recording 进行无运动录制，检查点击/滑动/轨迹、步骤顺序、压力参数、JSON 导出导入和刷新后的工作流。文件保存在该浏览器同一 Origin 的 localStorage；不要假定会跨电脑自动同步。

审查录制器动作类型与新版 `phonebase-sf-handoff/agent/action-contract.ts`：旧 touch_down/touch_move/touch_up 等能力不一定被新版接受。先检查设备 capabilities 和 API schema；不支持的动作必须禁用/明确提示，或在维持原语语义与门禁的前提下适配，不能伪装成功。也要检查直播 WebSocket、帧元数据、viewport、坐标换算和压力范围。

上游若开启本地 Bearer 认证，旧录制器不会自动具备认证；应在服务端私有配置中安全转发，且检查 WebSocket 的正确认证方式。不要关闭上游认证或把站点密钥放浏览器。

现场人员确认后，选不会发送内容或破坏数据的小动作，单次回放，核对机械动作及 UI 结果，再限次数循环。验证 Stop loop 与 Emergency hold 的不同含义、掉线/锁定/回执失败的停止行为。多设备功能源码存在，但本次只验收一台。

## 3027 文字任务后端 + 3011/tasks 页面

完整依赖源码位于 `task-agent-source`，包括 `agent/task-console`、`agent/local-control`、`agent/local-perception`、OCR Swift 源码和 `app/tasks` 前端。本包没有旧现场的 .runtime、图标训练库、touch-alignment 或校准数据。

**3027 本身是 JSON API，不是输入页面。** 实际页面在 `http://127.0.0.1:3011/tasks`，开发服务器将 `/task-console-api` 转发到 3027。

在 `task-agent-source` 中安装锁文件对应依赖，运行：

```bash
npm ci
npm run test:task-console
npm run test:local-control
```

根据 `.env.addons.example` 新建本机私有 `.env`。当前默认规划器是 OpenRouter，需要自己的 Key；也有 Codex CLI provider，必须验证这台电脑的 CLI、登录和模型可用性。先询问用户选用哪个已有可用 provider，不复制开发电脑凭据，不以配置标志代替连接验证。没有模型时要明确显示未配置，不宣称任意目标可纯 OCR 自主执行。OCR 在 Mac 本地，模型规划会按 provider 发送 OCR/layout，Codex 路径还会发送截图，应让用户了解实际数据路径。

审查 `start-task-ui.sh` 后，从补充包根目录运行：

```bash
bash start-task-ui.sh
```

脚本只启动任务后端和 3011 界面，不启动另一套 3013/驱动/摄像头。不要使用旧源码中的 `npm run local`、`npm run black`、`npm run dev:3011`、`fleet`、`control-plane`、onboard 或 supervisor 安装流程；其中组合脚本会启动额外服务，旧硬件启动路径有运动风险。3011 根页面有旧开发入口，本次只访问 `/tasks`。

先检查 3027 `/health`、`/devices`、3011 `/tasks` 与 `/task-console-api/health`。读取并比较新版设备状态、calibration.active 结构、动作 capabilities、帧头、归一化坐标、viewport/frameSequence 与回执。客户端同时读取部分 x-screenhand/x-phonebase 帧头，但不代表全部 API 已兼容；补齐必要兼容代码并保留验证门禁。若本地控制 API 需要认证，为任务服务和子进程各请求路径安全接入服务端凭据，不削弱原认证。

首先用 Preview 测试一个简单、无副作用目标，检查真实 OCR、计划、日志及失败提示；Preview 可能调用模型但必须零运动。模型生成动作不代表被授权。

再次取得现场确认后，用当前屏幕上的可见文本做一个有步数/时间上限的低影响任务，观察动作、最终 UI 证据与回执。任务里的 Home 通常指手机系统导航，不能把它混同机械回零。禁止选用发送消息、发布、购买、删除等作为验收动作。验证停止、中断记录、拒绝并发、结果不明时不自动重试；不得在 Dashboard、录制器、任务 Agent 和视频发布程序同时控制同一台机器。

任务执行器的旧 `getCalibration`、帧几何和触点对齐必须与新机器匹配；若报错保持锁定并修复兼容性或重新测量，不复制原机器私有修正文件。

## 交付

用中文分别报告：
- 原 3020/3013 和文件传输的结果。
- 3017 页面、离线录制、单次及有限循环回放的结果。
- 3027 后端健康、3011/tasks 页面、模型连接、Preview 和一次有限真实任务的结果。
- 修改文件、当地 IP/非敏感配置、启动停止命令、通过的测试、实机证据与阻碍。

不把模拟测试、页面可见、机械回执或真实 UI 目标成功混为一谈。不公开 3017/3027/3011，不宣称客户远程控制台已支持这些独立管理功能。原站点网关部署方案和授权隔离要求继续适用。
