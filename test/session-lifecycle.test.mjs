import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycle } from '../dist/harness/adapters/sessions.js';

test('SessionLifecycle.create falls back to agentDefaultModel on first new', async () => {
  const lifecycle = new SessionLifecycle();
  let captured;
  const ctx = {
    agents: {
      list: () => [],
      async create(opts) {
        captured = opts;
        return { agent: { id: 'telegram-fake', options: { provider: opts.agentOptions.provider, model: opts.agentOptions.model } } };
      },
    },
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4-flash' }) } : undefined),
  };
  const res = await lifecycle.create(ctx, '/tmp');
  assert.equal(res.result.ok, true);
  assert.equal(captured.agentOptions.provider, 'opencode-go');
  assert.equal(captured.agentOptions.model, 'deepseek-v4-flash');
  await lifecycle.dispose().catch(() => {});
});

test('SessionLifecycle.create inherits from a live agent when present', async () => {
  const lifecycle = new SessionLifecycle();
  let captured;
  const prev = { options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } };
  const ctx = {
    agents: {
      list: () => [prev],
      async create(opts) {
        captured = opts;
        return { agent: { id: 'telegram-fake', options: { provider: opts.agentOptions.provider, model: opts.agentOptions.model } } };
      },
    },
    get: () => ({ currentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4-flash' }) }),
  };
  const res = await lifecycle.create(ctx, '/tmp');
  assert.equal(res.result.ok, true);
  assert.equal(captured.agentOptions.provider, 'deepseek-official');
  assert.equal(captured.agentOptions.model, 'deepseek-v4-pro');
  await lifecycle.dispose().catch(() => {});
});

test('SessionLifecycle.create fails gracefully without agents service', async () => {
  const lifecycle = new SessionLifecycle();
  const res = await lifecycle.create({}, '/tmp');
  assert.equal(res.result.ok, false);
  await lifecycle.dispose().catch(() => {});
});
