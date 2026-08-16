# Telegram Sessions 卡：按工作区项目分组的会话交互改造计划

> 目标：把 Telegram 的 `/sessions` 交互对齐 web 工作区语义——会话名直接同步 web 已生成的标题，
> 会话按工作区项目分类，默认展示正在运行项目的会话，并可在项目之间切换。
> 范围：仅改 `/Users/cx/dsh-telegram` 仓库（用户已确认）；web 本体不动。

## 1. 调研结论（web 工作区现状）

### 1.1 web 怎么给会话命名

- Host 端 `session-title` 服务把最新 `session/title` 事件折叠成标题投影；列表行显示优先级是：
  **持久标题 → cwd 目录名 → session id**。
- 实机检查 `~/.dsh/storages/session_projcache.json` 与两个会话日志：`继续` 是首条消息 `继续` 的
  fallback + first-prompt LLM 都输出了 `继续`，随后会话做了大量实质工作但标题不更新。
- 用户决策：**不改标题生成策略**。Telegram 只负责同步 web 已经写进日志的标题
  （`session/title` 事件最新值），不再自己从首条消息猜标题。

### 1.2 web 怎么按项目分类

- `~/.dsh/storages/workspace.json` 保存 workspace 记录：`path`、`title`、`sessionIds` 顺序账本。
- web 侧边栏按 `WorkspaceView.sessionIds` 分组；不属于任何 workspace 的会话进 Ungrouped；
  归档会话不显示。
- workspace 分组顺序是持久手动顺序，会话活跃不会移动 workspace 组；组内顺序是
  manual / last-updated 两种浏览器本地视图。

### 1.3 Telegram 现状与差距

| 维度 | web | Telegram 现状 | 差距 |
| --- | --- | --- | --- |
| 标题来源 | title 投影 → cwd 基名 → id | title 事件 → **首条用户消息** → id | 兜底不一致 |
| 冷会话 cwd | header.cwd 透传 | 冷会话 `cwd` 丢失 | 无法按项目归类 |
| running | `agent.status === 'running'` | `agents.get(id) !== undefined` | 挂起会话误标 running |
| 分组 | 按 workspace 分组 | 一张平铺列表 | 无项目维度 |
| 运行优先 | 当前分组自动展开 | 仅 lastPromptAt 排序 | 无运行项目优先 |

## 2. 目标交互（验收标准）

1. `/sessions`（和菜单 Sessions）默认直接打开**正在运行项目**的会话页；没有运行项目时打开
   当前 chat 绑定会话所在项目，再退到最近活跃项目。
2. 会话页顶部有 `🔀 项目` 切换入口；项目切换器按“运行中项目在前、当前项目次之、其余按最近活跃”
   排序，点击任意项目即可切换会话列表；保留 `🌐 全部会话（平铺）` 兼容旧习惯。
3. 项目内会话排序：**运行中的会话在前**，其余按 `lastPromptAt` 新→旧；分页保持 10 条/页。
4. 会话名与 web 完全一致：`session/title` 最新标题 → `cwd` 基名 → session id；不再用首条消息兜底。
5. 冷会话补上 header.cwd，才能归入正确项目；`running` 改为真实 agent 状态。
6. 既有动作（Use/History/Rename/Fork/Archive/Model/Queue/Steer/Log/Stop/Delete）全部保留，
   从详情返回时回到刚才的项目页。

## 3. 实施步骤

### Phase 1 — 适配层（`src/harness/adapters/sessions.ts`，纯逻辑先行）

- `AgentLike` 增加 `status?: string`；`running = agent.status === 'running'`
  （与 web `summarize()` 的 `agent.status === 'running'` 对齐）。
- `SessionDetail` 增加 `workspaceId?: string`、`projectKey: string`、`projectLabel: string`；
  冷会话从 `PersistenceHeaderLike` 透传 `cwd`（当前丢字段的根因）。
- `titleFor`：
  - 保留 live 会话走 `sessionTitle.get()`（web 权威折叠）。
  - 冷会话继续扫描最新 `session/title` 事件（与 web 同源）。
  - **删除首条用户消息兜底**；新增导出 `displayTitleFor(title, cwd, id)`，
    实现 web 的三级回退（title → cwd 基名 → id）。
  - 可选优化：若 `ctx.get('sessionProjectionCache')` 可用，冷会话优先读缓存标题，失败再
    `readRaw`（web profile 已挂载该缓存）。
