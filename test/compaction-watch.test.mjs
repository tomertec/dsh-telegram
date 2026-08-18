import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactionWatcher, contextUsageOf, shouldCompact } from '../dist/harness/adapters/compaction-watch.js';

const ev = (type, data = {}) => ({ type, data });

test('contextUsageOf reads the latest usage and request/context backwards', () => {
  const agent = {
    events: [
      ev('request/context', { contextWindow: 1000 }),
      ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 700, cacheReadTokens: 200, cacheWriteTokens: 0 } } }),
      ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 300, cacheWriteTokens: 0 } } }),
    ],
  };
  const usage = contextUsageOf(agent);
  assert.equal(usage.used, 800);
  assert.equal(usage.window, 1000);
  assert.equal(usage.ratio, 0.8);
});

test('shouldCompact respects threshold and cooldown', () => {
  assert.equal(shouldCompact(800, 1000, 0.8, undefined, 1000, 60_000), true);
  assert.equal(shouldCompact(799, 1000, 0.8, undefined, 1000, 60_000), false);
  assert.equal(shouldCompact(900, 1000, 0.8, 1000, 30_000, 60_000), false);
  assert.equal(shouldCompact(900, 1000, 0.8, 1000, 61_000, 60_000), true);
});

function harness(policy, threshold = 0.8, cooldownMs = 60_000) {
  const listeners = new Map();
  const calls = [];
  const ctx = {
    agents: { get: () => ({ id: 'agent-1', session: { events: [] }, options: {} }) },
    compaction: {
      async compactIfNeeded() {
        calls.push('compact');
        return {};
      },
    },
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
  };
  const watcher = new CompactionWatcher({
    ctx,
    log: () => {},
    chatIdForAgent: () => 7,
    threshold: () => threshold,
    policy: () => policy,
    cooldownMs: () => cooldownMs,
    askApproval: (chatId) => calls.push(`ask:${chatId}`),
    notify: (chatId, text) => calls.push(`notify:${text}`),
    now: () => Date.now(),
  });
  watcher.attach();
  const emit = (sessionId, event) => {
    for (const cb of listeners.get('session/event') ?? []) cb({ id: sessionId }, event);
  };
  return { watcher, calls, emit };
}

test('auto policy compacts once per cooldown after a pressure step', async () => {
  const { calls, emit } = harness('auto');
  emit('agent-1', ev('request/context', { contextWindow: 1000 }));
  emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 800, cacheReadTokens: 100 } } }));
  emit('agent-1', ev('step/end', {}));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['compact']);
});

test('ask policy asks exactly once and approve triggers compaction', async () => {
  const { watcher, calls, emit } = harness('ask');
  emit('agent-1', ev('request/context', { contextWindow: 1000 }));
  emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 850 } } }));
  emit('agent-1', ev('turn/end', {}));
  emit('agent-1', ev('turn/end', {}));
  assert.deepEqual(calls, ['ask:7'], 'one approval card per pressure episode');
  watcher.approve('agent-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['ask:7', 'compact']);
});

test('a watcher-triggered successful compaction is announced with its summary', () => {
  const { calls, emit } = harness('auto');
  emit('agent-1', ev('request/context', { contextWindow: 1000 }));
  emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 900 } } }));
  emit('agent-1', ev('step/end', {}));
  emit('agent-1', ev('compaction/summary', { shadowedTokenCount: 1234, summary: [{ type: 'text', text: 'kept the essence' }] }));
  emit('agent-1', ev('compaction/end', {}));
  assert.equal(calls.length, 2);
  assert.match(calls[1], /notify:.*上下文已压缩 ~1234 tokens/);
  assert.match(calls[1], /摘要: kept the essence/);
});

test('session disposal drops watcher state so a new episode can compact again (#20)', async () => {
  const listeners = new Map();
  const calls = [];
  const ctx = {
    agents: { get: () => ({ id: 'agent-1', session: { events: [] }, options: {} }) },
    compaction: { async compactIfNeeded() { calls.push('compact'); return {}; } },
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
  };
  const watcher = new CompactionWatcher({
    ctx,
    log: () => {},
    chatIdForAgent: () => 7,
    threshold: () => 0.8,
    policy: () => 'auto',
    cooldownMs: () => 60_000,
    askApproval: () => {},
    notify: () => {},
    now: () => Date.now(),
  });
  watcher.attach();
  const emit = (name, sessionId, event) => {
    for (const cb of listeners.get(name) ?? []) cb({ id: sessionId }, event);
  };
  const pressure = () => {
    emit('session/event', 'agent-1', ev('request/context', { contextWindow: 1000 }));
    emit('session/event', 'agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 800, cacheReadTokens: 100 } } }));
    emit('session/event', 'agent-1', ev('step/end', {}));
  };
  pressure();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['compact']);

  emit('session/disposed', 'agent-1', {});
  pressure();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['compact', 'compact'], 'cooldown latch was forgotten with the session');
  watcher.detach();
});
