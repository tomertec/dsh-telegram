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

## 2026-08-16 Round 4（已完成）

- Models/Plugins 分页、工具白名单、host/commands/jobs/dynamic 单测。
- 183/183 tests；提交 `683e7d7`；详见 TESTING.md §18。

## 2026-08-16 Round 5（已完成）

- Host `Browse cwd` 目录浏览、Jobs 分页、Search 专用键盘。
- 184/184 tests；提交 `9fe482e`；详见 TESTING.md §19。

## 2026-08-16 Round 6（已完成）

- Skills 按 sessionId 查询并只显示 user-invocable；Search 结果 10/页分页。
- 187/187 tests；提交 `d50ae7d`；详见 TESTING.md §20。

## 2026-08-16 Round 7（本轮）

- Subagents 对齐 web 目录语义：mode/label/hasChildren/reason 投影；
  continuable 才可 Prompt/Interrupt，回调前二次校验。
- `npm run check`：**190/190 pass**。
- 文档已同步 TESTING.md §21 与 WEB_PARITY_AUDIT.md。
- 待办：npm pack 验证 + git 提交本轮改动。

## 下一步（Round 8 候选）

文档/语音附件、downloads 单测、Telegram 实测清单、最终上线复测。
