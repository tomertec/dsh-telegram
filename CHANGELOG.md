# Changelog

All notable changes to dsh-telegram are documented here.
Versioning follows the npm package version in `package.json`.

## 0.3.0-rc.1

Telegram-first production hardening on top of the v0.2.0 web-parity baseline.

### Multi-chat isolation

- Per-chat agent bindings route sessions/events back to their own chat; dead bindings fail closed.
- Per-chat FIFO inbound router (rapid first messages cannot create two sessions).
- Rebinding a chat clears stale inbound quote state; `disallow`/security hot-update ejects the chat fully.
- `telegram_reply`/`telegram_mark_no_reply` resolve the inbound by the executing agent.
- Approval/question cards route to the session-owned chat; broadcast fallback only when unbound.

### Human-friendly Telegram UX

- Clickable Host directory browser (`Browse cwd`) with Up/Home/Root and 20-dir paging.
- Sessions card sorted by latest prompt, 10/page; History `Load older`.
- Models provider card 12/page; Plugins 20/page; Jobs 20/page; Search results 10/page.
- Confirm-before-destructive for session/workspace delete, preset remove, subagent interrupt.
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
- Malformed assistant events cannot throw the bridge listener; openclaw timers cancel on new turns.
- Long-poll restart aborts the previous generation; offset survives stop/start; token registry bounded.
- Unauthorized photos/media receive the allow prompt like text.

### Tests

- `npm run check`: 201/201 (unit + integration across adapters, bridge, router, transport, keyboard, config, tools).
- ESM smoke imports for `dist/index.js`, `dist/extensions/openclaw.js`, `dist/extensions/reasoning.js`.

## 0.2.0

- Native Telegram runtime adapter: grammY long polling, send queue + rate limit + retry.
- Web-parity cards for sessions, workspaces, goals, skills, subagents, presets, settings,
  credentials, llm/models, host, commands, jobs, plugins, dynamic inventory, feedback.
- Presets, menu paging, openclaw streaming draft, mid-session preset fork.
- Hot apply/update and teardown-safe plugin lifecycle.
