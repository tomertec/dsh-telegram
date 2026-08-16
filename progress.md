# dsh-telegram 进度日志

## 2026-08-16 Round 1（已完成）

- 基线构建修复 + 12 项缺陷修复，160/160 tests，commit `577a820`。
- 详见 TESTING.md §15。

## 2026-08-16 Round 2（已完成）

- `outbound.liveFeed` 动态生效（core + openclaw 两侧）。
- 订阅 15 个 web 转发/host 事件并只刷新打开面板。
- 危险操作确认卡统一（session/workspace delete、preset remove、subagent interrupt），结果与取消回执为独立消息。
- `/credentialset` 原消息 500ms 自动删除。
- `npm run check`：163/163 pass；`npm pack --dry-run` 118 文件完整。
- 文档已同步：TESTING.md §16、WEB_PARITY_AUDIT.md。
- 提交：`4beeb7f` + `319169c`。

## 下一步（Round 3 候选）

session/history/models 分页、host 目录逐级浏览、文档/语音附件、skills scope、
subagent 详情字段、goal edit maxRounds、补齐 adapter 单测。
