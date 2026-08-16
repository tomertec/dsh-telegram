import test from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTransport() {
  const sent = [];
  return {
    sent,
    sendText: async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
    },
  };
}

function makeBridge(transport) {
  const agent = { id: 'agent-1', send: () => {}, followup: () => {} };
  const listeners = new Map();
  const ctx = {
    agents: {
      get: (id) => (id === 'agent-1' ? agent : undefined),
      list: () => [agent],
    },
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
    emit: (name, ...args) => {
      for (const cb of listeners.get(name) ?? []) cb(...args);
    },
  };
  return { agent, ctx };
}

async function setup() {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.attach();
  return { bridge, transport, ctx };
}

const am = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const turnEnd = (reason = { kind: 'completed' }) => ({ type: 'turn/end', data: { reason } });

test('legacy mode (no consumer): assistant text is forwarded immediately as a native reply', async () => {
  const { bridge, transport, ctx } = await setup();
  assert.equal(bridge.deliver(7, 'hi', 501).ok, true);
  ctx.emit('session/event', { id: 'agent-1' }, am('thinking out loud'));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].chatId, 7);
  assert.equal(transport.sent[0].text, 'thinking out loud');
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 501 });
  assert.equal(bridge.hasPendingInbound(), false, 'prose reply satisfies the inbound');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  await sleep(10);
  assert.equal(transport.sent.length, 1, 'no reminder after a prose reply');
});

test('legacy mode keeps the reminder when nothing answered', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.ok(transport.sent[0].text.includes('The turn ended without a telegram_reply'));
});

test('consumer mode: assistant text goes to the consumer, not the chat', async () => {
  const { bridge, transport, ctx } = await setup();
  const consumed = [];
  bridge.setAssistantConsumer((chatId, text) => consumed.push({ chatId, text }));
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, am('first'));
  ctx.emit('session/event', { id: 'agent-1' }, am('second'));
  await sleep(10);
  assert.equal(transport.sent.length, 0);
  assert.deepEqual(consumed, [
    { chatId: 7, text: 'first' },
    { chatId: 7, text: 'second' },
  ]);
  assert.equal(bridge.hasPendingInbound(), true, 'consumer owns the answered bookkeeping');
});

test('consumer mode: core suppresses the reminder and honors markInboundReplied', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.setAssistantConsumer(() => {});
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  await sleep(10);
  assert.equal(transport.sent.length, 0, 'core reminder is suppressed while a consumer is mounted');
  bridge.markInboundReplied();
  assert.equal(bridge.hasPendingInbound(), false);
});

test('consumer mode still surfaces turn errors verbatim', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.setAssistantConsumer(() => {});
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd({ kind: 'error', error: { message: 'boom <fail>' } }));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.ok(transport.sent[0].text.startsWith('\u274C'));
  assert.ok(transport.sent[0].text.includes('boom &lt;fail&gt;'));
});

test('unregistering the consumer restores legacy forwarding', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.setAssistantConsumer(() => {});
  bridge.setAssistantConsumer(undefined);
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, am('back to legacy'));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].text, 'back to legacy');
});

test('turn lifecycle notifies the typing callbacks (start -> end)', async () => {
  const calls = [];
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onTurnRunning: (chatId, running) => calls.push({ chatId, running }),
    log: () => {},
  });
  bridge.attach();
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  assert.deepEqual(calls, [
    { chatId: 7, running: true },
    { chatId: 7, running: false },
  ]);
  assert.equal(transport.sent.length, 1, 'no typing-hook chat message; only the legacy turn-end reminder');
  assert.ok(transport.sent[0].text.includes('telegram_reply'));
});

test('legacy delivery reports the Telegram message id for feedback buttons', async () => {
  const transport = makeTransport();
  transport.sendText = async (chatId, text, extra) => {
    transport.sent.push({ chatId, text, extra });
    return 321;
  };
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const deliveries = [];
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onAssistantDelivered: (chatId, telegramMessageId, sessionId, assistantMessageId) => {
      deliveries.push({ chatId, telegramMessageId, sessionId, assistantMessageId });
    },
    log: () => {},
  });
  bridge.attach();
  bridge.deliver(7, 'hi', 501);
  ctx.emit('session/event', { id: 'agent-1' }, {
    type: 'assistant/message',
    data: { message: { id: 'assistant-message-42', content: [{ type: 'text', text: 'answer' }] } },
  });
  await sleep(10);
  assert.deepEqual(deliveries, [
    { chatId: 7, telegramMessageId: 321, sessionId: 'agent-1', assistantMessageId: 'assistant-message-42' },
  ]);
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 501 });
});

test('outbound.liveFeed=false ignores a mounted stream consumer and restores legacy forwarding', async () => {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML', liveFeed: false } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.attach();
  const consumed = [];
  bridge.setAssistantConsumer((chatId, text) => consumed.push({ chatId, text }));
  assert.equal(bridge.deliver(7, 'hi', 501).ok, true);
  ctx.emit('session/event', { id: 'agent-1' }, am('answer'));
  await sleep(10);
  assert.deepEqual(consumed, [], 'consumer is registered but disabled by config');
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].text, 'answer');
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 501 });
  assert.equal(bridge.hasPendingInbound(), false);
});

test('a failed telegram_reply leaves the inbound pending for the error path', async () => {
  const transport = {
    sent: [],
    sendText: async () => { throw new Error('send failed'); },
  };
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.deliver(7, 'hi', 501);
  await assert.rejects(bridge.sendOutbound(7, 'reply', { replyToInbound: true }));
  assert.equal(bridge.hasPendingInbound(7), true, 'failed send must not mark the inbound answered');
});
