# dsh-telegram 发现记录

## 2026-08-16 Round 1

- 基线 `npm run check` 在 `src/harness/adapters/sessions.ts(84,10)` 报 TS2352：
  `AgentRegistry` 转成自定义 `AgentLike[]` 时，`Agent` 类型没有 `dispose` 属性，而
  `AgentLike` 要求 `dispose(): Promise<void>`，两类型「不够重叠」。
  → 真实 `Agent` 的释放走 `AgentHandle.dispose()`，`ctx.agents.get()` 拿到的 Agent 本身没有 dispose。
  → 已修：接口只保留稳定结构子集（id/session/options），释放路径运行时 cast。
- 仓库已有大量未提交工作（index +451、bridge +274 等），TESTING.md 说 147/147，
  但当前工作区实际 build 失败 → 计划记录不可完全采信，本轮必须以本地实测为准。
- TESTING.md 已覆盖到 14 节：安全/热重载/transport 竞态/顺手化 8 项修复后 147 测试。
- 依赖版本锁定：dsh-agent 0.1.0-rc.6；`AgentRegistry.create/resume` 返回 `AgentHandle`。

## Round 1 代码审查发现（已修复）

1. 基线 TS2352（见上）。
2. `SessionLifecycle.create` 语义从「继承任意 live agent」改为 profile default；原单测还是旧断言。
3. `NEW_BTN`/`/new` 直接 create 不复用 `createSessionForChat` → 本 chat 旧 agent 不被替换（泄漏）。
4. `Bridge.bindAgent` 同 chat 换绑不清旧 inbound → 新会话回复会引用旧消息 id；`resolveAgent` 在绑定 agent 已死时 fallback 到其他 chat 的 live agent → 多 chat 串台。
5. `assistant/message` 事件缺结构守卫，畸形事件会让监听器抛错。
6. 回调 chat id 提取顺序为 `callback.chat ?? message.chat`，与 Bot API 真实形状（chat 在 message 上）不符。
7. openclaw 新回合开始不清上一回合的 throttle timer → 旧草稿 edit 打进新回合。
8. router 无 per-chat 串行 → 快速连发两条首条消息可能并发创建两个 session。
9. approval/question 仍全 roster 广播（会话 A 的审批推给 B 聊天）。
10. `/telegram disallow` 与 security 热更新只从 roster 移除，不解除 bridge 绑定 → 已解绑会话仍可能通过 bridge 发消息。
11. `/use` 恢复会话后不 adopt `AgentHandle` → teardown 不跟踪。
12. `telegram_reply`/`telegram_mark_no_reply` 只看「最近触碰」inbound，两个会话并发时可能回错聊天。

## Round 2 发现与修复

- `outbound.liveFeed` 是死配置：openclaw 只认「是否挂载」。修复为 core 侧按配置忽略 consumer + 扩展逐事件检查，热切换生效。
- web `events.host`/remote 事件完全未订阅，导致其他面板改设置/插件后 Telegram 卡片陈旧。
- 危险操作中 workspace delete、preset remove、subagent interrupt 无确认；session delete 有确认但走「新消息 + 残留确认卡」旧路径。
- `/credentialset` 的 secret 明文会永久留在聊天历史。
- grammY `InlineKeyboard.row()` 陷阱再次出现：新 confirm 键盘若以 `.row()` 开头会多一个空行，以 `.row()` 结尾会多一个空尾行；正确写法是两个 `.text()` 不加 `.row()`。

## Round 3 发现与修复

- Sessions 卡只显示 15 条且无序，不符合 web `updatedAt desc` 语义；改为 adapter 排序 + UI 分页。
- History 详情没有「看更早」入口，`beforeSeq` 参数实际是死能力；接上 `Load older` token 流。
- `/goaledit` 丢掉 web 的 maxGoalRounds 能力；按 `/goalcreate` 同款解析补齐并加单测。
- Preset Copy 固定 `<id>-copy` 不符合人类操作；改为「点 Copy → 回复自定义 id」，`/cancel` 可中止。

## Round 4 发现与修复

- Models provider 卡一次只显示前 20 且无翻页；改为 12/页 token 分页。
- Plugins 卡截断 30 条且键盘没有翻页；新增通用 `buildPagingKeyboard`，20/页。
- `telegram_send`/`telegram_broadcast` 可由 agent 发给任意 chatId，绕过安全白名单；两个工具现在只接受 roster 内 chat。
- host/commands/jobs/dynamic 长期无单测；补齐 8 个用例（含 mkdir 递归失败语义）。

## Round 5 发现与修复

