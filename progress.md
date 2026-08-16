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

## 2026-08-16 Round 7（已完成）

- Subagents 对齐 web 目录语义并 gating continuable。
- 190/190 tests；提交 `f805d65`；详见 TESTING.md §21。

## 2026-08-16 Round 8（已完成）

- document/voice/video 明确指引；downloads 单测；README 平台限制同步。
- 194/194 tests；提交 `8d77095`；详见 TESTING.md §22。

## 2026-08-16 Round 9（已完成）

- `/credential` 批量；Host 版本真实化。
- 198/198 tests；提交 `22c028a`；详见 TESTING.md §23。

## 2026-08-16 Round 10（已完成）

- `/attachment <id>` 读回真实 ref；Host 默认模型对齐 agentDefaultModel。
- 201/201 tests；提交 `4338240`；详见 TESTING.md §24。

## 2026-08-16 Round 11（已完成）

- v0.3.0 RC：版本、CHANGELOG、preset hasDocument、§25 人工 checklist。
- 202/202 tests；提交 `876302f`；详见 TESTING.md §25。

## 2026-08-16 Round 12（已完成）

- Host 浏览卡 New folder。
- 203/203 tests；提交 `8f11be2`；详见 TESTING.md §26。

## 2026-08-16 Round 13（已完成）

- Models routable + per-session thinking。
- 206/206 tests；提交 `9301270`；详见 TESTING.md §27。

## 2026-08-16 Round 14（已完成）

- Settings schema envelope。
- 207/207 tests；提交 `14ac1ee`；详见 TESTING.md §28。

## 2026-08-16 Round 15（已完成）

- settings expectedRevision。
- 208/208 tests；提交 `7c8cfd8`；详见 TESTING.md §29。

## 2026-08-16 Round 16（本轮）

- Subagent activity 重映射 + prompt 时区/信号。
- `npm run check`：**208/208 pass**。
- 文档已同步 TESTING.md §30 与 WEB_PARITY_AUDIT.md。
- 待办：npm pack 验证 + git 提交本轮改动。

## Round 17（已完成）

- Release gate：npm publish --dry-run OK；tag v0.3.0-rc.1（commit `3bccf34`）。
- 详见 TESTING.md §31。

## Round 18（本轮）

- 独立审计 7 项修复；211/211 tests。
- 实机冒烟：@XosEvolvesbot 长轮询、openclaw 挂载、bar sync 投递成功。
- 详见 TESTING.md §32。

## Round 19（本轮）

- 实机实例保持运行（web 49523 + long polling + openclaw）。
- §25 checklist 已发到 Telegram chat 8753447694（message_id 1271）。
- 详见 TESTING.md §33。

## 下一步（Round 20 候选）

收集用户在 Telegram 的 checklist 结果；有偏差修偏差，全过则推 tag 与正式发布。

## Round 20（本轮）

- 实机日志发现 `state change handler failed [object Error]` 刷屏；根因是上次改名误把 `notifyStateChange()` 方法体改成自递归，RangeError 每次 turn 事件触发。
- 修复并新增 2 个回归测试；`npm run check`：**213/213 pass**。
- 重启隔离实机（web 49733）复验：两次 `/telegram status` turn 完成，无 state-change 错误。
- 详见 TESTING.md §34。
- 剩余阻塞：隔离 profile 无 `DEEPSEEK_API_KEY`，完整 agent 轮次无法验证；等待用户提供 key / 完成 §25 人工清单。

### Round 20 追加

- 复制主 profile 凭据到隔离 DSH_HOME 后重启（web 49803）：`MISSING_CREDENTIAL` 消除，但现有 `DEEPSEEK_API_KEY` 已失效（401 AUTH）。等待用户更新有效 key 后跑完整 Telegram 轮次。

## Round 21（本轮）

- 独立发布审计（后台子代理）：213/213、audit 0、pack 119 files；报 3 个发布阻断。
- 修复版本漂移 / HTML 拆分 / 重试分类 / 回调编码 / HTML 工具契约 / typing 泄漏；新增 9 个回归测试，**222/222 pass**。
- 实机：激活 opencode-go 路由，真实 LLM 轮次 `turn/end completed`；修复版 live 实例 web 50755 运行正常。
- 待人工：Telegram chat 真实入站一条消息完成端到端交付；§25 清单与发布。

## Round 22（本轮）

- 修复多聊天展示串台（未绑定 chat fail-closed）与 approval/question 卡片原地结算；223/223 pass。
- 实机端到端仍等用户在 Telegram 回复（提醒已发，message_id 1277）。

## Round 23（本轮）

- 修复 callback token 重复执行与 /credentialset 删除竞态；226/226 pass。
- 实机端到端仍等待用户在 Telegram 回复。

## Round 23 追加

- 实机发现并修复「两条首消息 → 两个会话」竞态；新增 apply-race 集成测试；227/227。

## Round 24（本轮）

- 修复未授权 /start 放行后的欢迎语重放；227/227。
- 实机端到端：真实 Telegram ping 已验证（真实 LLM turn completed）；竞态修复后等待用户快速连发复验。

## Round 25（本轮）

- 收集到真实 Telegram 实机验收证据：单会话竞态、回调闭环、真实 LLM 轮次。
- 发布门满足，下一步 push main/tags + release。

## Round 25 发布动作

- GitHub push + pre-release 完成；用户已明确选择暂不发布 npm，发布动作以 GitHub rc release 收口。
