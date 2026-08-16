# dsh-telegram 上线冲刺任务计划

> 目标：把 dsh-telegram 迭代到可上线状态；测试并消除全部 bug；做好测试记录；
> 顺手优化 Telegram 人类使用习惯（解耦、不引入新 bug）；尽量完成项目最终目标。
> 本轮（Round 1）已完成基线修复 + 多 chat 收口，详细记录见 TESTING.md 第 15 节。

## Phase 状态

- [x] Phase 0：恢复上下文（git status / TESTING.md / PLAN.md / docs 审计）
- [x] Phase 1：建立基线 `npm run check` → 发现并修复 TS 构建失败
- [x] Phase 2：全量测试 + npm pack 验证
  - `npm run check` 160/160 pass
  - `npm pack --dry-run --cache /tmp/dsh-telegram-npm-cache` 118 文件
- [x] Phase 3：审查未提交 diff，修复 11 项问题（详见 TESTING.md §15）
- [x] Phase 4：补测试与文档（TESTING.md §15、WEB_PARITY_AUDIT.md 状态同步）
- [ ] Phase 5：继续打磨 P1/P2（见下轮清单），每轮都要回归
- [ ] Phase 6：最终 `npm run check` + `npm pack --dry-run` + git 提交建议

## Round 1 关键修复

- 基线：TS2352 sessions adapter。
- 多 chat：Bridge 死绑定 fail-closed、换绑清 inbound、畸形事件防抛、detach 清态。
- router：per-chat FIFO 串行，handler 错误不阻塞链。
- UI 一致性：`✨ New` / `/new` 走 `createSessionForChat`；`/use` adopt handle。
- 隐私/安全：approval/question 按 session→chat；`ejectChat` 在 disallow/security 热更新时解除绑定。
- 工具：`telegram_reply`/`telegram_mark_no_reply` 按执行 agent 反查 inbound。
- 流式：openclaw 新回合取消旧 throttle timer。
- 回调：`callback_query.message.chat` 优先。

## 下一轮候选（按性价比排序）

1. `outbound.liveFeed` 真正控制 openclaw 草稿开关。
2. 危险操作二次确认（delete session / preset remove / subagent interrupt / workspace delete）。
3. credential 写入后删除原消息（secret 不留聊天记录）。
4. 订阅 11 个转发事件，按 chat 刷新受影响卡片。
5. session.list 排序/翻页；history Load older；Models 翻页。
6. host.listDirectory breadcrumb 浏览卡（复用 project 选择器）。
7. 文档/语音/视频附件接纳。
8. 补 host/commands/jobs/downloads/dynamic/events forwarding 单测。

## 错误记录

| 错误 | 尝试 | 处理 |
| --- | --- | --- |
| TS2352 AgentRegistry → AgentLike[] | 1 | 接口只保留结构子集 + `as unknown as` |
| npm pack EPERM（~/.npm root-owned） | 1 | 用 `--cache /tmp/dsh-telegram-npm-cache`（环境问题，非项目） |
| telegram_mark_no_reply 返回类型不匹配 | 2 | 返回 JSON.stringify；删残留 return |
