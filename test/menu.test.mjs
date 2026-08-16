import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuPage } from '../dist/telegram/keyboard.js';

test('menu page 1 shows More but no Prev and no dead page button', () => {
  const kb = buildMenuPage([{ label: 'A', cb: 'm:a' }, { label: 'B', cb: 'm:b' }], 0, 2);
  const texts = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(texts.includes('More ➡️'));
  assert.ok(!texts.some((t) => t.startsWith('Prev')));
  assert.ok(!texts.some((t) => /^\d+\/\d+$/.test(t)));
});

test('menu page 2 shows Prev but no More', () => {
  const kb = buildMenuPage([{ label: 'C', cb: 'm:c' }], 1, 2);
  const texts = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(texts.some((t) => t.includes('Prev')));
  assert.ok(!texts.some((t) => t.includes('More')));
  assert.ok(!texts.some((t) => /^\d+\/\d+$/.test(t)));
});

test('full-width items occupy their own row', () => {
  const kb = buildMenuPage(
    [{ label: 'New session', cb: 'm:new', full: true }, { label: 'Goals', cb: 'm:goals' }, { label: 'Workspaces', cb: 'm:workspaces' }],
    0,
    1,
  );
  const rows = kb.inline_keyboard;
  assert.equal(rows[0].length, 1);
  assert.equal(rows[1].length, 2);
});

test('extension menu items render in page 1 with reasoning present', async () => {
  const { reasoningExtension } = await import('../dist/extensions/reasoning.js');
  const items = reasoningExtension.menuItems?.({
    openCard: async () => {}, send: async () => undefined, token: (p) => 't:1',
    currentAgent: () => undefined, requireCtx: () => { throw new Error('no ctx'); },
    workspaceRoot: () => '/tmp', getConfigPath: () => undefined, applyConfig: () => [],
    refreshAllPanels: () => {},
  });
  assert.ok(items && items.length > 0);
  assert.ok(items[0].label.includes('Reasoning'));
  assert.equal(items[0].cb, 'm:thinking');
});
