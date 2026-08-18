# dsh-telegram 死锁 / 卡死 / 无限递归 / 循环审计

日期：2026-08-18（Round 28 审计，Round 29 完成中风险落地）
范围：`src/**/*.ts` 全部 12.5k 行 + 关键集成路径
结论：**未发现跨模块互相等待的经典死锁**；6 个高风险点已在 Round 28 修复，8 个中风险点已在 Round 29 全部落地，另记录 1 个低风险内存增长点。Round 29 后 `npm run check` 340/340 pass。

## 审计方法

- 静态扫描全部 `while` / `for (;;)` / `setInterval` / `setTimeout` / `await` / promise 链 / 自递归调用。
- 逐模块审查并发结构：SendQueue、Router 双 FIFO lane、Ephemeral/StatusPanel 串行锁、sessionCreateChains、statusSubagentSync 共享闩锁、openclaw/GoalProgress 定时器。
- 检查所有网络调用（Bot API、fetch、文件/服务）是否带超时或上界。
- 用回归测试锁定修复：`npm run check` 319/319 pass。

## 已修复（高风险）

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| 1 | `src/index.ts` Status/Todo 卡切换 | Todo 卡 5s 定时器不感知 `ephemeral.open`；打开 Status 后下一 tick 会把 Todo 卡“复活”在 Status 卡上 | 新增 `openStatusPanel()`，打开 Status 前显式停 Todo 定时器并清 `activeCardRenderers`；集成测试锁定 |
| 2 | `src/index.ts` `statusSubagentSync` | 一个永不返回的 `listSubagents` 会让共享闩锁永久挂起，此后所有 `refreshAllPanels` 都 await 同一个 stuck promise | `withTimeout(5s)` 包裹每个查询，`finally` 保证闩锁必清 |
| 3 | `src/telegram/transport.ts` `downloadFile` | `getFile`/文件 `fetch` 无超时，坏连接永久卡住图片/文档入站 lane | `withTimeout(20s)` + `AbortSignal.timeout(60s)` |
| 4 | `src/telegram/transport.ts` `sendTextFallback` | 关键 ack 的 raw fetch 无超时 | `AbortSignal.timeout(15s)` |
| 5 | `src/telegram/transport.ts` `setCommands` | `/start` 路径 await 的 `setMyCommands` 无超时 | `withTimeout(20s)` |
| 6 | `src/harness/adapters/media.ts` `transcribeVoice` | 转写 fetch 无超时，会永久卡住 user lane | `AbortSignal.timeout(60s)` |
| 7 | `src/telegram/queue.ts` `takeSlot` | `maxPerWindow<=0` / `windowMs<=0` 时等待条件数学上不可达 → 无限循环（配置层已挡，公共类仍可被误构造） | 构造与 `configure` 做正数 clamp；回归测试 |
| 8 | `src/telegram/markdown.ts` `renderInline` | 嵌套 inline Markdown 无深度上限，超深输入 RangeError/栈溢出（表现为 bot 卡死） | `MAX_INLINE_DEPTH=32`，超限转义剩余文本；回归测试 |

## 中风险（Round 29 已全部落地）

1. ✅ **`statusSnapshot.eventStatsFor` 每次全量扫 `session.events`**：Bridge 对每个 tool/step 事件刷新面板 → 长会话 O(n²)，表现为“跑得越久 UI 越卡”。
   → `WeakMap<agent, {scannedEnd, stats, preset}>` 增量 tail 扫描；数组缩短回退全量重扫（`src/harness/adapters/status.ts`）。

2. ✅ **UI lane 数据加载无统一超时**：`modelCatalog/listSkills/listSubagents/listSessionDetails/...` 任一服务挂起会永久卡住该 chat 的 `uiChains`。
   → `cardLoad()` 10s deadline：model catalog / sessions / history / search / skills / subagents / subagent history / presets / feedback 全部接入，超时发可见失败卡片（`src/index.ts`）。

3. ✅ **`listDirectory` 的 `readdir/stat` 无超时**：坏盘/NFS 挂起卡住 Host/Workspace 卡。
   → `withFsTimeout(10s)` 覆盖 `readdir/stat/mkdir`（含 `isDirectory`），超时降级为错误提示（`src/harness/adapters/host.ts`）。

4. ✅ **interactive 零投递挂起**：approval/question 无人收到卡时 Promise 永不 settle。
   → `delivered.length === 0` 时 question reject、approval settle("cancelled")（`src/harness/adapters/interactive.ts`）。

5. ✅ **`exportSessionLog` 流式读无超时**：`reader.read()` 永不 done 会卡住 `/sessionlog`。
   → `AbortSignal.timeout(120s)` + 超时 `reader.cancel()`（`src/harness/adapters/downloads.ts`）。

6. ✅ **`SessionLifecycle.create` await 旧 agent `dispose()`**：dispose 永不 settle 会让 `sessionCreateChains` 卡死。
   → `disposeWithin(10s)` race；超时只记日志、不阻塞新会话创建（`src/harness/adapters/sessions.ts`）。

7. ✅ **`ensureOpencodeGoResponsesRoute` 单例闩锁**：`settings.update` 挂起时所有等待模型切换的调用复用同一 stuck promise。
   → 15s deadline + `finally` 清 latch，失败返回 false（`src/harness/adapters/opencodeGo.ts`）。

8. ✅ **内存增长**：`CompactionWatcher.states` / `toolCallCounts` / `Bridge.droppedEvents`。
   → 统一在 `session/disposed` 清理（另清 statusSubagentCounts 与 todoSnapshots）。

## 已确认安全的并发结构（审计通过）

- `SendQueue.push` / `Ephemeral.serialize` / `StatusPanel.serialize` / `Router.enqueue`：链式队列无自等待；API 调用都有 20s 上限（现在 fallback/download 也已补齐）。
- `TelegramTransport.start/stop`：有 generation + abort + 40s getUpdates 上限；并发 start/stop 有测试。
- `TokenRegistry`：双账本有界（1000 / 4000），不会无界增长或无限消费。
- `findWorkspaceRoot` / `splitText` / `markdownToHtml` 块级循环：均有明确的步进/终止条件。
- `openclaw` / `goal-progress` 定时器：turn 边界清理 + stale draft 守卫（前两轮已修）。
- 事件循环：`session/event` 监听器全部无自触发路径；`refreshAllPanels` 不回发事件。
