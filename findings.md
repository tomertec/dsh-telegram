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
