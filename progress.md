# dsh-telegram 进度日志

## 2026-08-16 Round 1（已完成）

- 基线构建修复 + 12 项缺陷修复，160/160 tests，commit `577a820`。
- 详见 TESTING.md §15。

## 2026-08-16 Round 2（已完成）

- liveFeed 真开关、15 个转发事件订阅、危险操作确认、credential 隐私。
- 163/163 tests；提交 `4beeb7f`、`319169c`、`64337ee`。
- 详见 TESTING.md §16。

## 2026-08-16 Round 3（已完成）

- Sessions/History 分页、goal edit maxRounds、preset copy 自定义。
- 173/173 tests；提交 `71f8347`；详见 TESTING.md §17。

## 2026-08-16 Round 4（本轮）

- Models provider 卡 12/页、Plugins 卡 20/页分页。
- `telegram_send`/`telegram_broadcast` 目标限白名单 roster。
- 新增 host 与 commands/jobs/dynamic 单测。
- `npm run check`：**183/183 pass**。
- 文档已同步 TESTING.md §18 与 WEB_PARITY_AUDIT.md。
- 待办：npm pack 验证 + git 提交本轮改动。

## 下一步（Round 5 候选）

host 目录 breadcrumb 浏览卡、文档/语音附件、skills scope、subagent 详情字段、
downloads 单测、Jobs/Search 卡分页。