- `/ls` 只能发一大段文本，不符合手机逐级浏览习惯；Host 卡新增 `Browse cwd` 逐级点按浏览器，路径全部 token 化。
- 旧客户端残留 `h:ls` 按钮需兼容；路由统一映射到新浏览卡。
- Jobs 卡截断 20 条且无翻页；改为 20/页 + `buildPagingKeyboard`。
- Search 卡误用 Sessions 键盘（New/Stop/Search 与搜索结果混在一起）；新增专用 `buildSearchKeyboard`。

## Round 6 发现与修复

- `listSkills` 从不传 sessionId，违背 web skill.list 的「按会话项目根解析」契约；补 session 选项并兼容无 session 调用。
- Skills 卡把 model-only 技能和 user-invocable 混在一起；改为只展示 user-invocable 并显示隐藏数量。
- Search 取 20 条但 UI 只显示 10 条且无法翻页；改为取 100、10/页、token 翻页。

## Round 7 发现与修复

- `listSubagents` 只取 `{kind,id}`，丢失 web `SubagentListEntry` 的 mode/label/hasChildren/reason；补齐投影并兼容 legacy。
- one-shot/diagnostic 子代理详情仍显示 Prompt/Interrupt 按钮，点击会失败；改为只有 continuable 显示并在回调前二次校验。
- Subagent 列表 activity 与 web 的「存储快照」语义不一致；现在优先透传 `entry.activity`，旧服务回退 live status。

## Round 8 发现与修复

- document/voice/video 到达 getUpdates 后被静默丢弃；现在提取 metadata、白名单检查并回明确指引。
- 未授权 photo/document 同样静默；router 改为与文本一致地发 allow 提示。
- downloads 动态 seam 缺失路径没有测试；补 50MB 常量与 fail-closed 指引测试。
- 明确平台限制：web session.prompt 只接受 text/image（权威 schema 证据），文档/语音/视频不做假附件。

## Round 9 发现与修复

- web `credentials.describe` 是批量 `refs[]` 契约，TG 只能查一个；新增批量适配（≤64/去重/校验）。
- Host 卡 version 写死 0.0.1，误导用户；改为传入插件真实 version（0.2.0）。
- 权威确认：credentials 无枚举 seam，web 也不列出 ref 列表；卡片保持命令指引是正确的。

## Round 10 发现与修复

- `readImageAttachment` 用伪造的零字段 ref 读图，真实 `ctx.attachments.readImage` 会校验 bytes 与 ref 失败——这是死代码级 bug；改为记录真实 durable ref，并新增 `/attachment` UI 闭环。
- Host provider/model 取第一个 live agent，不符合 web `host.describe` 的 `agentDefaultModel` seam；已对齐并测试。
- 发布前 smoke import 验证三个 ESM 入口均可加载。

## Round 11 发现与修复

- agentPreset.list 缺 web `hasDocument` deployment fact；补透传并在 Presets 卡显示。
- 发布物缺 CHANGELOG；新增并把其纳入 package files。
- 版本号长期停在 0.2.0，与大量新功能不匹配；升至 0.3.0（package.json + lock）。

## Round 12 发现与修复

- host.createDirectory 没有浏览器内的 parent+name 按钮流，只能背路径；新增 New folder 单段回复流。
- 审计中 agentPreset.remove 仍标「无确认」，实际 Round 2 已实现；状态修正。

## Round 13 发现与修复

- `modelCatalog` 缺 web `SessionModels.routable`；按 web routeServed 语义补上（无 llm 时 true），Models 卡显示。
- provider 卡的 Thinking 行是死能力（builder 支持但从未传参）；接入 per-session 五档 picker 与 `selectSessionModel(effort)`。
- settings.describe 审计描述曾称 web 只暴露部分 namespace；权威源码显示 web 列出全部注册 namespace，修正审计。

## Round 14 发现与修复

- `ctx.settings.describe` 的 schema envelope 被 adapter 丢弃；补透传并在 namespace 卡展示。
- settings.describe 审计状态进一步收敛（web 同语义：全部 namespace + schema）。

## Round 15 发现与修复

- settings update/replace/mutate 未透传 web expectedRevision（并发编辑保护缺失）；命令支持尾随 revision，且 parser 保证 JSON 字符串内部空白不破坏。

## Round 16 发现与修复

- 权威源码显示 web api-proxy 将 subagent child 的 activity 重映射为 live agent status；此前透传持久化快照是语义错误。
- subagent.prompt 缺 clientTimeZone 与 AbortSignal；已按 web MessageSource 契约补上。

## Round 17 发现与验证

- `npm publish --dry-run` 通过（registry public access，真实发布需登录）。
- 自动化发布门槛已过；创建本地 tag `v0.3.0-rc.1`（推送/发布待实机验收）。

