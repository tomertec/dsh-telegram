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
    onUnauthorized: (chatId, reason) => calls.push(`unauthorized:${chatId}:${reason ?? 'text'}`),
  });
  const h = t.handlers();
  await h.onText(9, '/start');
  await h.onText(9, 'hello');
  await h.onText(7, 'hello');
  await h.onText(7, '/status');
  await h.onCallback(9, 'm:sessions');
  await h.onCallback(9, 'm:allowthis');
  await h.onPhoto(9, 'file', '');
  assert.deepEqual(calls, ['unauthorized:9:command:start', 'unauthorized:9:text', 'text', 'command', 'callback', 'unauthorized:9:text']);
  await h.onPhoto(7, 'file', '');
  assert.deepEqual(calls, ['unauthorized:9:command:start', 'unauthorized:9:text', 'text', 'command', 'callback', 'unauthorized:9:text', 'photo']);
});

test('router serializes updates per chat in arrival order and isolates chats', async () => {
  const calls = [];
  const t = fakeTransport();
  attachRouter({
    transport: t,
    isAllowed: () => true,
    onCommand: () => calls.push('command'),
    onBarButton: () => calls.push('bar'),
    onCallback: () => calls.push('callback'),
    onUserText: (chatId, text) => {
      calls.push(`start:${chatId}:${text}`);
      return new Promise((resolve) => setTimeout(() => {
        calls.push(`end:${chatId}:${text}`);
        resolve();
      }, text === 'slow-7' ? 20 : 1));
    },
    onPhoto: () => calls.push('photo'),
    onUnauthorized: () => calls.push('unauthorized'),
  });
  const h = t.handlers();
  const p1 = h.onText(7, 'slow-7');
  const p2 = h.onText(7, 'fast-7');
  const p3 = h.onText(8, 'other-8');
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(calls.slice(0, 2), ['start:7:slow-7', 'start:8:other-8'], 'chat 8 starts while chat 7 is busy');
  const slowEnd = calls.indexOf('end:7:slow-7');
  const fastStart = calls.indexOf('start:7:fast-7');
  assert.ok(slowEnd !== -1 && fastStart !== -1 && slowEnd < fastStart, 'chat 7 updates run FIFO');
  assert.equal(calls.at(-1), 'end:7:fast-7');
});

test('a rejected handler does not wedge the per-chat chain', async () => {
  const calls = [];
  const t = fakeTransport();
  attachRouter({
    transport: t,
    isAllowed: () => true,
    onCommand: () => { throw new Error('boom'); },
    onBarButton: () => calls.push('bar'),
    onCallback: () => calls.push('callback'),
    onUserText: () => calls.push('text'),
    onPhoto: () => calls.push('photo'),
    onUnauthorized: () => calls.push('unauthorized'),
  });
  const h = t.handlers();
  await assert.rejects(h.onText(7, '/boom'));
  await h.onText(7, 'hello');
  assert.deepEqual(calls, ['text']);
});

test('router gates unsupported media by the whitelist and delegates allowed chats', async () => {
  const calls = [];
  const t = fakeTransport();
  attachRouter({
    transport: t,
    isAllowed: (chatId) => chatId === 7,
    onCommand: () => {},
    onBarButton: () => {},
    onCallback: () => {},
    onUserText: () => {},
    onPhoto: () => {},
    onDocument: (chatId, kind, fileId, name, mimeType) => calls.push({ chatId, kind, fileId, name, mimeType }),
    onUnauthorized: (chatId) => calls.push(`unauthorized:${chatId}`),
  });
  const h = t.handlers();
  await h.onDocument(9, 'document', 'f', 'x', 'text/plain');
  await h.onDocument(7, 'video', 'v', 'clip.mp4', 'video/mp4');
  assert.deepEqual(calls, ['unauthorized:9', { chatId: 7, kind: 'video', fileId: 'v', name: 'clip.mp4', mimeType: 'video/mp4' }]);
});
