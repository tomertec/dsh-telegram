import test from 'node:test';
import assert from 'node:assert/strict';
import { listSubagents, promptSubagent, interruptSubagent } from '../dist/harness/adapters/subagents.js';

function makeCtx(service) {
  const parent = { id: 'parent-session' };
  return {
    get(key) {
      if (key === 'subagents') return service;
      return undefined;
    },
    agents: {
      get(id) {
        if (String(id) === 'parent-session') return parent;
        return undefined;
      },
    },
  };
}

test('promptSubagent passes text as a ContentBlock[] followup payload', async () => {
  let captured;
  const ctx = makeCtx({
    async followup(parent, childId, content, options) {
      captured = { parent, childId, content, options };
      return 'message-1';
    },
    interrupt() {},
  });

  const res = await promptSubagent(ctx, 'parent-session', 'child-session', 'hello subagent');

  assert.equal(res.ok, true);
  assert.deepEqual(captured.content, [{ type: 'text', text: 'hello subagent' }]);
  assert.equal(captured.options.source.kind, 'user');
  assert.equal(typeof captured.options.source.clientTimeZone, 'string', 'prompt provenance carries the Telegram client time zone');
  assert.equal(typeof captured.options.signal?.aborted, 'boolean', 'prompt carries a caller signal like the web contract');
  assert.equal(String(captured.childId), 'child-session');
});

test('promptSubagent degrades cleanly without the service or parent', async () => {
  assert.equal((await promptSubagent(makeCtx(undefined), 'parent-session', 'child', 'x')).ok, false);
  const ctx = makeCtx({ async followup() { return 'm'; }, interrupt() {} });
  assert.equal((await promptSubagent(ctx, 'missing-parent', 'child', 'x')).ok, false);
});

test('interruptSubagent addresses the child session with user authority', () => {
  let captured;
  const ctx = makeCtx({
    followup() {},
    interrupt(childId, authority) {
      captured = { childId, authority };
    },
  });
  const res = interruptSubagent(ctx, 'parent-session', 'child-session');
  assert.equal(res.ok, true);
  assert.equal(String(captured.childId), 'child-session');
  assert.equal(captured.authority.kind, 'user');
  assert.equal(String(captured.authority.parentSessionId), 'parent-session');
});


test('listSubagents projects web catalog fields and legacy fallbacks', async () => {
  const child = { id: 'child-session', kind: 'child', activity: 'running', mode: 'continuable', label: 'researcher', hasChildren: true };
  const diagnostic = { id: 'broken-session', kind: 'diagnostic', reason: 'corrupt' };
  const legacy = { id: 'legacy-session', kind: 'child' };
  const ctx = {
    agents: { get: (id) => ({ 'child-session': { status: 'running' }, 'legacy-session': { status: 'idle' } }[String(id)]) },
    get: (name) => (name === 'subagents' ? { listChildren: async () => [child, diagnostic, legacy] } : undefined),
  };
  const entries = await listSubagents(ctx, 'parent-session');
  assert.deepEqual(entries[0], { id: 'child-session', kind: 'child', activity: 'running', mode: 'continuable', label: 'researcher', hasChildren: true });
  assert.deepEqual(entries[1], { id: 'broken-session', kind: 'diagnostic', activity: 'inactive', reason: 'corrupt' });
  assert.equal(entries[2].activity, 'inactive', 'web remaps child rows to the live agent status, not the durable snapshot');
});

test('listSubagents degrades without the service or on listing errors', async () => {
  assert.deepEqual(await listSubagents({ get: () => undefined }, 'parent'), []);
  assert.deepEqual(await listSubagents({ get: () => ({ listChildren: async () => { throw new Error('boom'); } }) }, 'parent'), []);
});
