import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetStatusSession, noteToolCall, resetStatusStats, statusSnapshot } from '../dist/harness/adapters/status.js';

function agent(id, queue = []) {
  return {
    id,
    status: 'running',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    inbox: { nextTurn: queue, nextStep: [] },
  };
}

function fakeCtx(sessionId, projectionValues) {
  return {
    agents: { list: () => [agent(sessionId)], get: () => agent(sessionId) },
    get: (key) => {
      if (key === 'sessionProjections' && projectionValues !== undefined) {
        return { snapshot: (session) => ({ values: session.id === sessionId ? projectionValues : {} }) };
      }
      if (key === 'sessions') return { list: () => [{ id: sessionId }] };
      return undefined;
    },
  };
}

test('statusSnapshot degrades without the projection registry', () => {
  const snap = statusSnapshot(fakeCtx('s1', undefined));
  assert.equal(snap.queue, 0);
  assert.equal(snap.status, 'running');
  assert.equal(snap.stats, undefined);
});

test('statusSnapshot fails closed for an unbound chat when fallback is disabled', () => {
  const snap = statusSnapshot(fakeCtx('s1', undefined), undefined, false);
  assert.equal(snap.agentId, undefined);
  assert.equal(snap.status, 'none');
  assert.equal(snap.queue, 0);
});

test('statusSnapshot folds sessionStats and tokenUsage projections', () => {
  const snap = statusSnapshot(
    fakeCtx('s1', {
      sessionStats: { turns: 3, steps: 5, llmMs: 1200, toolMs: 300, ttftMs: 400, ttftSteps: 2, decodeMs: 2000, decodeTokens: 80 },
      tokenUsage: { uncachedInputTokens: 100, outputTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0 },
    }),
  );
  assert.equal(snap.stats.turns, 3);
  assert.equal(snap.stats.steps, 5);
  assert.equal(snap.stats.llmMs, 1200);
  assert.equal(snap.stats.toolMs, 300);
  assert.equal(snap.stats.uncachedInputTokens, 100);
  assert.equal(snap.stats.outputTokens, 80);
  assert.equal(snap.stats.cacheReadTokens, 400);
  assert.equal(snap.stats.toolCalls, 0);
});

test('noteToolCall counts per session and reset clears counters', () => {
  resetStatusStats();
  noteToolCall('s1');
  noteToolCall('s1');
  noteToolCall('s2');
  assert.equal(statusSnapshot(fakeCtx('s1', { sessionStats: {} })).stats.toolCalls, 2);
  assert.equal(statusSnapshot(fakeCtx('s2', { sessionStats: {} })).stats.toolCalls, 1);
  resetStatusStats();
  assert.equal(statusSnapshot(fakeCtx('s1', { sessionStats: {} })).stats.toolCalls, 0);
});

test('forgetStatusSession drops the live tool counter for a disposed session (#20)', () => {
  resetStatusStats();
  noteToolCall('gone');
  forgetStatusSession('gone');
  assert.equal(statusSnapshot(fakeCtx('gone', { sessionStats: {} })).stats.toolCalls, 0);
});

test('event stats scan incrementally instead of re-walking the whole log (#20)', async () => {
  const { statusSnapshot } = await import('../dist/harness/adapters/status.js');
  const raw = [
    { type: 'turn/start', data: {} },
    { type: 'step/start', data: {} },
    { type: 'tool/call', data: {} },
  ];
  let elementReads = 0;
  const events = new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) elementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const agent = {
    id: 'incr',
    status: 'running',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    session: { events, header: {} },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const ctx = {
    agents: { list: () => [agent], get: () => agent },
    get: () => ({ list: () => [] }),
  };

  assert.equal(statusSnapshot(ctx).stats.toolCalls, 1);
  const readsAfterFirst = elementReads;
  assert.ok(readsAfterFirst > 0, 'initial scan walks the existing tail');

  // Unchanged event array: cached scan end means zero event ELEMENT reads.
  assert.equal(statusSnapshot(ctx).stats.toolCalls, 1);
  assert.equal(elementReads, readsAfterFirst, 'cache hit never walks an event');

  // One appended event: exactly one tail scan (stats + preset), not a full rescan.
  raw.push({ type: 'tool/call', data: {} });
  assert.equal(statusSnapshot(ctx).stats.toolCalls, 2);
  assert.equal(elementReads, readsAfterFirst + 2, 'append walks only the newly appended tail');
});

test('renderStatsStrip mirrors the web stats line verbatim', async () => {
  const { renderStatsStrip } = await import('../dist/index.js');
  const strip = renderStatsStrip({
    turns: 6,
    steps: 6,
    toolCalls: 12,
    llmMs: 31900,
    toolMs: 2100,
    ttftMs: 2600,
    ttftSteps: 2,
    decodeMs: 2000,
    decodeTokens: 246,
    uncachedInputTokens: 40560,
    outputTokens: 3000,
    cacheReadTokens: 128440,
    cacheWriteTokens: 0,
  });
  assert.equal(strip, '📊 6 turns · 6 steps\n⚡ LLM 31.9s · tool time 2.1s\n🎯 first token avg 1.3s · 123 tok/s\n💾 cache hit 76%\n📝 in 169K tok · out 3K tok');
});

