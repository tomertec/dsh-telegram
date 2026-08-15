# dsh 0.1.0-rc.6 Seam 审计

审计对象：全局 dsh 安装 `/home/ubuntu/.local/lib/node_modules/@deepseek-ai/dsh`（0.1.0-rc.6）
及其依赖闭包；本仓库 `node_modules` 中的 peer deps（`@deepseek-ai/*@0.1.0-rc.6`，cordis 4.0.1）。
以下签名均直接取自对应的 `.d.ts`，是 `src/harness/adapters/*` 的实现依据。

## 插件装载

- cordis 插件形态（`cordis/lib/types/registry.d.ts`）：
  `Plugin.Function(ctx, config)`、`Plugin.Constructor`、`Plugin.Object.apply(ctx, config)`。
  元数据 `name?`、`inject?`、`provide?`、`Config?`（standard-schema 校验器）。
- 本插件默认导出一个 function plugin 并挂 `name = 'telegram'`，loader 行的
  `config` 会原样传给 `apply(ctx, config)`。
- 安装方式（`dsh` README 已核实）：
  1. `dsh plugin --profile <name> add dsh-telegram`（等价于在 profile 目录跑 pnpm add）；
  2. 在 `<profile>/cordis.patch.yml` 的用户层添加
     `- insert: [{ id: telegram, name: 'dsh-telegram' }]`；
  3. 启动后通过 `/telegram start` 连接（长轮询）。
- 卸载/禁用：删除该 insert 行（或 `disabled: true`）后 reload。

## 入站：用户消息 → agent

- `Agent.followup(message: UserMessage): void`（`dsh-agent/lib/types/runtime-types.d.ts:115`）：
  普通 follow-up turn 的唯一消息，自动排队、唤醒 driver；忙时自然排队，**同步方法，不阻塞事件循环**。
- 构造消息：`createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })`
  （`dsh-llm/lib/types/message.d.ts:171`）。返回深冻结的不可变 `UserMessage`。
- 禁止直接用 `session.append()` 写入对话历史；入站必须走 inbox/followup。

## 出站：session/event → Telegram

- 事件签名（`dsh-session/lib/types/index.d.ts:66`）：
  `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`，
  fire-and-forget，观察者异常被日志包含。
- 事件负载：`SessionEvent = { type, seq, time, data }`（`dsh-session/lib/types/types.d.ts:420`）。
  发消息只依赖三个 surface 事件：
  - `user/message`: `data: UserMessage`
  - `assistant/message`: `data: { turn, step, message: AssistantMessage, usage? }`
  - `tool/result`: `data: { callId, content, isError }`（连同 `tool/call` 可用于工具执行提示）
- 文本块：`TextBlock = { type: 'text', text: string }`；推理块 `ReasoningBlock = { type: 'reasoning', text }`
  （`dsh-llm/lib/types/types.d.ts:38-46`）。
- 重要边界：构造器 seed（恢复/回放）**不**发 `session/event`；`session.firstLiveSeq` 是进程内
  第一条 live 事件 seq。插件只需要订阅事件，无需自行回放。
- `agent/status` 事件：`(payload: { agent, status: 'idle' | 'running' })`，可用于状态面板刷新。

## 会话生命周期

- `ctx.sessions: SessionStore`（`dsh-session/lib/types/index.d.ts:290`）：
  - `create(id?, options?): Session`（已在 store 中，并发出 `session/created`）
  - `get(id): Session | undefined`、`list(): Session[]`（创建顺序）
  - `fork(source, boundary?, childSessionId?): Session`
  - `flush(session): Promise<boolean>`
  - **没有 `restore`**：恢复持久化会话走 `ctx.agents.resume({ resumeSessionId })`。
- `ctx.agents: AgentRegistry`（`dsh-agent/lib/types/index.d.ts:209`）：
  - `create(options): Promise<AgentHandle>`；`resume(options): Promise<AgentHandle>`
  - `get(id)`、`list(): Agent[]`、`roots(): Agent[]`
  - `AgentHandle = { agent, dispose(): Promise<void> }`——句柄是能力：只有创建者能拆除。
  - 配置创建的启动 agent 归 loop 所有，无句柄；`/new` 新建的 agent 由本插件持有句柄并在替换时 dispose。
- `Agent`（`dsh-agent/lib/types/runtime-types.d.ts:60`）：`id/session/inbox/status/ctx/options`；
  `followup`、`cancel(cause, opts?)`、`whenIdle()`、`runMaintenance(task)`。
  `AgentCancelCause = { kind: 'user' | 'parent' | 'disposed' } | { kind: 'hook', reason }`
  （`dsh-session/lib/types/types.d.ts:118`）。
- 队列读数：`agent.inbox.nextTurn: readonly UserMessage[]`、`nextStep`、`hasPending`。

## 压缩

