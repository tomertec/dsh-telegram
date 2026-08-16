import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalog, discoverModels } from '../dist/harness/adapters/llm.js';

function makeCtx({ providers = ['served', 'broken'], resolveError = false } = {}) {
  return {
    get: (name) => (name === 'llm' ? {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('catalog down');
        return [{ id: `${provider}-model`, name: `${provider} model` }];
      },
      resolveModelInfo: async () => {
        if (resolveError) throw new Error('info down');
        return { reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } };
      },
      discoverModels: async () => [],
    } : undefined),
  };
}

test('modelCatalog projects groups, failures, and web routable', async () => {
  const catalog = await modelCatalog(makeCtx(), { provider: 'served', model: 'served-model' });
  assert.equal(catalog.routable, true);
  assert.deepEqual(catalog.groups.map((group) => group.id), ['served'], 'failed providers go to failures, not groups');
  assert.deepEqual(catalog.failures, [{ provider: 'broken', message: 'catalog down' }]);
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, 'medium');

  const unroutable = await modelCatalog(makeCtx(), { provider: 'missing', model: 'x' });
  assert.equal(unroutable.routable, false);
});

test('modelCatalog degrades without llm and tolerates info failures', async () => {
  assert.deepEqual(await modelCatalog({ get: () => undefined }, { provider: 'p' }), {
    groups: [], failures: [], current: { provider: 'p' }, routable: true,
  });
  const catalog = await modelCatalog(makeCtx({ resolveError: true }), { provider: 'served' });
  assert.equal(catalog.groups[0].models[0].reasoning, undefined);
});

test('discoverModels keeps the apiKey out of the result and degrades without llm', async () => {
  const res = await discoverModels({ get: () => undefined }, 'ns', {});
  assert.equal(res.ok, false);
  assert.match(res.text, /unavailable/);
  const ok = await discoverModels(makeCtx(), 'ns', { provider: 'p', baseURL: 'https://x' });
  assert.equal(ok.ok, true);
});