test('renderStatsStrip formats edge durations, tokens, and tps like the web', async () => {
  const { renderStatsStrip } = await import('../dist/index.js');
  assert.equal(
    renderStatsStrip({
      turns: 1, steps: 2, toolCalls: 0,
      llmMs: 45200, toolMs: 162000,
      ttftMs: 0, ttftSteps: 0,
      decodeMs: 1000, decodeTokens: 996,
      uncachedInputTokens: 517, outputTokens: 12300, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    '📊 1 turns · 2 steps\n⚡ LLM 45.2s · tool time 2m42s\n🎯 996 tok/s\n💾 cache hit 0%\n📝 in 517 tok · out 12.3K tok',
  );
  assert.equal(
    renderStatsStrip({
      turns: 0, steps: 0, toolCalls: 0,
      llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
      uncachedInputTokens: 0, outputTokens: 1234567, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    '📝 in 0 tok · out 1.2M tok',
  );
  assert.equal(
    renderStatsStrip({
      turns: 0, steps: 0, toolCalls: 0,
      llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    undefined,
  );
});

test('statusSnapshot resolves the agent preset from session events (official resolveSessionPreset semantics)', async () => {
  const { statusSnapshot } = await import('../dist/harness/adapters/status.js');
  const agent = {
    id: 's1',
    status: 'idle',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    session: {
      events: [
        { type: 'session', data: { agentPreset: 'code' } },
        { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
        { type: 'turn/start', data: {} },
      ],
    },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const ctx = {
    agents: { list: () => [agent], get: () => agent },
    get: () => ({ list: () => [1, 2] }),
  };
  const snap = statusSnapshot(ctx);
  assert.equal(snap.preset, 'standard');
});

test('statusSnapshot falls back to the preset carried by the first session event (#22)', async () => {
  const { statusSnapshot } = await import('../dist/harness/adapters/status.js');
  const agent = {
    id: 's1',
    status: 'idle',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    // Real session shape: `agent.session.header` does not exist; the preset
    // lives on events[0] (`{"type":"session","agentPreset":"standard"}`).
    session: { events: [{ type: 'session', data: { agentPreset: 'standard' } }, { type: 'turn/start', data: {} }] },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const ctx = { agents: { list: () => [agent], get: () => agent }, get: () => ({ list: () => [] }) };
  assert.equal(statusSnapshot(ctx).preset, 'standard');
});

test('statusSnapshot reads a preset flattened onto the session event envelope (#22)', async () => {
  const { statusSnapshot } = await import('../dist/harness/adapters/status.js');
  const agent = {
    id: 's1',
    status: 'idle',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    // Some persistence projections log `{"type":"session","agentPreset":...}`
    // with the header field on the envelope rather than under `data`.
    session: { events: [{ type: 'session', agentPreset: 'standard' }, { type: 'turn/start', data: {} }] },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const ctx = { agents: { list: () => [agent], get: () => agent }, get: () => ({ list: () => [] }) };
  assert.equal(statusSnapshot(ctx).preset, 'standard');
});

test('statusSnapshot keeps the fallback undefined when neither event source names a preset (#22)', async () => {
  const { statusSnapshot } = await import('../dist/harness/adapters/status.js');
  const agent = {
    id: 's1',
    status: 'idle',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    session: { events: [{ type: 'session', data: {} }, { type: 'turn/start', data: {} }] },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const ctx = { agents: { list: () => [agent], get: () => agent }, get: () => ({ list: () => [] }) };
  assert.equal(statusSnapshot(ctx).preset, undefined);
});

test('statusSnapshot counts turns/steps/tools/tokens from session events', async () => {
  const { statusSnapshot } = await import('../dist/harness/adapters/status.js');
  const agent = {
    id: 's1',
    status: 'running',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    session: {
      events: [
        { type: 'session', data: {} },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'tool/call', data: { name: 'bash' } },
        { type: 'assistant/chunk', data: { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900 } } },
        { type: 'step/end', data: {} },
        { type: 'turn/end', data: {} },
      ],
      header: {},
    },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const ctx = { agents: { list: () => [agent], get: () => agent }, get: () => ({ list: () => [] }) };
  const snap = statusSnapshot(ctx);
  assert.equal(snap.stats.turns, 1);
  assert.equal(snap.stats.steps, 1);
  assert.equal(snap.stats.toolCalls, 1);
  assert.equal(snap.stats.uncachedInputTokens, 100);
  assert.equal(snap.stats.outputTokens, 40);
  assert.equal(snap.stats.cacheReadTokens, 900);
});

test('zeroed projection does not shadow live event token counts', async () => {
  const { statusSnapshot } = await import('../dist/harness/adapters/status.js');
  const agent = {
    id: 's1',
    status: 'idle',
    options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    session: {
      events: [
        { type: 'turn/start', data: {} },
        { type: 'step/start', data: {} },
        { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900 } } } },
      ],
      header: {},
    },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const snapshots = new Map();
  const ctx = {
    agents: { list: () => [agent], get: () => agent },
    get: (name) => {
      if (name === 'sessionProjections') {
        return { snapshot: () => ({ values: { sessionStats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }, tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) };
      }
      if (name === 'sessions') return { list: () => [] };
      return undefined;
    },
  };
  const snap = statusSnapshot(ctx);
  assert.equal(snap.stats.turns, 1);
  assert.equal(snap.stats.steps, 1);
  assert.equal(snap.stats.uncachedInputTokens, 100);
  assert.equal(snap.stats.outputTokens, 40);
  assert.equal(snap.stats.cacheReadTokens, 900);
});
