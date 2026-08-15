# dsh-telegram

DeepSeek Harness（dsh `0.1.0-rc.6`）的原生 Telegram 桥接插件：在手机上与 dsh agent 对话、查看状态、用按钮菜单操控会话/模型/插件/压缩——并且不拖慢 agent。

- 全异步：长轮询、全局限速 + 每 chat FIFO 发送队列、指数退避全部跑在 agent 循环之外。
- 按钮式交互（仿 `codex-telegram-bot` / `pi-telegram`）：常驻键盘栏 + 临时内联卡片。
- 完整复刻 web 暴露面：会话（新建/搜索/历史/重命名/派生/恢复/提示词/队列/模型/附件）、工作区、目标、消息反馈、技能、子代理、预设、宿主设置、凭据、模型发现、宿主文件、命令、任务、会话日志下载、插件清单 + 开关、动态插件清单、审批/提问内联应答。
- 统一 HTML 解析模式并严格转义——用户内容永远不会被当作格式解析。

## 环境要求

- Node.js ≥ 22
- dsh `0.1.0-rc.6`，profile 包含 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-commands`（随附 bundle 均满足）
- 一个 Telegram bot token（用 [@BotFather](https://t.me/BotFather) 创建）

## 安装

```sh
# 1. 安装到 profile（等价于在 profile 目录执行 pnpm add）
dsh plugin --profile <name> add dsh-telegram

# 2. 在 <profile>/cordis.patch.yml 的用户层加入 loader 条目
#    - insert:
#        - id: telegram
#          name: dsh-telegram