- 新增导出纯函数（便于单测）：
  - `groupSessionsByProject(details, workspaces)`：
    - 归属判定与 web 一致：`workspace.sessionIds.includes(id)`；
    - 未记账会话按 cwd 分组为伪项目（key = cwd，label = 基名；重名时加父目录消歧）；
    - 无 cwd 的进 `__ungrouped__`（“未分组”），排最后。
  - `sortProjectSessions(details)`：running 优先 → `lastPromptAt` desc → id。
  - `orderProjectGroups(groups, boundSessionId)`：有 running 会话的组按最近活跃排前 →
    当前绑定项目 → 其余按最近活跃；`__ungrouped__` 兜底最后。
  - `resolveActiveProject(groups, boundSessionId)`：
    bound 项目 running 则选它 → 最近活跃的运行项目 → bound 项目 → 最近活跃项目。
- `listSessionDetails` 保持对外返回平铺顺序不变（调用方兼容），分组是纯派生。

### Phase 2 — 卡片交互（`src/index.ts` + `src/telegram/keyboard.ts`）

- `openSessionsCard(chatId, projectKey?, page)`：
  - `projectKey` 缺省 → `resolveActiveProject`；
  - `__all__` → 保留旧平铺视图；
  - 页头 `🧭 Sessions · <项目名> · 运行 k · 共 n`；
  - 运行会话行加 `▶`，归档加 `🗄`，行文沿用 HTML escape 规则。
- 新增 `openSessionProjectsCard(chatId, page)`：
  - 按钮 `📁 <label> ●k/共n`（12/页分页），token 只存短 id，项目 key 走 TokenRegistry；
  - 首行 `🌐 全部会话`；末行 Back。
- 新增回调：`sessions-project`、`sessions-projects-page`；`sessions-page` 保留兼容。
- `state` 增加 per-chat `lastSessionsProject`，详情页返回时回到原项目页；
  `buildSessionDetailKeyboard` 增加可选 `backToken` 参数，默认行为不变。
- 键盘：
  - `buildSessionsKeyboard` 顶部加 `[🔀 项目 (N)] [✨ New session]`；
    会话按钮标题统一用 `displayTitleFor`，running 加 `▶`。
  - 新增 `buildSessionProjectsKeyboard`。
- 会话详情卡显示项目名/路径一行（信息更完整）。

### Phase 3 — 测试与文档

- `test/sessions.test.mjs`：
  - 更新旧的“首条消息当标题”断言为 web 三级回退断言；
  - 冷会话 cwd 透传；`running` 按 `status` 判定；
  - `groupSessionsByProject` / `orderProjectGroups` / `resolveActiveProject` /
    `sortProjectSessions` 各 3-5 例（含同基名、无 workspace、无 cwd、归档会话、伪项目）。
- `test/keyboard.test.mjs`：两种新键盘的按钮顺序、截断、分页、back token。
- `npm run check` 全绿（当前基线 227/227）。
- TESTING.md 新增一节；findings.md / progress.md 追加本轮记录；README 的 `/sessions`
  说明更新。

## 4. 边界与风险

- **callback_data 64 字节上限**：项目 key（长路径）不塞进 callback_data，用现有 TokenRegistry
  存 `{ action, projectKey, page }`，按钮只放短 token。
- **同基名项目**：key 用 workspaceId / cwd 全路径，显示名用“基名”或“基名 (父目录)”消歧。
- **无 workspaceRegistry 的 profile**：全部按 cwd 伪项目分组；无 cwd 则回退旧平铺，不降级报错。
- **冷会话大日志**：优先 projection cache 读标题；cache 缺失才回退 `readRaw`（与现状等价）。
- **归档会话**：Telegram 继续显示但标 `archived`（现状行为），归组时仍按 workspace 账本归类。
- **不写回 web**：本计划不修改 web 本体、不重写历史标题；旧的“继续”标题等 web 后续更新后
  自然同步到 Telegram。

## 5. 交付顺序与验证

1. Phase 1 + 单测 → `npm run build && node --test test/sessions.test.mjs`。
2. Phase 2 + 键盘/路由测试 → `npm run check`。
3. 实机冒烟（可选，需 live bot）：`/sessions` 默认落在运行项目、`🔀 项目` 切换、
   detail 返回同项目、冷会话显示 cwd 基名标题。
