import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

test('broadcast roster only contains whitelisted chats and reconciles on allow/disallow', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-security-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;

  const subscribed = [];
  const sent = [];
  const ctx = {
    get: () => undefined,
    provide: (_name, value) => {
      ctx.services.set(_name, value);
    },
    on: (name) => {
      subscribed.push(name);
      return () => {};
    },
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
  };

  let handlers;
  const originalSetHandlers = TelegramTransport.prototype.setHandlers;
  const originalSendText = TelegramTransport.prototype.sendText;
  const originalEditText = TelegramTransport.prototype.editText;
  const originalDeleteMessage = TelegramTransport.prototype.deleteMessage;
  const originalSetCommands = TelegramTransport.prototype.setCommands;
  const originalSetMenuButton = TelegramTransport.prototype.setMenuButtonToCommands;
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originalSetHandlers.call(this, value);
  };
  TelegramTransport.prototype.sendText = async (chatId, text, options) => {
    sent.push({ chatId, text, options });
    return sent.length;
  };
  TelegramTransport.prototype.sendTextControl = TelegramTransport.prototype.sendText;
  TelegramTransport.prototype.sendTextFallback = TelegramTransport.prototype.sendText;
  TelegramTransport.prototype.editText = async () => true;
  TelegramTransport.prototype.editTextControl = async () => true;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.sendChatAction = async () => {};
  TelegramTransport.prototype.sendChatActionControl = async () => {};
  TelegramTransport.prototype.setCommands = async () => {};
  TelegramTransport.prototype.setMenuButtonToCommands = async () => {};

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [] } }));
    process.chdir(base);
    process.env.TELEGRAM_BOT_TOKEN = '123456:security-test';

    applyPlugin(ctx, {});

    const telegram = ctx.services.get('telegram');
    assert.ok(telegram);
    assert.deepEqual(telegram.chats(), []);

    // The web's forwarded host/remote events must all be subscribed: open
    // panels re-read their data source when any of them fires.
    for (const name of [
      'session/created', 'session/disposed', 'agent/error', 'domain/changed',
      'agent-preset/selected', 'commands/change', 'credentials/updated',
      'settings/document-updated', 'llm/adapters-updated',
      'cordis/request-run', 'cordis/request-run-resolved',
      'cordis/dynamic-package', 'cordis/dynamic-retract',
      'cordis/inspect-query', 'cordis/inspect-query-resolved',
    ]) {
      assert.ok(subscribed.includes(name), `missing subscription: ${name}`);
    }

    // An unauthorized `/start` gets the allow prompt and queues a welcome
    // replay for after the allow tap; it must not enter the roster yet.
    await handlers.onText(222, '/start');
    assert.deepEqual(telegram.chats(), []);

    // Agent tools must not bypass the whitelist either.
    const send = JSON.parse(await ctx.toolsDefs.get('telegram_send').execute({ chatId: '222', text: 'x' }));
    assert.equal(send.ok, false);
    assert.match(send.error, /not in the allowed roster/);
    const broadcast = JSON.parse(await ctx.toolsDefs.get('telegram_broadcast').execute({ targets: [{ chatId: '222' }], text: 'x' }));
    assert.equal(broadcast.ok, false);
    assert.match(broadcast.results[0].error, /not in the allowed roster/);

    // The self-service allow button promotes the chat and replays the /start
    // welcome the user originally asked for.
    await handlers.onCallback(222, 'm:allowthis');
    assert.deepEqual(telegram.chats(), [222]);
    assert.ok(sent.some((entry) => String(entry.text).includes('ready')), 'the queued /start welcome must land after allow');

    // A bound session must be unbound together with the roster slot so it
    // cannot keep receiving assistant events after losing whitelist access.
    telegram.bindAgent(222, 'fake-agent');
    assert.equal(telegram.chatIdForAgent('fake-agent'), 222);

    // dsh-side disallow must remove it immediately, without a restart.
    await ctx.command.handler({ rawInput: 'disallow 222' });
    assert.deepEqual(telegram.chats(), []);
    assert.deepEqual(telegram.getConfig().security.allowedChatIds, []);
    assert.equal(telegram.chatIdForAgent('fake-agent'), undefined);
  } finally {
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    TelegramTransport.prototype.setHandlers = originalSetHandlers;
    TelegramTransport.prototype.sendText = originalSendText;
    TelegramTransport.prototype.editText = originalEditText;
    TelegramTransport.prototype.deleteMessage = originalDeleteMessage;
    TelegramTransport.prototype.setCommands = originalSetCommands;
    TelegramTransport.prototype.setMenuButtonToCommands = originalSetMenuButton;
    rmSync(base, { recursive: true, force: true });
  }
});
