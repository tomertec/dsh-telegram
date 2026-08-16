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