- 服务定义在独立包 `@deepseek-ai/dsh-compaction`（**不在 6 个原始 peer deps 中**，本插件只借用类型，
  运行时装不装都可用，缺省时降级为“未安装压缩后端”的可读错误）：
  - `ctx.compaction: CompactionEngine`（`dsh-compaction/lib/types/index.d.ts:62`）
  - `compactNow(agent: ManualCompactAgentContext, signal, sourceCommandId?): Promise<CompactionResult | null>`
    ——需要 agent 空闲；实现方是 `dsh-compaction-basic`。
  - 可预期失败抛 `ManualCompactionError`，`code: 'busy' | 'cancelled' | 'changed' | 'summary' | 'commit' | 'persistence'`。
  - 手动触发前必须 `await agent.whenIdle()` 或先 `agent.cancel({ kind: 'user' })`。
  - `sourceCommandId` 来自 `/telegram` 命令执行时 `CommandInvocation.commandId`。

## 模型

- `ctx.llm: LlmRuntime`（`dsh-llm/lib/types/index.d.ts`）：
  - `listProviders(): LlmProviderInfo[]`，`LlmProviderInfo = { id, name }`
  - `listModels(provider): Promise<LlmModelInfo[]>`，`LlmModelInfo = { provider, id, name, description?, inputModalities? }`
  - `resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>`（含 `context`、`reasoning`、`defaultMaxTokens`）
- 当前模型：`agent.options`（`AgentOptions = { provider?, model?, maxTokens? }`）。
- 模型切换无运行时 seam（agent.options 只读）；v0.1 模型页只读展示 + 重启指引。

## 插件清单 / 状态

- `ctx.loader: Loader`（`cordis-plugin-loader@1.0.2`，类型同样借自该包）：
  - `entries(): Generator<Entry, void, void>`；`Entry = { id, options: { name, config?, disabled? }, fiber?, ctx }`
  - `fiber.state: FiberState`（数字枚举 `PENDING|LOADING|ACTIVE|FAILED|DISPOSED|UNLOADING`）为运行状态来源。
  - 缺省（loaderd 不在）时降级：只显示自身条目。
- `ctx.agents.list()` + `ctx.sessions.list()` 合成状态卡；`agent.inbox.nextTurn.length` 为队列深度。

## Profile / Mode

- 运行时没有暴露 profile 名的 service。`dsh-app-boot` 只提供
  `ctx.dshHomePath?: typeof dshHomePath`（harness home 解析器）与 profile 目录约定
  （`$DSH_HOME/profiles/<name>`）。
- v0.1 决策（与 PLAN 一致）：`mode` 适配器展示
  “profile 名可从 `$DSH_HOME/profiles` 推断，模式切换需编辑 cordis.patch.yml 后重启”的可读指引；
  `config.mode` 允许用户在 `.pi/telegram.json` 里手工标注显示名。

## 工具注册（给 agent 用）

- `ctx.tools: ToolRuntime`（`dsh-tools/lib/types/index.d.ts`）：
  `register(definition: ToolDefinition): () => void`（返回精确 disposer）。
- 用 `defineTool({ name, description, parameters, output, execute })` 构造
  （`dsh-tools/lib/types/schema.d.ts:178`）。参数 schema 为隐式 open object 根：
  `parameters: { [k]: ParameterPropertySpec }`；输出需
  `output: { schema: ValueSchemaSpec, render(args, value): ContentBlock[] }`。
- 本插件的 5 个模型工具（telegram_send / telegram_reply / telegram_broadcast /
  telegram_status / telegram_mark_no_reply）全部 fire-and-forget 入发送队列，
  绝不 await Telegram I/O。

## 命令注册

- `ctx.commands: CommandRuntime`（`dsh-commands/lib/types/index.d.ts`）：
  `register(definition: CommandDefinition): () => void`。
- `CommandDefinition = { name, description, input?, recordInput?, handler(invocation) }`；
  `CommandInvocation = { commandId, agent, rawInput, signal }`。
- `handler` 返回 `CommandResult = { kind: 'success', text? } | { kind: 'error', text }`；
  执行由 UI 代理，失败会写 `command/done` 事件。
- 注册全局 `/telegram`（`start|stop|status` 子命令）与“全部功能卡”里同构的操作。

## 注意事项（来自源码注释，直接影响实现）

1. 会话/agent 由 fiber 所有：`ctx.sessions.create()` 的会话随调用 fiber 卸载而移除；
   因此会话创建/句柄持有必须发生在插件根 fiber（长生命周期）里，不能在 agent.ctx 里创建。
2. `session/event` 是 scope-filtered：根上下文订阅可见全部 session；agent 上下文订阅只看到本 agent。
   本插件始终在插件根 ctx 订阅，用 `session.id` 过滤到已绑定的 chat。
3. `AgentHandle.dispose()` 会 stop/drain/unregister/移除会话并解除 scoped world；
   `/new` 替换时 dispose 旧句柄即完成“旧会话归档”（持久化插件接管落盘）。
4. 消息内容块是 `ContentBlock[]` 且深冻结；转发文本只取 `type === 'text'` 块，
   reasoning/tool/image 在 v0.1 明确丢弃或折叠为一行提示。
5. 插件 `apply` 内所有 Telegram I/O 必须走 transport 队列（fire-and-forget），
   agent 事件监听器里禁止 await 网络。
