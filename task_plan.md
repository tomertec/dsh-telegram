# dsh-telegram 上线冲刺任务计划

> 目标：把 dsh-telegram 迭代到可上线状态；测试并消除全部 bug；做好测试记录；
> 顺手优化 Telegram 人类使用习惯（解耦、不引入新 bug）；尽量完成项目最终目标。

## Phase 状态

- [x] Round 1：基线修复 + 多 chat 收口（160/160，commit `577a820`）
- [x] Round 2：liveFeed 真开关 + 15 个转发事件订阅 + 危险操作确认 + credential 隐私（163/163）
- [x] Round 3：Sessions/History 分页 + goal edit maxRounds + preset copy 自定义（173/173）
- [x] Round 4：Models/Plugins 分页 + 工具白名单 + host/commands/jobs/dynamic 单测（183/183）
- [x] Round 5：Host 目录逐级浏览 + Jobs/Search 卡片顺手化（184/184）
- [x] Round 6：Skills 按 session 查询 + Search 结果分页（187/187）
- [x] Round 7：Subagents 对齐 web 目录语义（190/190）
- [x] Round 8：非图片媒体明确指引 + downloads 单测（194/194）
- [x] Round 9：credentials 批量 + Host 版本真实化（198/198）
- [x] Round 10：session.attachment 读回 + Host 默认模型对齐（201/201）
- [x] Round 11：v0.3.0 release candidate（版本/CHANGELOG/preset hasDocument/202 tests）
- [ ] Round 12+：Telegram 实机 checklist + 剩余 🟡 收敛（见下）
- [ ] 最终：`npm run check` + `npm pack --dry-run` + 提交

## Round 2 已完成

- `outbound.liveFeed` 动态生效（core 忽略禁用 consumer；openclaw 逐事件检查；免重启热切换）。
- 15 个转发/host 事件订阅 → `refreshAllPanels()`，disposer 随 teardown 回收。
- 危险操作确认卡：session/workspace delete、preset remove、subagent interrupt；`buildConfirmKeyboard` 纯函数。
- `/credentialset` 原消息 500ms 后自动删除。

## 剩余候选（按性价比排序）

1. Telegram 实机回归 + 最终上线复测记录（TESTING §25 checklist）。
2. 审计剩余 🟡 收敛（history tool view、settings 边界等）。
3. 实机通过后决定 tag/publish。

## 错误记录

| 错误 | 尝试 | 处理 |
| --- | --- | --- |
| TS2352 AgentRegistry → AgentLike[] | 1 | 接口只保留结构子集 + `as unknown as` |
| npm pack EPERM（~/.npm root-owned） | 1 | `--cache /tmp/dsh-telegram-npm-cache` |
| telegram_mark_no_reply 返回类型不匹配 | 2 | 返回 JSON.stringify；删残留 return |
| confirm 键盘空行（`.row()` 语义） | 2 | 两个 `.text()` 不加 `.row()`；加单测锁定 |

## Round 3 已完成

- Sessions 卡：`lastPromptAt desc` 排序 + 10 条/页 `‹ Prev`/`More ›`。
- History：`Load older` 窗口分页（20 条/窗口 + hasMore）。
- `/goaledit <objective> [maxRounds]`。
- Preset Copy：回复自定义新 id；`/cancel` 中止。
- 新增 goals.test.mjs（5 例）与 sessions/history/presets 键盘适配器测试。

## Round 4 已完成

- Models provider 卡 12/页分页；Plugins 卡 20/页分页 + `buildPagingKeyboard`。
- `telegram_send`/`telegram_broadcast` 目标限白名单 roster（security 测试锁定）。
- 新增 `test/host.test.mjs`（4 例）与 `test/commands-jobs-dynamic.test.mjs`（4 例）。

## Round 5 已完成

- Host 卡 `Browse cwd`：目录两列、Up/~//、20/页、文件只计数、旧 `h:ls` 兼容。
- Jobs 卡 20/页分页。
- Search 卡专用 `buildSearchKeyboard`（命中会话 + New search/Sessions）。

## Round 6 已完成

- Skills 卡传 sessionId + 只显示 user-invocable；`test/skills.test.mjs` 3 例。
- Search 结果 100 取回 / 10 每页 / `‹ Prev`/`More ›`；search keyboard 支持 paging。

## Round 7 已完成

- `listSubagents` 完整投影 mode/label/hasChildren/reason/activity；legacy 回退。
- 详情仅 continuable 显示 Prompt/Interrupt，并在回调前校验。
- 新增 subagents 投影/降级与 keyboard 按钮裁剪测试。

## Round 8 已完成

- document/voice/video 路由到明确指引；未授权 photo/media 也发 allow 提示。
- downloads 单测：50MB 常量 + seam 缺失降级。
- README 平台限制同步。

## Round 9 已完成

- `describeCredentials` 批量 ≤64 refs（去重 + POSIX 校验）；/credential 与文案同步。
- `describeHost` version 参数：Host 卡显示插件 0.2.0。
- 新增 credentials.test.mjs（3 例）+ host 版本断言。

## Round 10 已完成

- `/attachment <id>` 读回真实 durable ref 并 sendPhoto 发回；发图回执附 attachment id。
- `describeHost` 优先 agentDefaultModel；ESM 三入口 smoke import。
- 新增附件读回、sendPhoto、host 默认模型测试。

## Round 11 已完成

- 版本升至 0.3.0；新增 CHANGELOG.md 并纳入 npm files。
- agentPreset.list 补 hasDocument；Presets 卡显示 document yes/no。
- 202/202 tests；上线前人工 checklist 写入 TESTING §25。
