import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRouter } from '../dist/telegram/router.js';

function fakeTransport() {
  let handlers;
  return {
    handlers: () => handlers,
    setHandlers(h) {
      handlers = h;
    },
  };
}

test('router maps dynamic Queue labels back to the canonical bar button', async () => {
  const calls = [];
  const t = fakeTransport();
  attachRouter({
    transport: t,
    isAllowed: () => true,
    onCommand: () => calls.push('command'),
    onBarButton: (_chatId, label) => calls.push(`bar:${label}`),
    onCallback: () => calls.push('callback'),
    onUserText: () => calls.push('text'),
    onPhoto: () => calls.push('photo'),
    onUnauthorized: () => calls.push('unauthorized'),
  });
  const h = t.handlers();
  await h.onText(7, '\u231B Queue \u00B7 9');
  await h.onText(7, '\u231B Queue \u00B7 0');
  await h.onText(7, '\u231B Queue');
  await h.onText(7, '\u2630 Menu');
  await h.onText(7, '\u231B Queueing');
  assert.deepEqual(calls, ['bar:\u231B Queue', 'bar:\u231B Queue', 'bar:\u231B Queue', 'bar:\u2630 Menu', 'text']);
});

test('router prompts unauthorized chats and gates their traffic', async () => {
  const calls = [];
  const t = fakeTransport();
  attachRouter({
    transport: t,
    isAllowed: (chatId) => chatId === 7,
    onCommand: () => calls.push('command'),
    onBarButton: () => calls.push('bar'),
    onCallback: () => calls.push('callback'),
    onUserText: () => calls.push('text'),
    onPhoto: () => calls.push('photo'),
    onUnauthorized: (chatId) => calls.push(`unauthorized:${chatId}`),
  });
  const h = t.handlers();
  await h.onText(9, '/start');
  await h.onText(9, 'hello');
  await h.onText(7, 'hello');
  await h.onText(7, '/status');
  await h.onCallback(9, 'm:sessions');
  await h.onCallback(9, 'm:allowthis');
  await h.onPhoto(9, 'file', '');
  assert.deepEqual(calls, ['unauthorized:9', 'unauthorized:9', 'text', 'command', 'callback']);
  await h.onPhoto(7, 'file', '');
  assert.deepEqual(calls, ['unauthorized:9', 'unauthorized:9', 'text', 'command', 'callback', 'photo']);
});
