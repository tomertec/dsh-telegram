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

  const ctx = {
    get: () => undefined,
    provide: (_name, value) => {
      ctx.services.set(_name, value);
    },
    on: () => () => {},
    effect: () => {},
    tools: { register: () => {} },
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
  };

  let handlers;
  const originalSetHandlers = TelegramTransport.prototype.setHandlers;
  const originalSendText = TelegramTransport.prototype.sendText;
  const originalEditText = TelegramTransport.prototype.editText;
  const originalDeleteMessage = TelegramTransport.prototype.deleteMessage;
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originalSetHandlers.call(this, value);
  };
  TelegramTransport.prototype.sendText = async () => 71;
  TelegramTransport.prototype.editText = async () => true;
  TelegramTransport.prototype.deleteMessage = async () => {};

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [] } }));
    process.chdir(base);
    process.env.TELEGRAM_BOT_TOKEN = '123456:security-test';

    applyPlugin(ctx, {});

    const telegram = ctx.services.get('telegram');
    assert.ok(telegram);
    assert.deepEqual(telegram.chats(), []);

    // An unauthorized probe gets the allow prompt but must not enter the
    // roster that receives broadcasts and approval/question cards.
    await handlers.onText(222, 'hello');
    assert.deepEqual(telegram.chats(), []);

    // The self-service allow button promotes the chat.
    await handlers.onCallback(222, 'm:allowthis');
    assert.deepEqual(telegram.chats(), [222]);

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
    rmSync(base, { recursive: true, force: true });
  }
});