## Round 18 独立审计 + 实机冒烟

- 独立审计确认 2 个 P1（telegram_reply 失败吞、stop/start 竞态）与 5 个 P2；全部修复并加回归测试。
- npm audit --omit=dev：0 漏洞。
- 实机冒烟：真实 bot @XosEvolvesbot 长轮询启动、openclaw 挂载、getMe 正确、bar sync 已向 chat 8753447694 投递。

## Round 20 发现与修复

- 实机 bug：Bridge.notifyStateChange 方法体被此前改名操作误替换为自递归（`this.notifyStateChange()`），每次状态变更栈溢出，且日志只输出 `[object Error]`。
- 修复：改回调 `this.onStateChange()`；异常日志输出 `message + stack`；新增「回调恰好一次」与「异常含堆栈且只记录一次」两个回归测试。
- 实机复验通过：web 49733 派发两次 `/telegram status` 无任何 state-change 错误。

### Round 20 追加

- 主 profile 已配置的 `DEEPSEEK_API_KEY` 对 deepseek-official 返回 401（`****2dbe` invalid）；live profile 仅路由 deepseek-official。需用户更新有效 key。

## Round 21 独立审计 + 修复

- 独立审计确认 3 个发布阻断：版本导出漂移 0.2.0；HTML 长文本拆坏标签；SendQueue 对永久 4xx 全部重试。
- 另修复 3 个非阻塞：mo/set 回调 URI 编码、telegram_* 工具 HTML 契约、typing 循环 10 分钟自毁。
- `npm run check` 222/222；实机 opencode-go 全链路 LLM turn 完成（turn/end completed）。

## Round 22 发现与修复

- 审计遗留的展示串台：未绑定 chat 的 `boundAgentId` 回退最近 agent；已改为 chat 作用域 fail-closed，`statusSnapshot(fallbackToFirst=false)` 支撑。
- 卡片交互不符合 Telegram 习惯：approval/question 结算另发消息、旧按钮仍可点；改为原地编辑并移除 inline keyboard。

## Round 23 发现与修复

- token 注册表不是 single-use：确认按钮可重复执行副作用；抽为 TokenRegistry，单次消费 + 双账本有界 + 单测。
- /credentialset 删除命令消息依赖 500ms timer：改为队列序删除（先删密钥、再发回执）。

### Round 23 追加：实机首消息竞态

- 真实 Telegram 出现同一 chat 双会话：onUserText 首消息路径未 await，router FIFO 对会话创建窗口无效。
- 修复 + apply-race 集成回归（假 agents.create 延迟 30ms），227/227。

## Round 24 发现与修复

- 审计遗留 UX：未授权 /start 放行后不会自动进入欢迎流程；已改为 allow 后重放 /start。

## Round 25 实机验收证据

- 快速连发 1/2：仅一个 telegram 会话，第二条进同一 inbox（竞态修复实机通过）。
- Menu/Models/Queue/approval 回调全部真实走通；menucheck 等价探测 0 ❌。

## Round 25 发布动作

- main + v0.3.0-rc.1 tag 已推送 GitHub；pre-release 已创建并附 tgz。
- 真实 npm publish 未执行：本机无 npm 登录凭据；用户选择暂不发布 npm。

## Round 25 追加：用户实机 UX 反馈

- Workspaces 卡缺字段防抖、Project 增加 Menu 返回、Queue 条目编号+预览、移除 Sessions Search 按钮。

## Round 25 追加：workspace/preset/status 对齐

- Workspaces 全卡防死；Presets/Workspaces/Sessions 卡片在 web 侧事件后原地重读；Status 增加 router/subagents/jobs 计数。

## 交互逻辑迭代 Round 1

- router 对 command/bar/callback/photo 的 dispatch 未 await（fire-and-forget），已修复为真正 FIFO。
- Queue 编辑改为删除+ForceReply 重发；所有回复式输入用 ForceReply；/start 设置官方 MenuButtonCommands。

## 交互逻辑 Round 2

- buildMenuPage 的 m:page 页数按钮是无动作按钮，点击只有 spinner；已移除。
- m:back 固定回第 0 页不符合直觉；改为回到 menuPageIndex 记录的上一页。

## Round 2 追加：删除/归档修复

- deleteSession 目录名错配（encodeSegment `--~id--` vs 实际原始 id），改为双候选删除。
- archive 后回详情卡显示 archived；workspace create 后端验证通过。

## Round 2 追加

- Session 标题来自 session/title 事件，已补齐扫描；Cold session 也有名字。
- Workspace Create 改为目录浏览选择器，去掉抽象路径输入。
