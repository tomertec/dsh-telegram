# dsh-telegram 项目计划

## 目标

为 DeepSeek Harness（dsh，0.1.0-rc.6）提供一个原生 Telegram 桥接插件：

- 手机端即可与 dsh agent 对话、监控状态、操控会话；
- 接入 Telegram 的同时**不拖慢 agent**（全异步、队列化、限速、事件驱动）；
- UI 仿照 codex-telegram-bot 与 pi-telegram 的按钮式交互，让人类轻松使用；
- 覆盖 harness 核心能力：插件、模式/Profile、会话、模型、压缩、状态；
- **v0.2：完美复刻 web 暴露的全部接口**（ApiProxy 56 项 + Typert Remote 24 项 + 转发事件 11 项），
  每一项都有 Telegram 卡片/按钮/命令对应，服务缺失时优雅降级并给出指引；
- 代码高效、解耦、模块化、简单。

## 非目标（v0.2）

- Webhook 部署（仅长轮询，符合“不影响速度”的最简路径）；
- 流式逐块回发（按 turn 发送最终回复，避免刷屏与限速抖动）；
- `dynamicCordisRunner` 12 个写方法、`host.pickDirectory` 原生对话框（Telegram 无对应 UI，给指引）；
- `downloads.sessionLog` 大文件直传（>50MB 时给本地路径 + web 指引，<50MB 时尝试直传）。

## 架构分层

```
src/index.ts                插件装配：name/inject/apply，只做注册与生命周期
├── src/config.ts           配置模型与 .pi/telegram.json 读写
├── src/workspace.ts        向上查找最近含 .pi 的工作区根目录
├── src/telegram/
│   ├── transport.ts        grammy 长轮询 + 发送队列 + 限速退避 + 文件发送
│   ├── keyboard.ts         纯函数键盘构建：常驻 bar + 各域卡片
│   ├── html.ts             HTML 转义与格式化助手
│   ├── ephemeral.ts        临时面板追踪与清理
│   ├── status-panel.ts     实时状态卡（editMessageText 原地刷新）
│   └── router.ts           文本/回调查询路由，按 chat 串行化
├── src/harness/
│   ├── bridge.ts           唯一对接面：入站 → agent inbox；session/event → 出站
│   └── adapters/           每个 web 域一个薄适配器（接口先行，失败降级为可读错误）
│       ├── capabilities.ts 能力矩阵：探测 ctx.* 服务可用性
│       ├── sessions.ts     ctx.sessions/agents：list/search/history/rename/fork/
│       │                   selectModel/updateQueue/attachment/prompt/cancel
│       ├── workspace.ts    ctx.workspaceRegistry 七件套 + 归档
│       ├── goals.ts        ctx.goals 六件套（get/create/edit/pause/resume/complete/clear）
│       ├── feedback.ts     ctx.messageFeedback put/list/delete
│       ├── skills.ts       ctx.skills.list
│       ├── subagents.ts    ctx.subagents list/history/prompt/interrupt
│       ├── presets.ts      ctx.agentPresets list/read/copy/remove/select
│       ├── settings.ts     ctx.settings describe/update/replace/mutate
│       ├── credentials.ts  ctx.credentials describe/set/unset（脱敏）
│       ├── llm.ts          ctx.llm providers/models/discoverModels/selectModel
│       ├── host.ts         host.describe/listDirectory/openPath/createDirectory
│       ├── commands.ts     ctx.commands list/execute 桥接
│       ├── jobs.ts         ctx.jobs.list（session/jobs 快照）
│       ├── downloads.ts    session log ZIP（best-effort 动态导入）
│       ├── plugins.ts      ctx.loader 清单增强 + 开关（cordis.patch.yml 持久化）
│       ├── dynamicCordis.ts ctx.dynamicCordisRunner.inventory 只读
│       ├── interactive.ts  审批/提问交互（approval/request + userQuestions provider）
│       ├── models.ts       （并入 llm.ts）
│       ├── compact.ts      ctx.compaction.compactNow()
│       ├── mode.ts         当前 profile / 模式信息
│       └── status.ts       ctx.agents + sessions 合成状态
└── test/                   node:test：每域适配器 + 键盘 + 队列 + 配置
```

依赖方向固定为 `index → adapters/bridge → telegram → 无反向依赖`；
`telegram/*` 不 import 任何 `@deepseek-ai/*` 运行时符号。

## web 接口全量复刻映射（v0.2 权威对照）

### A. ApiProxy HTTP RPC（56 项）