# 3. 提供 token（绝不落盘）
export TELEGRAM_BOT_TOKEN='123456:ABC...'
```

启动 profile 后，在 dsh UI 中执行：

```sh
/telegram start        # 开始长轮询（或配置 watch.autoStart: true）
/telegram allow <id>   # 白名单你的 chat id（或开始轮询后在 Telegram 里点“Allow this chat”）
```

然后在 Telegram 中给 bot 发 `/start`，即可看到欢迎语和常驻按键栏。

## 按键栏

常驻键盘栏（3 × 3）：

```text
☰ Menu    ✨ New     🧹 Compact
🧩 Models  🔌 Plugins 🎭 Mode
🧭 Sessions 📊 Status ⏹ Stop
```

`☰ Menu` 打开核心卡：状态文本、当前模型、队列深度、✨ New / 🧹 Compact，然后每个 web 域一行 —— Sessions、Status、Plugins、Mode、Workspaces、Goals、Skills、Subagents、Presets、Host settings、Credentials、Host、Jobs、Dynamic、Capabilities、Settings。“全部功能”卡包含同样各域，外加 Queue、Allowed、Watch、About。

web 暴露的全部 ApiProxy/Typert 方法均可从 Telegram 触达。完整的
web 接口 ↔ Telegram 映射见 [`PLAN.md`](PLAN.md)（A–D 节）；
`/capabilities` 显示当前 profile 实际可用的 seam。

## 配置

插件读取 `<workspace>/.pi/telegram.json`，其中 workspace 是向上最近的包含 `.pi` 的目录。所有字段可选：

```json
{
  "security": { "allowedChatIds": [123456789] },
  "watch": { "autoStart": false },
  "inbound": {
    "defaultMode": "auto-handle",
    "rules": [{ "chatId": 123456789, "pattern": "urgent", "mode": "queue-only" }]
  },
  "outbound": {
    "parseMode": "HTML",
    "disableNotification": false,
    "maxRetries": 3,
    "sendRatePerSecond": 20,
    "maxMessageLength": 4096
  },
  "mode": { "name": "headless" }
}
```

- `security.allowedChatIds` — 入站白名单；**为空则拒绝一切入站**。
- `inbound.defaultMode` — `auto-handle`（agent followup 回合）、`queue-only`（放入 inbox 但不唤醒 agent）、`muted`（忽略）。`rules` 按顺序匹配（先命中先生效），可匹配 `chatId` 和/或不区分大小写的子串 `pattern`。
- `watch.autoStart` — agent 创建后自动开启轮询。
- token **只**来自 `TELEGRAM_BOT_TOKEN`，永不写入磁盘。

## 模型工具

插件注册 5 个 agent 可调用工具：

| 工具 | 用途 |
| --- | --- |
| `telegram_send` | 向指定 chat 发送 HTML |
| `telegram_reply` | 回复当前入站 Telegram 消息 |
| `telegram_broadcast` | 同一消息发给多个 chat |
| `telegram_status` | 汇报桥接/agent/inbox 状态 |
| `telegram_mark_no_reply` | 标记入站消息为有意不回复 |

## dsh 侧命令

`/telegram status` · `/telegram start` · `/telegram stop` · `/telegram allow <chatId>` · `/telegram disallow <chatId>` · `/telegram watch on|off` · `/telegram config auto-start`

Telegram 侧命令：`/start /menu /new /compact /stop /models /sessions /workspaces /goals /skills /subagents /presets /plugins /hostsettings /credentials /host /jobs /status /help`，另有 `/history [id] [limit]`、`/search <query>`、`/rename <title>`、`/fork [atSeq]`、`/use <id>`、`/archive <id>`、`/queue`、`/queueedit <itemId> <text>`、`/steer <text>`、`/goalcreate <objective> [maxRounds]`、`/goaledit <text>`、`/workspacecreate <path> [title]`、`/workspacepin <workspaceId> <sessionId> [before]`、`/pluginenable|plugindisable <name>`、`/settingsdescribe [ns]`、`/settingsupdate <ns> <json>`、`/credential|credentialset|credentialunset <REF> [value]`、`/ls [path]`、`/mkdir <path>`、`/discover <settingsNs> [baseURL]`、`/subagentprompt <text>`、`/sessionlog [id]`、`/commands`、`/capabilities`。

## 平台限制（聊天内以指引呈现）

- `host.pickDirectory` / `host.openPath` 无手机端原生对话框 —— bot 以文本路径指引代替。
- `downloads.sessionLog` 与 web 同源 ZIP 流；超过 50 MB 引导去 web 下载。
- `dynamicCordisRunner` 的 run/stop/依赖变更与插件装卸仍是 web 面板操作（聊天内只读清单 + 指引）。
- 仅长轮询（无 webhook）；回复按完整 assistant 消息发送（无逐块流式）。
- 可选 peer `@deepseek-ai/dsh-compaction` / `@deepseek-ai/cordis-plugin-loader` 仅为构建期类型；运行期缺失服务会降级为可读错误。

## 热更新与热插拔（cordis 原生）

- `apply(ctx, config)` 消费 loader 条目配置（官方配置通道）；`.pi/telegram.json` 保留为文件回退。
- `internal/update` 瀑布内实时应用配置变更（白名单、入站规则、外发速率/重试/长度、watch.autoStart）并否决重启，沿用 include 插件的官方模式；`SendQueue.configure` 与 `TelegramTransport.applyLimits` 热调运行中的限速器。
- 禁用条目（`loader.update` / 自关 `/plugindisable`、或改 profile patch）或 hmr 源码重载时：`teardownMount()` 逆序回收全部挂载效应（transport/bridge/interactive/panels/待决状态/模型选择/会话生命周期），`apply` 幂等 —— 重载八百次与冷启动等价（论文 Theorem 73 Confluence 约定）。
- `ctx.provide("telegram", …)` 向其他插件暴露 `getConfig/status/chats/sendText/broadcast/start/stop`。
- Telegram 侧 `/config get|set <path> [json]` 与 dsh 侧 `/telegram config get|set <path> <json>` 可实时应用并持久化任意配置叶（如 `outbound.sendRatePerSecond`）。

## 实测

`TESTING.md` 记录隔离实测环境（临时 `DSH_HOME` + `test/telegram-live-overlay.yml`）与人工验收清单。

## 开发

```sh
npm install
npm run check          # tsc 构建 + node --test
npm pack --dry-run     # 校验发布内容（dist + README + LICENSE）
```

已核实的 dsh seam 见 [`docs/SEAMS.md`](docs/SEAMS.md)。

## License

MIT
