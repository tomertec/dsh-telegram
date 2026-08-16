import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_LABELS, buildBackKeyboard, buildBarKeyboard, buildMenuPage, buildQueueKeyboard, buildThinkingKeyboard, buildModelDetailKeyboard, CALLBACK_RE, normalizeBarLabel, queueBarLabel } from '../dist/telegram/keyboard.js';

test('reply bar is the v0.6 layout (Menu/New/Models, Sessions/Plugins/Status, Presets/Queue/Compact, Stop)', () => {
  const bar = buildBarKeyboard();
  assert.equal(bar.keyboard.length, 4);
  assert.deepEqual(
    bar.keyboard.map((row) => row.map((b) => b.text)),
    [
      ['\u2630 Menu', '\u2728 New', '\u{1F9E9} Models'],
      ['\u{1F9ED} Sessions', '\u{1F50C} Plugins', '\u{1F4CA} Status'],
      ['\u{1F3AD} Presets', '\u231B Queue', '\u{1F9F9} Compact'],
      ['\u23F9 Stop'],
    ],
  );
  assert.equal(bar.is_persistent, true);
  assert.equal(bar.resize_keyboard, true);
});

test('queue card renders real edit/delete/steer buttons per item', () => {
  const kb = buildQueueKeyboard([
    { itemId: 'item-a', kind: 'next-turn' },
    { itemId: 'item-b', kind: 'next-step' },
  ]);
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.ok(rows[0][0].text.startsWith('\u270F'));
  assert.equal(rows[0][0].callback_data, 'q:item-a:e');
  assert.ok(rows[0][1].text.startsWith('\u{1F5D1}'));
  assert.equal(rows[0][1].callback_data, 'q:item-a:r');
  assert.ok(rows[0][2].text.startsWith('\u26A1'));
  assert.equal(rows[0][2].callback_data, 'q:item-a:s');
  assert.equal(rows[1].length, 2);
  assert.equal(rows[1][0].callback_data, 'q:item-b:e');
  assert.equal(rows[1][1].callback_data, 'q:item-b:r');
  assert.deepEqual(rows[2].map((b) => b.callback_data), ['m:back']);
});

test('BAR_LABELS keeps the old New label for stale persisted bars', () => {
  assert.ok(BAR_LABELS.includes('\u2728 New'));
});

test('bar embeds the live queue count without changing the rest of the layout', () => {
  const bar = buildBarKeyboard(7);
  assert.equal(bar.keyboard.length, 4);
  assert.deepEqual(bar.keyboard.map((row) => row.length), [3, 3, 3, 1]);
  const texts = bar.keyboard.flat().map((b) => b.text);
  assert.ok(texts.includes(queueBarLabel(7)));
  assert.ok(texts.includes('\u231B Queue') === false);
  for (const label of ['\u2630 Menu', '\u2728 New', '\u{1F9E9} Models', '\u{1F9ED} Sessions', '\u{1F50C} Plugins', '\u{1F4CA} Status', '\u{1F3AD} Presets', '\u{1F9F9} Compact', '\u23F9 Stop']) {
    assert.ok(texts.includes(label), `bar missing ${label}`);
  }
  assert.ok(texts.includes('\u{1F9E0} Reasoning') === false);
  assert.equal(bar.is_persistent, true);
  assert.equal(bar.resize_keyboard, true);
});

test('dynamic Queue labels normalize to the canonical bar button', () => {
  assert.equal(normalizeBarLabel('\u231B Queue'), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u231B Queue \u00B7 0'), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u231B Queue \u00B7 123'), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u231B Queue \u00B7 '), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u2630 Menu'), '\u2630 Menu');
  assert.equal(normalizeBarLabel('\u2728 New'), '\u2728 New');
  assert.equal(normalizeBarLabel('random text'), undefined);
  assert.equal(normalizeBarLabel('\u231B Queueing'), undefined);
});

