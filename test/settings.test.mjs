import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceSettings, mutateSettings, describeSettings } from '../dist/harness/adapters/settings.js';

function ctxWith(service) {
  return { get: (key) => (key === 'settings' ? service : undefined) };
}

test('replaceSettings forwards the whole section and returns the refreshed view', async () => {
  const calls = [];
  const service = {
    writable: true,
    documentPath: '/tmp/settings.json',
    describe: () => [{ ns: 'llm', value: { provider: 'new' }, applies: 'live', revision: 3 }],
    replace: async (ns, section, expectedRevision) => {
      calls.push({ ns, section, expectedRevision });
    },
    update: async () => {},
    mutate: async () => {},
  };
  const res = await replaceSettings(ctxWith(service), 'llm', { provider: 'new' }, 2);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ ns: 'llm', section: { provider: 'new' }, expectedRevision: 2 }]);
  assert.equal(res.view?.revision, 3);
});

test('mutateSettings forwards the operation list', async () => {
  const calls = [];
  const service = {
    describe: () => [{ ns: 'llm', value: {}, applies: 'live', revision: 1 }],
    replace: async () => {},
    update: async () => {},
    mutate: async (ns, ops, expectedRevision) => {
      calls.push({ ns, ops, expectedRevision });
    },
  };
  const ops = [{ op: 'set', path: ['a'], value: 1 }, { op: 'unset', path: ['b'] }];
  const res = await mutateSettings(ctxWith(service), 'llm', ops);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ ns: 'llm', ops, expectedRevision: undefined }]);
});

test('replace/mutate degrade without the settings service', async () => {
  assert.equal((await replaceSettings(ctxWith(undefined), 'llm', {})).ok, false);
  assert.equal((await mutateSettings(ctxWith(undefined), 'llm', [])).ok, false);
  assert.equal(describeSettings(ctxWith(undefined)).writable, false);
});
