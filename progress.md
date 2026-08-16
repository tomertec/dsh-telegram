# dsh-telegram 进度日志

## 2026-08-16 Round 1（已完成）

- 基线构建修复 + 12 项缺陷修复，160/160 tests，commit `577a820`。
- 详见 TESTING.md §15。

## 2026-08-16 Round 2（已完成）

- liveFeed 真开关、15 个转发事件订阅、危险操作确认、credential 隐私。
- 163/163 tests；提交 `4beeb7f`、`319169c`、`64337ee`。
- 详见 TESTING.md §16。

## 2026-08-16 Round 3（本轮）

- Sessions 卡按 `lastPromptAt desc` 排序并 10 条/页翻页。
- History `Load older` 窗口分页。
- `/goaledit <objective> [maxRounds]`；Preset Copy 回复自定义 id。
- 新增 goals.test.mjs 等 10 个用例；`npm run check` **173/173 pass**。
- 文档已同步 TESTING.md §17 与 WEB_PARITY_AUDIT.md。
- 待办：npm pack 验证 + git 提交本轮改动。

## 下一步（Round 4 候选）

Models/Plugins 翻页、host 目录逐级浏览卡、文档/语音附件、skills scope、
subagent 详情字段、补齐 adapter 单测、工具目标白名单限制。