test('menu page renders full rows, pairs, nav, and close', () => {
  const kb = buildMenuPage(
    [
      { label: '✨ New session · proj', cb: 'm:new', full: true },
      { label: '⌛ Queue · 2', cb: 'm:queue' },
      { label: '🎯 Goals', cb: 'm:goals' },
    ],
    0,
    2,
  );
  const rows = kb.inline_keyboard;
  assert.equal(rows[0].length, 1);
  assert.deepEqual(rows[0].map((b) => b.callback_data), ['m:new']);
  assert.equal(rows[1].length, 2);
  assert.deepEqual(rows[1].map((b) => b.callback_data), ['m:queue', 'm:goals']);
  assert.deepEqual(rows[2].map((b) => b.callback_data), ['m:page', 'm:more']);
  assert.deepEqual(rows[3].map((b) => b.callback_data), ['m:close']);
});

test('menu page nav adapts to first, middle, and last pages', () => {
  const items = [{ label: 'x', cb: 'm:x' }];
  const first = buildMenuPage(items, 0, 4).inline_keyboard;
  assert.deepEqual(first[1].map((b) => b.callback_data), ['m:page', 'm:more']);
  const middle = buildMenuPage(items, 1, 4).inline_keyboard;
  assert.deepEqual(middle[1].map((b) => b.callback_data), ['m:prev', 'm:page', 'm:more']);
  const last = buildMenuPage(items, 3, 4).inline_keyboard;
  assert.deepEqual(last[1].map((b) => b.callback_data), ['m:prev', 'm:page']);
});

test('back keyboard is a single m:back row', () => {
  const kb = buildBackKeyboard();
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.callback_data), ['m:back']);
});

test('CALLBACK_RE only accepts the m: prefix vocabulary', () => {
  assert.deepEqual('m:models'.match(CALLBACK_RE)?.[1], 'models');
  assert.equal(CALLBACK_RE.test('other:models'), false);
  assert.equal(CALLBACK_RE.test('m:UPPER'), false);
});

test('thinking keyboard lists the five fixed levels with the current one checked', () => {
  const kb = buildThinkingKeyboard(
    [
      { id: 'minimal', name: 'Minimal', cb: 't:1' },
      { id: 'low', name: 'Low', cb: 't:2' },
      { id: 'medium', name: 'Medium', cb: 't:3' },
      { id: 'high', name: 'High', cb: 't:4' },
      { id: 'max', name: 'Max', cb: 't:5' },
    ],
    'low',
  );
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 6);
  assert.equal(rows[0][0].callback_data, 't:1');
  assert.ok(rows[1][0].text.startsWith('\u2705'));
  assert.equal(rows[1][0].callback_data, 't:2');
  assert.ok(rows[2][0].text.startsWith('\u25CB'));
  assert.equal(rows[5][0].callback_data, 'm:back');
});

test('thinking keyboard marks medium as current when nothing selected', () => {
  const kb = buildThinkingKeyboard(
    [
      { id: 'minimal', name: 'Minimal', cb: 't:1' },
      { id: 'medium', name: 'Medium', cb: 't:2' },
      { id: 'max', name: 'Max', cb: 't:3' },
    ],
    'medium',
  );
  assert.ok(kb.inline_keyboard[1][0].text.startsWith('\u2705'));
});

test('model detail keyboard carries a Thinking row when reasoning is available', () => {
  const kb = buildModelDetailKeyboard([{ id: 'm1', name: 'Model One', cb: 't:1' }], { label: 'high', cb: 't:9' });
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0].callback_data, 't:9');
  assert.ok(rows[1][0].text.includes('Thinking'));
  assert.equal(rows[2][0].callback_data, 'm:models');
});

test('callback chat resolves from callback_query.message.chat (Bot API shape)', async () => {
  const { callbackUpdateChatId } = await import('../dist/telegram/transport.js');
  assert.equal(callbackUpdateChatId({ message: { chat: { id: 8753447694 } } }), 8753447694);
  assert.equal(callbackUpdateChatId({ chat: { id: 1 }, message: { chat: { id: 2 } } }), 2);
  assert.equal(callbackUpdateChatId({}), undefined);
  assert.equal(callbackUpdateChatId({ message: {} }), undefined);
});
