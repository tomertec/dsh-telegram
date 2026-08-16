# Changelog

All notable changes to dsh-telegram are documented here.
Versioning follows the npm package version in `package.json`.

## 0.3.1

Issue #1: Telegram can now answer `ask_user_question` in the web profile and never loses early session events or final answers.

### Interactive question ownership

- New `interactive.userQuestions` config: `telegram` (default), `web`, or `auto`.
- `telegram` answers `ask_user_question` even when `@deepseek-ai/dsh-host-apiproxy` already owns the single `ctx.userQuestions` provider: it intercepts the public `tools/execute` seam instead of registering a second provider, so the service invariant is preserved and a clear startup diagnostic is emitted.
- `web` yields to the browser UI; `auto` keeps the legacy loader-entry inference.
- Question options now use their protocol `label` as the answer value, while callback data carries tiny numeric indexes (long labels can no longer break the 64-byte callback limit).

### Event ordering & final delivery

- `Bridge.deliver()` / `deliverImage()` install the chat binding and inbound quote before calling `agent.followup()` / `agent.send()`, so synchronous `turn/start` / `assistant/message` events can no longer be dropped as “no chat for agent”.
- Dropped events for a Telegram-touched but unbound agent are logged with a per-agent summary.
- Openclaw final-answer delivery moved outside the draft-existence guard: a turn whose live draft was never created still delivers the buffered answer (or the reminder), and final-send failures are logged.

## 0.3.0

Final release of the web-parity Telegram bridge: workspace-grouped sessions, goal/menu/bar ergonomics, direct session management, and release hardening.

### Sessions & workspaces

- Sessions grouped by workspace project; running project opens first; `🔀 项目` switcher plus `🌐 全部会话` flat view.
- Session titles follow the web chain exactly: `session/title` → cwd basename → id (cold-session JSONL parsing fixed).
- `running` mirrors `agent.status === 'running'`; cold sessions keep their header cwd.
- Per-row `归档` / `删除` actions on the Sessions card; archived sessions hide with a `🗄N` count.
- Workspace detail adds `✅ 使用此项目` and `🧭 会话`; the broken `w:create` callback dispatch is fixed.

### Goal & menu

- Goal is a display/edit/pause card (no Create button); `/goal <objective> [maxRounds]` starts it.
- Menu page 1 keeps Goal beside Capabilities; Watch moved to page 2.
- Menu page 1 adds a `💡 收起 Bar / 显示 Bar` switch; `/bar [on|off]` toggles the keyboard.
- Bar layout is `Menu/New/Models · Sessions/Plugins/Status · Goal/Queue/Compact · Stop/收起`.

### Bar & transport

- `🗜️ 收起` hides the bar without leaving a carrier message; restoring is explicit via Menu or `/bar`.
- The tapped collapse/return message stays in the chat.
- Exponential backoff for `getUpdates` 409 conflicts instead of retry spam.

## 0.3.0-rc.1

Telegram-first production hardening on top of the v0.2.0 web-parity baseline.

### Multi-chat isolation

- Per-chat agent bindings route sessions/events back to their own chat; dead bindings fail closed.
- Unbound chats fail closed for display too: Menu/Queue/Status never show another chat's agent or queue.
- Per-chat FIFO inbound router spans the whole create→bind→deliver path, so two rapid first messages can never create two sessions.
- Rebinding a chat clears stale inbound quote state; `disallow`/security hot-update ejects the chat fully.
- `telegram_reply`/`telegram_mark_no_reply` resolve the inbound by the executing agent.
- Approval/question cards route to the session-owned chat; broadcast fallback only when unbound.

### Human-friendly Telegram UX

- Clickable Host directory browser (`Browse cwd`) with Up/Home/Root and 20-dir paging.
- Sessions card sorted by latest prompt, 10/page; History `Load older`; no search clutter.
- Models provider card 12/page; Plugins 20/page; Jobs 20/page.
- Confirm-before-destructive for session/workspace delete, preset remove, subagent interrupt.
- Approval/question settlements edit the original card in place and remove its dead buttons.
- A first `/start` from an unauthorized chat replays the welcome automatically after the Allow tap.
- Project browser has an explicit `☰ Menu` return; Queue items are numbered with text previews.
- Queue actions are delete-and-resend (`🗑 Delete #N`) or `⚡ Run #N now` — no inline text editing.
- Step-by-step text prompts use Telegram ForceReply (input opens automatically); `/start` sets the official MenuButtonCommands.
- Presets/Workspaces/Sessions cards re-read their data in place when web-side settings/plugin events fire.
- Status card mirrors the web top bar: `router-<preset>`, subagent count, and running background jobs.
- Assistant replies stay clean: no 👍/👎/📋 feedback keyboard is attached (web feedback adapters remain for parity).
- Preset copy asks for a custom id; `/goaledit` supports maxGoalRounds.
- Skills card is session-scoped and user-invocable-only; subagent cards show mode/label/hasChildren/reason.
- `/attachment <id>` reads a photo back through its exact durable ref and sends it as a Telegram photo.
- document/voice/video receive a clear guidance reply instead of being silently dropped.
- `/credential` supports batch describe (≤64 refs); credential-set command message auto-deletes.
- `outbound.liveFeed` is a live switch for the Openclaw-style stream (no restart required).
- 15 web forwarded/host events refresh open panels only; no card, no message.

### Reliability & security

- Agent-tool `telegram_send`/`telegram_broadcast` targets are restricted to the allowed roster.
- Callback chat id reads the Bot API shape (`callback_query.message.chat`).
- Router dispatch promises are awaited, so command/bar-button/callback/photo handling is truly per-chat FIFO (no concurrent tap races).
- Malformed assistant events cannot throw the bridge listener; openclaw timers cancel on new turns.
- State-change panel refresh is forwarded exactly once and failures log the real `message + stack`.
- Long messages are split HTML-aware: never inside a tag or entity, with tags rebalanced per part.
- Send queue retries only transient failures (429/5xx/network/timeout); permanent Telegram 4xx fail once.
- Model/settings callback payloads are percent-encoded and decode safely; malformed legacy payloads never kill a tap.
- Callback tokens are single-use and bounded: a button can never execute twice, even on redelivery or a stale tap.
- `/credentialset` deletes the command message queue-ordered before its own reply, so the secret never lingers.
- `telegram_send`/`telegram_reply`/`telegram_broadcast` always deliver their HTML body as HTML.
- Typing keep-alive self-destructs after 10 minutes if a `turn/end` is lost.
- Long-poll restart aborts the previous generation; offset survives stop/start; token registry bounded.
- Unauthorized photos/media receive the allow prompt like text.

### Tests

- `npm run check`: 229/228 (unit + integration across adapters, bridge, router, transport, keyboard, config, tools); exported version is locked to package.json.
- ESM smoke imports for `dist/index.js`, `dist/extensions/openclaw.js`, `dist/extensions/reasoning.js`.

## 0.2.0

- Native Telegram runtime adapter: grammY long polling, send queue + rate limit + retry.
- Web-parity cards for sessions, workspaces, goals, skills, subagents, presets, settings,
  credentials, llm/models, host, commands, jobs, plugins, dynamic inventory (feedback adapters retained but the Telegram reply surface no longer attaches feedback buttons).
- Presets, menu paging, openclaw streaming draft, mid-session preset fork.
- Hot apply/update and teardown-safe plugin lifecycle.
