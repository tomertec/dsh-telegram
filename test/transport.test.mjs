import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramTransport, callbackUpdateChatId } from '../dist/telegram/transport.js';

function makeTransport() {
  return new TelegramTransport({
    token: '123456:test-token',
    log: () => {},
    queue: { push: async (_key, fn) => fn(), pendingCount: () => 0, configure: () => {} },
  });
}

/** Long-poll stand-in that stays pending until the transport aborts it. */
function pendingPoll() {
  const calls = [];
  const options = [];
  return {
    calls,
    options,
    async getUpdates(opts, signal) {
      calls.push(signal);
      options.push(opts);
      await new Promise((resolve) => {
        const settle = () => {
          signal.removeEventListener('abort', settle);
          resolve();
        };
        if (signal.aborted) return settle();
        signal.addEventListener('abort', settle);
      });
      return [];
    },
  };
}

test('callbackUpdateChatId prefers the documented callback_query.message.chat shape', () => {
  assert.equal(callbackUpdateChatId({ message: { chat: { id: 42 } } }), 42);
  assert.equal(callbackUpdateChatId({ chat: { id: 7 }, message: { chat: { id: 9 } } }), 9);
  assert.equal(callbackUpdateChatId({}), undefined);
});

test('start aborts the previous long-poll generation before launching a new one', async () => {
  const transport = makeTransport();
  const poll = pendingPoll();
  transport.api.getUpdates = poll.getUpdates;

  await transport.start();
  assert.equal(poll.calls.length, 1);
  assert.equal(poll.calls[0].aborted, false);

  const stopping = transport.stop();
  assert.equal(poll.calls[0].aborted, true);
  await transport.start();
  assert.equal(poll.calls.length, 2);
  assert.equal(poll.calls[1].aborted, false);

  await stopping;
  await transport.stop();
  assert.equal(poll.calls[1].aborted, true);
});

test('concurrent start calls create one polling loop', async () => {
  const transport = makeTransport();
  const poll = pendingPoll();
  transport.api.getUpdates = poll.getUpdates;

  await Promise.all([transport.start(), transport.start(), transport.start()]);
  assert.equal(poll.calls.length, 1);
  await transport.stop();
});

test('poll offset is preserved across a stop/start generation', async () => {
  const transport = makeTransport();
  const offsets = [];
  transport.api.getUpdates = async (opts, signal) => {
    offsets.push(opts.offset);
    if (offsets.length === 1) {
      await new Promise((resolve) => {
        const settle = () => {
          signal.removeEventListener('abort', settle);
          resolve();
        };
        signal.addEventListener('abort', settle);
      });
      return [];
    }
    return [];
  };

  // First generation never receives updates, so offset stays at 0.
  await transport.start();
  assert.deepEqual(offsets, [0]);
  await transport.stop();

  // Second generation receives one update; the next long poll must stay
  // pending until stop() aborts it. Returning [] here would create a
  // microtask spin that starves the test timer (not a transport bug).
  transport.api.getUpdates = async (opts, signal) => {
    offsets.push(opts.offset);
    if (offsets[2] === undefined) return [{ update_id: 41, message: { chat: { id: 1 }, text: 'x' } }];
    await new Promise((resolve) => {
      const settle = () => {
        signal.removeEventListener('abort', settle);
        resolve();
      };
      if (signal.aborted) return settle();
      signal.addEventListener('abort', settle);
    });
    return [];
  };
  await transport.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await transport.stop();
  assert.deepEqual(offsets, [0, 0, 42]);
});

test('stop is idempotent and a later start works again', async () => {
  const transport = makeTransport();
  const poll = pendingPoll();
  transport.api.getUpdates = poll.getUpdates;

  await transport.start();
  await transport.stop();
  await transport.stop();
  await transport.start();
  await transport.stop();
  assert.equal(poll.calls.length, 2);
});

test('unsupported media routes to the document handler with metadata', async () => {
  const transport = makeTransport();
  const calls = [];
  transport.setHandlers({
    onText: () => {},
    onPhoto: () => {},
    onCallback: () => {},
    onDocument: (chatId, kind, fileId, name, mimeType, messageId) => calls.push({ chatId, kind, fileId, name, mimeType, messageId }),
  });
  await transport.handleUpdate({
    message: { message_id: 77, chat: { id: 7 }, document: { file_id: 'file-doc', file_name: 'notes.txt', mime_type: 'text/plain' } },
  });
  assert.deepEqual(calls, [{ chatId: 7, kind: 'document', fileId: 'file-doc', name: 'notes.txt', mimeType: 'text/plain', messageId: 77 }]);
  await transport.handleUpdate({ message: { message_id: 78, chat: { id: 7 }, voice: { file_id: 'file-voice', mime_type: 'audio/ogg' } } });
  assert.equal(calls[1].kind, 'voice');
  assert.equal(calls[1].messageId, 78);
});