| web 接口 | seam | Telegram 呈现 | 状态 |
| --- | --- | --- | --- |
| session.list | ctx.sessions + ctx.sessionTitle + 事件扫描 | Sessions 卡（标题/最后提示/blank/归档） | 🟡→✅ |
| session.search | sqlite 索引（launcherSessionQueryPath）→ 降级 live 扫描 | /search | ❌→✅ |
| session.create | ctx.agents.create | /new | ✅ |
| session.history | session.events 窗口读取 | /history N 条回看 | 🟡→✅ |
| session.models | ctx.llm providers/models | Models 卡 | ✅ |
| session.selectModel | dsh-agent/model-selection installModelSelection | 模型行按钮（确认） | ❌→✅ |
| session.rename | ctx.sessionTitle.rename | Sessions 详情按钮 | ❌→✅ |
| session.fork | ctx.sessions.fork + agent 恢复 | Sessions 详情 Fork | ❌→✅ |
| session.prompt | agent.followup / send(steer) / 图片内容块 | 文本/queue/steer/图片 | 🟡→✅ |
| session.attachment | ctx.attachments.saveImage/readImage | Telegram 图片入站 | ❌→✅ |
| session.updateQueue | agent.inbox.replace/remove/steer | Queue 卡编辑/移除/插队 | 🟡→✅ |
| session.cancel | agent.cancel | /stop | ✅ |
| subagent.list | ctx.subagents.listChildren | Subagents 卡 | ❌→✅ |
| subagent.history | child session.events | 详情回看 | ❌→✅ |
| subagent.prompt | ctx.subagents.followup | 发送按钮 | ❌→✅ |
| subagent.interrupt | ctx.subagents.interrupt | 中断按钮（确认） | ❌→✅ |
| host.describe | 合成 | Host 卡 | 🟡→✅ |
| host.listDirectory | fs.readdir（路径确认） | /ls | ❌→✅ |
| host.createDirectory | fs.mkdir（确认） | /mkdir | ❌→✅ |
| host.pickDirectory | 原生对话框 → 文本路径替代 | 指引 + /cd 文本 | ❌→🟡指引 |
| host.openPath | 平台打开 → 返回路径指引 | 显示路径 | ❌→🟡指引 |
| workspace.*（7） | ctx.workspaceRegistry | Workspace 卡全套 | ❌→✅ |
| skill.list | ctx.skills.list | Skills 卡 | ❌→✅ |
| agentPreset.*（6） | ctx.agentPresets | Presets 卡（openDocument→目录指引） | ❌→✅ |
| goal.*（6） | ctx.goals | Goals 卡 + 按钮 | ❌→✅ |
| settings.*（5，openDocument→文档路径展示） | ctx.settings | Settings 卡 | 🟡→✅ |
| credentials.*（3） | ctx.credentials | Credentials 卡（脱敏+确认） | ❌→✅ |
| llm.providers/models | ctx.llm | Models 卡 | ✅ |
| llm.discoverModels | ctx.llm.discoverModels | 探测按钮（确认） | ❌→✅ |
| events.mux | ctx.on('session/event') + queue/jobs/approval/question | bridge + 卡片 | 🟡→✅ |
| events.host | ctx.on('session/created'等) | status 刷新 + host 卡 | ❌→✅ |
| respond（approval/question） | interactive.ts | 内联按钮应答 | ❌→✅ |
| downloads.sessionLog | 动态导入 session-export | <50MB 直传，否则指引 | ❌→🟡 |

### B. Typert Remote（24 项）

