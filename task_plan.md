# dsh-telegram 上线冲刺任务计划

> 目标：把 dsh-telegram 迭代到可上线状态；测试并消除全部 bug；做好测试记录；
> 顺手优化 Telegram 人类使用习惯（解耦、不引入新 bug）；尽量完成项目最终目标。

## Phase 状态

- [x] Round 1：基线修复 + 多 chat 收口（160/160，commit `577a820`）
- [x] Round 2：liveFeed 真开关 + 15 个转发事件订阅 + 危险操作确认 + credential 隐私（163/163）
- [x] Round 3：Sessions/History 分页 + goal edit maxRounds + preset copy 自定义（173/173）
- [x] Round 4：Models/Plugins 分页 + 工具白名单 + host/commands/jobs/dynamic 单测（183/183）
- [ ] Round 5+：继续 P1/P2 候选（见下），每轮回归 `npm run check` + pack
- [ ] 最终：`npm run check` + `npm pack --dry-run` + 提交

## Round 2 已完成

- `outbound.liveFeed` 动态生效（core 忽略禁用 consumer；openclaw 逐事件检查；免重启热切换）。
- 15 个转发/host 事件订阅 → `refreshAllPanels()`，disposer 随 teardown 回收。
- 危险操作确认卡：session/workspace delete、preset remove、subagent interrupt；`buildConfirmKeyboard` 纯函数。
- `/credentialset` 原消息 500ms 后自动删除。

## 剩余候选（按性价比排序）

1. host.listDirectory breadcrumb 浏览卡（复用 project 选择器）。
2. 文档/语音/视频附件接纳（当前只支持图片）。
3. skills 按 session cwd/scope 查询；subagent 详情补 mode/label 等字段。
4. downloads/events forwarding 单测补全；Jobs/Search 卡分页。
5. Telegram 实测清单持续更新。

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
