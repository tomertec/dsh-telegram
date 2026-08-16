import test from 'node:test';
import assert from 'node:assert/strict';
import { promptSubagent, interruptSubagent } from '../dist/harness/adapters/subagents.js';

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
  assert.deepEqual(captured.options, { source: { kind: 'user' } });
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
