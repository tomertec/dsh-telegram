# dsh-telegram

A native Telegram bridge plugin for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh `0.1.0-rc.6`): chat with your dsh agent from a phone, watch its status, and drive sessions/models/plugins/compaction through button menus — without slowing the agent down.

- Fully async: long polling, a global rate-limit + per-chat FIFO send queue, and exponential backoff all run outside the agent loop.
- Button-first UX modeled on `codex-telegram-bot` / `pi-telegram`: a persistent reply-keyboard bar plus ephemeral inline cards.
- Mirrors the web UI's exposed surface: sessions (create/search/history/rename/fork/resume/prompt/queue/model/attachment), workspaces, goals, message feedback, skills, subagents, agent presets, host settings, credentials, models/discovery, host filesystem, commands, jobs, session-log downloads, plugin inventory + enable/disable, dynamic plugin inventory, and inline approval/question answering.
- HTML parse mode with strict escaping everywhere — user content is never parsed as markup.

## Requirements

- Node.js ≥ 22
- dsh `0.1.0-rc.6` with a profile that includes `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-commands` (every shipped bundle does)
- A Telegram bot token (create one with [@BotFather](https://t.me/BotFather))

## Install

```sh
# 1. install into a profile (forwards to pnpm in the profile directory)
dsh plugin --profile <name> add dsh-telegram

# 2. add the loader entry to <profile>/cordis.patch.yml (user layer)
#    - insert:
#        - id: telegram
#          name: dsh-telegram

# 3. provide the token (never written to disk)
export TELEGRAM_BOT_TOKEN='123456:ABC...'
```

Start the profile, then in the dsh UI run:

```sh
/telegram start        # begin long polling (or set watch.autoStart: true)
/telegram allow <id>   # whitelist your chat id (or tap "Allow this chat" once polled)
```

From then on, send `/start` to the bot in Telegram to see the welcome message and the persistent button bar.

## Buttons

Persistent reply-keyboard bar (3 × 3):

```text
☰ Menu    ✨ New     🧹 Compact
🧩 Models  🔌 Plugins 🎭 Mode
🧭 Sessions 📊 Status ⏹ Stop
```

`☰ Menu` opens the core card: status text, current model, queue depth, ✨ New / 🧹 Compact, then one row per web domain — Sessions, Status, Plugins, Mode, Workspaces, Goals, Skills, Subagents, Presets, Host settings, Credentials, Host, Jobs, Dynamic, Capabilities, Settings. The "All functions" card carries the same domains plus Usage/Queue, Allowed chats, Watch toggle, and About.

Every web-exposed ApiProxy/Typert method is reachable from Telegram. The full
web-interface ↔ Telegram mapping lives in [`PLAN.md`](PLAN.md) (sections A–D);
`/capabilities` shows which seams are live in the running profile.

## Configuration

The plugin reads `<workspace>/.pi/telegram.json`, where the workspace is the nearest ancestor directory containing `.pi`. All fields are optional:

```json
{
  "security": { "allowedChatIds": [123456789] },
  "watch": { "autoStart": false },
  "inbound": {
    "defaultMode": "auto-handle",
    "rules": [{ "chatId": 123456789, "pattern": "urgent", "mode": "queue-only" }]
  },
  "outbound": {
    "parseMode": "HTML",
    "disableNotification": false,
    "maxRetries": 3,
    "sendRatePerSecond": 20,
    "maxMessageLength": 4096
  },
  "mode": { "name": "headless" }
}
```

- `security.allowedChatIds` — inbound whitelist; **empty denies all inbound traffic**.
- `inbound.defaultMode` — `auto-handle` (agent followup turn), `queue-only` (parked in the inbox without waking the agent), or `muted` (ignored). `rules` match in order (first match wins) on `chatId` and/or case-insensitive substring `pattern`.
- `watch.autoStart` — start polling as soon as an agent is created.
- The token comes **only** from `TELEGRAM_BOT_TOKEN`; it is never persisted.

## Agent tools

The plugin registers five tools the model can call:

| Tool | Purpose |
| --- | --- |
| `telegram_send` | Send HTML to one chat id |
| `telegram_reply` | Reply to the current inbound Telegram message |
| `telegram_broadcast` | Send one HTML message to several chats |
| `telegram_status` | Report bridge/agent/inbox state |
| `telegram_mark_no_reply` | Mark the inbound message as intentionally unanswered |

## Slash commands (dsh side)

`/telegram status` · `/telegram start` · `/telegram stop` · `/telegram allow <chatId>` · `/telegram disallow <chatId>` · `/telegram watch on|off` · `/telegram config auto-start`

Telegram-side commands: `/start /menu /new /compact /stop /models /sessions /workspaces /goals /skills /subagents /presets /plugins /hostsettings /credentials /host /jobs /status /help` plus `/history [id] [limit]`, `/search <query>`, `/rename <title>`, `/fork [atSeq]`, `/use <id>`, `/archive <id>`, `/queue`, `/queueedit <itemId> <text>`, `/steer <text>`, `/goalcreate <objective> [maxRounds]`, `/goaledit <text>`, `/workspacecreate <path> [title]`, `/workspacepin <workspaceId> <sessionId> [before]`, `/pluginenable|plugindisable <name>`, `/settingsdescribe [ns]`, `/settingsupdate <ns> <json>`, `/credential|credentialset|credentialunset <REF> [value]`, `/ls [path]`, `/mkdir <path>`, `/discover <settingsNs> [baseURL]`, `/subagentprompt <text>`, `/sessionlog [id]`, `/commands`, `/capabilities`.

## Platform limits (shown as guidance in chat)

- `host.pickDirectory` / `host.openPath` have no phone-side native dialog — the bot guides with a text path instead.
- `downloads.sessionLog` streams the same ZIP as the web; files over 50 MB are handed off to the web download with a link/instruction.
- `dynamicCordisRunner` run/stop/dependency mutations and plugin install/uninstall remain web-panel operations (read-only inventory + guidance in chat).
- Long polling only (no webhook); replies are per completed assistant message (no token streaming).
- Out-of-tree plugin packages need their optional peers `@deepseek-ai/dsh-compaction` / `@deepseek-ai/cordis-plugin-loader` only if you want the typed seam at build time; at runtime missing services degrade to readable errors.

## Hot update & hot plug (cordis-native)

- `apply(ctx, config)` consumes the loader entry config (the official config
  channel); `.pi/telegram.json` stays the file fallback.
- `internal/update` waterfall live-applies config changes (whitelist, inbound
  rules, outbound rate/retry/length, watch.autoStart) and vetoes the restart,
  following the include plugin's official pattern. `SendQueue.configure` and
  `TelegramTransport.applyLimits` hot-adjust the running limiter.
- Disable the entry (`loader.update` / `/plugindisable` on itself, or the
  profile patch) or edit the source under the `hmr` plugin: `teardownMount()`
  reverses every mount effect (transport, bridge, interactive, panels,
  pending state, model selections, session lifecycle), and `apply` is
  idempotent — reload 800 次 ≡ 冷启动（论文 Theorem 73 的 Confluence 约定）。
- `ctx.provide("telegram", …)` exposes `getConfig/status/chats/sendText/
  broadcast/start/stop` to other plugins.
- Telegram-side `/config get|set <path> [json]` and dsh-side
  `/telegram config get|set <path> <json>` hot-apply and persist any config
  leaf (e.g. `outbound.sendRatePerSecond`).

## Live test

`TESTING.md` records the isolated live-bot harness (temp `DSH_HOME` +
`test/telegram-live-overlay.yml`) and the manual acceptance checklist.

## Development

```sh
npm install
npm run check          # tsc build + node --test
npm pack --dry-run     # verify the publish payload (dist + README + LICENSE)
```

Verified dsh seams are documented in [`docs/SEAMS.md`](docs/SEAMS.md).

## License

MIT
