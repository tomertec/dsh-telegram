# Fork notice — security hardening

`tomertec/dsh-telegram` is a fork of [`xqicxx/dsh-telegram`](https://github.com/xqicxx/dsh-telegram)
at `v0.3.9` (upstream commit `3a05602`). It exists to close one critical hole and to remove a
supply-chain sharp edge. Everything else is upstream's work, unchanged.

## 1. Remote takeover via the self-service allow button (critical)

**Upstream behaviour.** Any Telegram user who could reach the bot — bot usernames are searchable and
enumerable — got full control of the agent in two taps:

1. Stranger sends any message to the bot.
2. `onUnauthorized` replies **to that stranger** with an inline `➕ Allow this chat` button.
3. `src/telegram/router.ts` exempted that one callback from the whitelist:
   `if (!deps.isAllowed(chatId) && data !== "m:allowthis") return;`
4. The handler pushed the stranger's `chatId` into `security.allowedChatIds` and **persisted it**
   to `.pi/telegram.json`.

The attacker then had everything the plugin exposes: arbitrary prompts to a tool-enabled coding
agent running on the host, plus `/host`, `/ls`, `/openpath`, `/credentials`, `/settingsupdate`,
`/plugins`. An empty allowlist did not help — the bypass did not depend on the allowlist's contents.
Upstream `test/security.test.mjs` asserted this as intended behaviour, so it is a design decision,
not an accident.

**This fork.**

- `src/telegram/router.ts` — no callback is exempt. `if (!deps.isAllowed(chatId)) return;`
- `src/index.ts` — the `m:allowthis` callback case is deleted, along with the
  `pendingStartAfterAllow` replay machinery and the grant button on the Allowed-chats card.
- `src/index.ts` — an unauthorized chat now gets a plain `🚫 This chat is not allowed.` with no
  buttons; the dsh host log prints the exact `/telegram allow <chatId>` line to run.
- `test/security.test.mjs` / `test/router.test.mjs` — rewritten as regression locks: an unauthorized
  chat that taps `m:allowthis` (or any callback) must stay out of the roster and out of the config,
  and no outbound message may carry an `allowthis` button.

Allowlisting is now host-only: `/telegram allow <chatId>` in dsh, or `security.allowedChatIds` in
`<workspace>/.pi/telegram.json`.

## 2. Lockfile pointed at a third-party registry

`package-lock.json` resolved all 34 packages from `registry.npmmirror.com` instead of
`registry.npmjs.org`. Rewritten to npmjs. The recorded integrity hashes validated unchanged against
npmjs content (`npm ci` clean, `npm audit` 0 vulnerabilities), so the mirror was serving genuine
tarballs — but a lockfile shipped to users should not silently redirect their installs.

## 3. Mixed-language UI

Upstream's English UI still rendered a scattering of Chinese labels — `收起`
(collapse), `项目` (projects), `归档`/`删除` (archive/delete), the session-card hint, the
queue hints, todo and compaction notices, and the whole stats/receipt strip. All of it is
English here; only the Chinese-language test fixtures (which exist to prove non-ASCII text
survives the pipeline) and the CJK filename character class in `media.ts` are untouched.

`LEGACY_COLLAPSE_BTN_ZH` / `LEGACY_RETURN_BTN_ZH` were added so a bar rendered by the previous
build — still sitting in an open chat — keeps working instead of sending its own label to the
agent as a message.

## Residual risk — inherent to any of these plugins

This plugin hands a tool-enabled coding agent on your machine a chat interface. That is the point of
it, and it means:

- **Your Telegram account is now a credential for your workstation.** Anyone who takes over that
  account, or an unlocked phone, drives the agent. Use 2FA on Telegram.
- **Prompt injection is code execution.** Content the agent reads — a repo, a web page, a pasted log
  — can steer it. Keep dsh's own approval/permission settings tight; do not run the agent with
  blanket tool approval just because approvals are now tappable from a phone.
- **Only allowlist private chats.** A group chat id in `allowedChatIds` gives every member of that
  group the same control. Nothing in the plugin restricts by chat type.
- **`TELEGRAM_BOT_TOKEN` is a live credential.** Env var only, never persisted by the plugin. If it
  leaks, revoke via `@BotFather` — a leaked token lets someone impersonate the bot and read what is
  sent to it.

## Verification

```
npm ci          # 0 vulnerabilities, integrity verified against registry.npmjs.org
npm run check   # tsc build + node --test
```

344 tests pass. Five failures are pre-existing on Windows and identical before and after these
changes: four assert POSIX path literals (`/a/b`) against `path.resolve` output, one is a
timing-sensitive backoff test. They are test-environment artifacts, not defects in the plugin.

Audited: no `child_process`, `eval`, or dynamic `require`; the only network egress is
`api.telegram.org` (plus `api.openai.com` / `opencode.ai` only if you explicitly configure those
adapters); credential values are write-only and never read back to Telegram.
