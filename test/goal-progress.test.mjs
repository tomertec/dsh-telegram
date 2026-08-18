import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalProgressFeed } from '../dist/telegram/goal-progress.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = (type, data = {}) => ({ type, data });

function harness({ liveRenderer = false, pending = false, notify = { onComplete: true, onLongTask: true } } = {}) {
  const listeners = new Map();
  const sends = [];
  const edits = [];
  const deps = {
    ops: {
      send: async (chatId, text, options) => {
        sends.push({ chatId, text, options });
        return sends.length;
      },
      edit: async (chatId, messageId, text, options) => {
        edits.push({ chatId, messageId, text, options });
        return true;
      },
      delete: async () => {},
    },
    log: () => {},
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    goalFor: () => ({ objective: 'research the market' }),
    todosFor: () => [
      { content: 'collect data', status: 'completed' },
      { content: 'write report', status: 'in_progress' },
    ],
    statusStats: () => ({
      turns: 2, steps: 4, toolCalls: 3, llmMs: 1000, toolMs: 2000, ttftMs: 100, ttftSteps: 2, decodeMs: 500, decodeTokens: 100,
      uncachedInputTokens: 300, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0,
    }),
    liveRendererActive: () => liveRenderer,
    pendingInbound: () => pending,
    notifyOnComplete: () => notify.onComplete !== false,
    notifyOnLongTask: () => notify.onLongTask !== false,
  };
  const ctx = {
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
  };
  const feed = new GoalProgressFeed(deps);
  feed.attach(ctx);
  const emit = (sessionId, event) => {
    for (const cb of listeners.get('session/event') ?? []) cb({ id: sessionId }, event);
  };
  return { feed, sends, edits, emit };
}

test('goal turn gets a progress card that finalizes into the openclaw receipt with hit rate', async () => {
  const { feed, sends, edits, emit } = harness();
  emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /research the market/);

  emit('agent-1', ev('step/start', { step: 2 }));
  emit('agent-1', ev('tool/call', { name: 'bash' }));
  emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0 } } }));
  await sleep(280);
  assert.ok(edits.length >= 1);
  assert.match(edits.at(-1).text, /step 2/);
  assert.match(edits.at(-1).text, /bash/);
  assert.match(edits.at(-1).text, /50%/, 'todo progress bar uses completed/total');

  emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  const final = edits.at(-1).text;
  assert.match(final, /✅ research the market/);
  assert.match(final, /🛠️ 1 tool calls/);
  assert.match(final, /💾 hit 44%/, 'openclaw receipt keeps the cache hit-rate line');
  assert.equal(feed.snapshot(7), undefined, 'turn end clears the running snapshot');
});

test('streaming renderer suppresses the card and inbound user turns stay silent', async () => {
  const withRenderer = harness({ liveRenderer: true });
  withRenderer.emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.equal(withRenderer.sends.length, 0);

  const inbound = harness({ pending: true });
  inbound.emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.equal(inbound.sends.length, 0);
});

test('goal heartbeat keeps the elapsed timer moving and completion pushes a fresh receipt (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { feed, sends, edits, emit } = harness();
  emit('agent-1', ev('turn/start', { turn: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sends.length, 1, 'initial progress card');
  const editsBefore = edits.length;

  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.ok(edits.length > editsBefore, 'silent tool still gets a 30s heartbeat edit');
  assert.match(edits.at(-1).text, /⏱️ 30s/);

  emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.equal(sends.length, 2, 'completion is a NEW message, not just an in-place edit');
  assert.equal(sends[1].options.disable_notification, false, 'completion push rings the user');
  assert.match(sends[1].text, /✅ research the market/);
  feed.detach();
});

test('notify.onLongTask/onComplete=false disables heartbeat and completion push (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { feed, sends, edits, emit } = harness({ notify: { onComplete: false, onLongTask: false } });
  emit('agent-1', ev('turn/start', { turn: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sends.length, 1, 'progress card still opens');
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(edits.length, 0, 'heartbeat switch off');
  emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.equal(sends.length, 1, 'completion push switch off');
  feed.detach();
});