| web 接口 | seam | Telegram 呈现 | 状态 |
| --- | --- | --- | --- |
| commands/execute | ctx.commands.execute | 斜杠命令转发 | 🟡→✅ |
| commands/list | ctx.commands.list | /commands | ❌→✅ |
| pluginInventory/list | ctx.loader.entries | Plugins 卡 | ✅ |
| messageFeedback/*（3） | ctx.messageFeedback | 回复上 👍/👎 | ❌→✅ |
| goals/*（6） | ctx.goals | Goals 卡 | ❌→✅ |
| dynamicCordisRunner/inventory | ctx.dynamicCordisRunner.inventory | Plugins→Dynamic 只读 | ❌→✅ |
| dynamicCordisRunner 其余 11 | — | 指引（web 面板协议） | ❌→指引 |

### C. 转发事件（11 项）

commands/change、settings/document-updated、llm/adapters-updated、agent-preset/selected、
credentials/updated → 订阅刷新相关卡片；cordis/* 6 项 → 只刷新 Dynamic 清单。

### D. 插件开关（web 无此接口，dsh 核心能力）

- 临时：ctx.loader.update(id,{disabled})（重启还原）；
- 持久：改写 profile cordis.patch.yml + 提示重启；
- 安装/卸载：spawn `dsh plugin --profile X add/remove`（白名单 + 确认）。

## Telegram 接入要点

- 长轮询 getUpdates：订阅 message / callback_query / photo；
- 未授权聊天收到「Allow this chat」内联按钮（`m:allowthis` 回调放行）；
- 常驻 ReplyKeyboardMarkup + 各域 InlineKeyboardMarkup 卡片；
- editMessageText 原地更新；deleteMessage 清理临时面板；
- 解析模式统一 HTML + 严格转义；发送队列 + 全局限速 + 429 退避；
- 所有 I/O fire-and-forget，绝不阻塞 agent 事件循环；
- 回调 payload 紧凑编码（域前缀 + id 分片），单条 ≤64 字节。

## 热更新 / 热插拔（v0.3，cordis 官方语义）

- `apply(ctx, config)` 接受 loader 条目配置；`.pi/telegram.json` 为文件回退；
- `internal/update` 瀑布实时应用白名单/入站规则/外发限速/autoStart 并否决重启（include 模式）；未知字段走官方重启路径；
- `SendQueue.configure` + `Transport.applyLimits` 热调限速器；`teardownMount()` 全量逆回收，`apply` 幂等（HMR 安全）；
- `ctx.provide("telegram", …)` 开放服务句柄；Telegram `/config` + dsh `/telegram config` 双通道热配置；
- userQuestions 单 provider：web（api-gateway）在场时让位，headless 由 Telegram 内联应答。

## Project 选择器（v0.4，Codex-style「直接选文件夹」）

### 目标

- Codex 的 project = 一个文件夹：Telegram 里像本地对话框一样逐级浏览目录，点「Use this folder」即切换活动项目；新会话（`✨ New`）落在该项目下。
- 保留 web 的 workspaceRegistry 语义：切换时若 registry 存在，复用同 path 的 workspace，否则 `create(path, 目录名)` 登记（web 面板同步可见）。

### 交互

- 核心菜单新增整行 `📁 Project · <目录名>`（与 Models/Queue 同风格），All 菜单与 `/help` 同步。
- `/project`（无参）打开浏览卡；`/project <path>` 直接切换（相对路径基于当前项目解析）。
- 浏览卡内容：
  - 顶部显示当前路径；目录按字母序排在文件前，单页 ≤96 项，文件只计数不占按钮；
  - 行内按钮：`📁 <name>` 进入、`⬆️ Up` 父目录、`🏠 ~`、`🖥️ /` 快捷根、已登记 workspace 路径快选（≤3 个）、`✅ Use this folder`、`✖ Close`；
  - 路径全部走 token 注册表（`t:<n>`），callback_data 永不超 64 字节。
- 无权限/不存在目录：错误卡 + `⬆️ Up` 仍可用（逐级回退）。

### 持久化与热更新

- config 新增可选节 `workspace: { activePath?: string }`（向后兼容，旧文件缺省=启动目录）；
- 切换时 `writeConfig` 落盘 + `state.workspaceRoot` 实时生效（不重启）；
- `internal/update` 热应用 `workspace` 节：`activePath` 存在且是目录 → 切换，否则保留并提示；
- `/config get workspace.activePath` 自动可用。

### 校验与边界

- 选择前 `stat` 校验必须是目录（拒绝文件/符号链接指向非目录）；
- 每步 `resolve` 规范化路径，防 `..` 越界写法；
- 失败不污染状态：先校验后落盘；
- 测试覆盖：config 往返、目录排序/上限/错误、非目录拒绝、路径规范化、键盘形状。

## 菜单分页与全功能体检（v0.5）

- 核心菜单拆成 2 页，codex-bridge 式密度（主项整行 + 其余两两成行）：
  - P1 非 bar 功能：New / Project 整行，Queue / Goals / Workspaces / Skills / Subagents / Presets / Host settings / Credentials 成对；
  - P2 bar 已有功能后置：Models / Mode / Sessions / Status / Plugins / Compact / Stop，再接低频只读：Host / Jobs / Dynamic / Capabilities / Allowed / Watch / About / Settings；
  - 导航行 `‹ Prev · n/2 · More ›` + `✖ Close`；`m:back` 一律回 P1；
  - 文本尾行 NBSP 填充撑满气泡最大宽度，键盘两列/整行均无右侧空位。
- bar 去掉 `✨ New`（易误触，且会顶掉当前会话），保留 9 键（3×3，Queue 行含 Compact/Stop）；`BAR_LABELS` 仍兼容旧客户端残留按钮。
- 交互结算（approval / questions answered / cancelled）不再广播 `remove_keyboard`——那是 pi-telegram 遗留的 ReplyKeyboardRemove 用法，会连同常驻 bar 一起移除；内联按钮自己会随回调失效，不需要动 reply keyboard。
- 实时测试 overlay（`test/telegram-live-overlay.yml`）固定 `agent-default-model → opencode-go / deepseek-v4-pro`。
- bar 顺序按频率重新分组：`☰ Menu · 🧩 Models · 🧭 Sessions` / `🔌 Plugins · 📊 Status · 🎭 Presets` / `⌛ Queue · 🧹 Compact · ⏹ Stop`（Queue 放底栏，会话生命周期 Compact/Stop 收尾）。
- Queue 卡每项带真实按钮：`✏️` 点击后进入「发文本即编辑」内联流程（/cancel 可中止），`🗑` 直接删除，`⚡` 仅 next-turn 提供立即执行；编辑沿用 web 的 `{...message, content}` 原消息语义。
- Status 卡补全 web 统计条数据：`sessionStats`（轮次/步骤/模型与工具耗时/首token/解码吞吐）+ `tokenUsage`（缓存命中率 = cacheRead ÷ 计费输入，入/出 token）+ 桥内实时 tool/call 计数；文案与格式 1:1 复刻 web 统计条（`{n} 轮 · {n} 步 | LLM … · 工具调用 … | 首 token 平均 … · … tok/s | 缓存命中 …% | 输入 … tok · 输出 … tok`，token 用 K/M、时长 `X.Ys`/`XmYs`）；step/tool/assistant 事件触发面板原地刷新（面板未打开时不发消息），headless 无投影注册表时优雅降级。
- bar 的 Queue 键内嵌实时计数 `⌛ Queue · N`（复刻 web status.queue）：Telegram 普通键盘无法原地编辑（`editMessageReplyMarkup` 实测 400），因此每次计数变化按聊天做 **delete 旧载体 + 发送新载体**（1.5s 防抖、`disable_notification`），由 `agent/status`、`turn/end`、用户入站与配置热更新触发；`normalizeBarLabel` 把 `⌛ Queue · N` 归一化回 `⌛ Queue`，旧客户端残留静态标签仍可点击。
- `/menucheck`：逐个调用 18 个菜单卡的数据源（status/models/plugins/sessions/history/queue/workspaces/goals/skills/subagents/presets/settings/credentials/host/jobs/dynamic/capabilities/mode），输出 ✅/❌ 报告卡。
- 键盘构建器改用 `InlineKeyboard.from(rows)` 行数组,彻底规避 grammY 空首行（`row()` 语义陷阱），菜单每行全宽。

## 模型工具（给 agent 用）

telegram_send / telegram_reply / telegram_broadcast / telegram_status / telegram_mark_no_reply

## 配置（.pi/telegram.json）

- security.allowedChatIds 白名单；
- watch.autoStart；
- inbound.defaultMode / rules；
- outbound.parseMode / disableNotification / maxRetries / sendRatePerSecond / maxMessageLength；
- **plugins.allowToggle（默认 true）/ persistPatch（默认 true）/ allowedInstallPrefixes**；
- **capabilities.cards（默认全部开启）**。

## 实施顺序（v0.2）

1. ✅ seam 审计（ApiProxy 56 + Typert 24 + 事件 11 全量对照）
2. capabilities.ts 能力矩阵
3. 域适配器逐域实现（sessions → workspace → goals → feedback → skills →
   subagents → presets → settings → credentials → llm → host → commands →
   jobs → downloads → plugins → dynamicCordis）
4. interactive.ts（approval/question 内联应答）
5. bridge 增强（steer/queue 快照/图片入站/命令转发）
6. keyboard + index 路由装配（每域卡片 + 回调）
7. 单元测试（每域适配器 + 键盘 + 队列）
8. build + test + pack 全绿
9. README 更新（能力矩阵表）

## 验证标准

- `npm run check` 全绿；
- `npm pack --dry-run` 完整；
- 插件在 headless 与 web profile 均能挂载（能力降级不抛错）；
- 人工验收：Sessions/Workspace/Goals/Skills/Subagents/Presets/Settings/
  Credentials/Host/Jobs/Models/Queue/Plugins 卡片逐项可用；
- 审批与提问可在 Telegram 内联按钮完成闭环。
