import test from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHost() {
  const host = {
    sends: [],
    edits: [],
    deletes: [],
    feedback: [],
    nextId: 100,
    inboundPending: false,
    liveFeed: true,
    inboundRepliedMarks: 0,
    consumer: undefined,
    consumed: [],
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    liveFeedEnabled: () => host.liveFeed !== false,
    bindAgent: () => {},
    unbindChat: () => {},
    send: async (chatId, text, options) => {
      const id = host.nextId++;
      host.sends.push({ chatId, text, options, id });
      return id;
    },
    editMessage: async (chatId, messageId, text, options) => {
      host.edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      host.deletes.push({ chatId, messageId });
    },
    attachFeedback: (chatId, telegramMessageId, sessionId, assistantMessageId) => {
      host.feedback.push({ chatId, telegramMessageId, sessionId, assistantMessageId });
    },
    statusStats: () => ({}),
    setAssistantConsumer: (consumer) => {
      host.consumer = consumer;
    },
    pendingInbound: () => host.inboundPending,
    inboundMessageId: () => (host.inboundPending ? 99 : undefined),
    markInboundReplied: () => {
      host.inboundRepliedMarks += 1;
      host.inboundPending = false;
    },  };
  return host;
}

function makeCtx(host) {
  const listeners = new Map();
  return {
    host,
    telegram: host,
    logger: { info: () => {} },
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
    emit: (sessionId, event) => {
      for (const cb of listeners.get('session/event') ?? []) cb({ id: sessionId }, event);
    },
  };
}

async function setup() {
  const host = makeHost();
  const ctx = makeCtx(host);
  const { apply } = await import('../dist/extensions/openclaw.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const ev = (type, data) => ({ type, data });

test('openclaw streams reasoning and tool lines then collapses to a summary', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Let me' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' check' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_1', name: 'bash', arguments: 'ls -la' }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'tool-result', isError: false }] } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  assert.equal(host.sends.length, 1);
  assert.equal(host.sends[0].text, '\u2699\uFE0F Working\u2026');
  assert.equal(host.sends[0].options.parse_mode, 'HTML');

  const messageId = host.sends[0].text === '\u2699\uFE0F Working\u2026' ? 100 : undefined;
  const edits = host.edits.filter((e) => e.messageId === messageId);
  assert.ok(edits.length >= 2, `expected streaming edit + summary edit, got ${edits.length}`);
  const lastStream = edits[edits.length - 2];
  assert.ok(lastStream.text.includes('\u2699\uFE0F Working\u2026'));
  assert.ok(lastStream.text.includes('\u{1F9E0}'));
  assert.ok(lastStream.text.includes('<i>Let me check</i>'));
  assert.ok(lastStream.text.includes('<b>\u2713 bash</b> <code>ls -la</code>'), 'result landed: ✓ icon, no trailing status');

  const summary = edits[edits.length - 1];
  assert.equal(summary.text, [
    '\u2699\uFE0F \u5B8C\u6210 \u00B7 \u23F1\uFE0F 1s',
    '\u2500'.repeat(9),
    '\u{1F9E0} 1 \u6B21\u601D\u8003 \u00B7 \u{1F6E0}\uFE0F 1 \u6B21\u5DE5\u5177',
    '\u{1F3AF} OpenClaw: 1 \u6B21 editText \u00B7 \u547D\u4E2D 100%',
  ].join('\n'));
  assert.equal(host.deletes.length, 0);
});

test('turn summary adds input/output tokens and cache hit rate', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'think' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_tok', name: 'bash', arguments: 'ls' }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 500, outputTokens: 120, cacheReadTokens: 400, cacheWriteTokens: 0 } } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const summary = host.edits.at(-1);
  assert.match(summary.text, /🧠 1 次思考 · 🛠️ 1 次工具/);
  assert.match(summary.text, /📥 输入 900 tok · 📤 输出 120 tok · 💾 命中 44%/);
});

test('turn summary appends the session stats line', async () => {
  const { host, ctx } = await setup();
  host.statusStats = () => ({
    turns: 4,
    steps: 279,
    llmMs: 46 * 60_000 + 41_000,
    toolMs: 5 * 60_000 + 10_000,
    ttftMs: 3500,
    ttftSteps: 1,
    decodeMs: 1000,
    decodeTokens: 68,
    uncachedInputTokens: 900,
    outputTokens: 120,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
  });
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'think' } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const summary = host.edits.at(-1);
  assert.match(summary.text, /📊 4 轮 · 279 步/);
  assert.match(summary.text, /⚡ LLM 46m41s · 工具调用 5m10s/);
  assert.match(summary.text, /🎯 首 token 平均 3\.5s · 68 tok\/s/);
});

test('tool result swaps the icon to ✓ and drops the running status', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_done', name: 'bash', arguments: 'ls' }));
  await sleep(1100);
  const runningEdit = host.edits.find((e) => e.text.includes('Working\u2026'));
  assert.ok(runningEdit.text.includes('<b>\u{1F6E0}\uFE0F bash</b> <code>ls</code> <i>running</i>'), 'running state: emoji + bold label + code detail + italic status');
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'call_done' }, content: [{ type: 'tool-result', isError: false }] } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const streamEdit = host.edits.filter((e) => e.text.includes('Working\u2026')).at(-1);
  assert.ok(streamEdit.text.includes('<b>\u2713 bash</b> <code>ls</code>'), 'completed icon ✓ and no trailing status');
  assert.ok(streamEdit.text.includes('<i>running</i>') === false);
});

test('tool line commits the reasoning burst and the next burst starts a new line', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'first burst' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_a', name: 'read', arguments: 'src/a.ts' }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'second burst' } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const streamEdit = host.edits.find((e) => e.text.includes('Working\u2026'));
  assert.ok(streamEdit, 'missing streaming edit');
  const first = streamEdit.text.indexOf('<i>first burst</i>');
  const tool = streamEdit.text.indexOf('\u{1F4C4}');
  const second = streamEdit.text.indexOf('<i>second burst</i>');
  assert.ok(first >= 0 && tool >= 0 && second >= 0);
  assert.ok(first < tool && tool < second, 'bursts interleave with the tool line');
  const summary = host.edits.at(-1);
  assert.equal(summary.text, [
    '\u2699\uFE0F \u5B8C\u6210 \u00B7 \u23F1\uFE0F 1s',
    '\u2500'.repeat(9),
    '\u{1F9E0} 2 \u6B21\u601D\u8003 \u00B7 \u{1F6E0}\uFE0F 1 \u6B21\u5DE5\u5177',
    '\u{1F3AF} OpenClaw: 1 \u6B21 editText \u00B7 \u547D\u4E2D 100%',
  ].join('\n'));
});

test('reasoning text is HTML-escaped and whitespace folds to one line', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: '<b>bold</b> & "quote"\nsecond line' } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const streamEdit = host.edits.find((e) => e.text.includes('Working\u2026'));
  assert.ok(streamEdit.text.includes('<i>&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quote&quot; second line</i>'));
  assert.ok(streamEdit.text.includes('<b>bold</b>') === false);
});

test('thinking line strips markdown noise and head-truncates at a word boundary', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  const long = `**bold** \`code\` # Heading ${'word '.repeat(40)}`;
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: long } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const streamEdit = host.edits.find((e) => e.text.includes('Working\u2026'));
  assert.ok(streamEdit.text.includes('bold code Heading'), 'markdown stripped');
  assert.ok(streamEdit.text.includes('**') === false && streamEdit.text.includes('`') === false);
  const line = streamEdit.text.split('\n').find((l) => l.startsWith('\u{1F9E0}'));
  assert.ok(line.length <= '\u{1F9E0} <i>'.length + 120 + '</i>'.length + 2);
  assert.ok(line.includes('\u2026</i>'), 'truncated with ellipsis and balanced italic');
});

test('block-end text snapshot replaces partial deltas of the same block', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'I' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' need' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'I need to check this' } } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const streamEdit = host.edits.find((e) => e.text.includes('Working\u2026'));
  assert.ok(streamEdit.text.includes('<i>I need to check this</i>'), 'snapshot replaced the partial stream');
  assert.ok(streamEdit.text.includes('<i>I needI need') === false, 'no duplication');
});

test('tool result with isError marks the line failed', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_err', name: 'edit', arguments: 'x' }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'call_err' }, content: [{ type: 'tool-result', isError: true }] } }));
  await sleep(1100);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);

  const streamEdit = host.edits.find((e) => e.text.includes('Working\u2026'));
  assert.ok(streamEdit.text.includes('<b>\u2717 edit</b>'));
  assert.ok(streamEdit.text.includes('<i>failed</i>'));
  assert.ok(streamEdit.text.includes('\u2713') === false);
});

test('empty turn sends an immediate placeholder, then cleans it up (#12)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.equal(host.sends.length, 1, 'feedback starts with turn/start, not the first stream event');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(host.sends.length, 1);
  assert.equal(host.edits.length, 0);
  assert.equal(host.deletes.length, 1);
});

test('telegram_reply tool detail shows the message body, not the JSON wrapper', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_r', name: 'telegram_reply', arguments: '{"text":"hello world"}' }));
  await sleep(1100);
  const streamEdit = host.edits.find((e) => e.text.includes('Working\u2026'));
  assert.ok(streamEdit.text.includes('<code>hello world</code>'));
  assert.ok(streamEdit.text.includes('{&quot;text&quot;') === false);
});


test('plugin registers as assistant consumer and buffers the latest block', async () => {
  const { host, ctx } = await setup();
  assert.equal(typeof host.consumer, 'function');
  host.consumer(7, 'step one');
  host.consumer(7, 'final answer');
  assert.equal(host.consumed.length, 0);
});

test('turn end delivers the buffered final answer and marks the inbound replied', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  host.consumer(7, 'clean <b>answer</b>', 'assistant-message-42');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  const answer = host.sends.find((s) => s.text.includes('clean'));
  assert.ok(answer, 'final answer delivered as a separate message');
  assert.ok(answer.text.includes('&lt;b&gt;answer&lt;/b&gt;'), 'answer HTML-escaped');
  assert.equal(answer.options.parse_mode, 'HTML');
  assert.deepEqual(answer.options.reply_parameters, { message_id: 99 });
  assert.deepEqual(host.feedback, [
    { chatId: 7, telegramMessageId: answer.id, sessionId: 'agent-1', assistantMessageId: 'assistant-message-42' },
  ], 'feedback keyboard attached once the final answer landed');
  assert.equal(host.inboundRepliedMarks, 1);
  assert.equal(host.inboundPending, false);
});

test('turn end delivers the buffered answer even when no live draft was created', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  // A dropped turn/start means no draft exists; the final answer must not be
  // suppressed by the draft guard.
  host.consumer(7, 'answer without a draft', 'assistant-message-no-draft');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  const answer = host.sends.find((s) => s.text.includes('answer without a draft'));
  assert.ok(answer, 'final answer is delivered without a progress draft');
  assert.deepEqual(host.feedback, [
    { chatId: 7, telegramMessageId: answer.id, sessionId: 'agent-1', assistantMessageId: 'assistant-message-no-draft' },
  ]);
  assert.equal(host.inboundRepliedMarks, 1);
});

test('openclaw final answers are normalized from Markdown to Telegram HTML', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  host.consumer(7, '**bold** and *italic*', 'assistant-message-markdown');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  const answer = host.sends.find((s) => s.text.includes('<b>bold</b>'));
  assert.ok(answer, 'markdown is normalized in the streamed final answer');
  assert.equal(answer.text, '<b>bold</b> and <i>italic</i>');
});

test('turn end sends the openclaw-mode reminder when nothing answered', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  const reminder = host.sends.find((s) => s.text.includes('The turn ended without a telegram_reply'));
  assert.ok(reminder, 'plugin owns the reminder while mounted');
  assert.equal(host.inboundRepliedMarks, 1);
});

test('turn end skips delivery when a tool reply already answered the inbound', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = false;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  host.consumer(7, 'post-reply narration');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.ok(host.sends.every((s) => !s.text.includes('post-reply narration')), 'no duplicate after tool reply');
  assert.equal(host.inboundRepliedMarks, 0);
});

test('a new turn cancels the previous draft throttle timer', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'stale' } }));
  assert.equal(host.sends.length, 1, 'placeholder for the first turn is created');
  ctx.emit('agent-1', ev('turn/start', { turn: 2 }));
  await sleep(1100);
  assert.equal(host.edits.length, 0, 'the old throttled edit must not fire into the new turn');
});

test('outbound.liveFeed=false disables the draft without unmounting', async () => {
  const { host, ctx } = await setup();
  host.liveFeed = false;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'silent' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_silent', name: 'bash', arguments: 'ls' }));
  await sleep(1100);
  assert.equal(host.sends.length, 0);
  assert.equal(host.edits.length, 0);
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.equal(host.sends.length, 0, 'disabled renderer must not deliver the turn-end answer');
  host.liveFeed = true;
});

test('identical re-renders are skipped so Telegram never gets a 400 not-modified (#15)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'same frame' } }));
  await sleep(1100);
  assert.equal(host.edits.length, 1, 'first frame is edited into the placeholder');
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'same frame' } }));
  await sleep(1100);
  assert.equal(host.edits.length, 1, 'identical re-render is a no-op');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
});

test('failed edits keep the same message instead of spawning new placeholders (#15)', async () => {
  const { host, ctx } = await setup();
  host.editMessage = async (chatId, messageId, text, options) => {
    host.edits.push({ chatId, messageId, text, options });
    return false;
  };
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'first' } }));
  await sleep(1100);
  assert.equal(host.sends.length, 1, 'one placeholder only');
  assert.equal(host.edits.length, 1);
  assert.equal(host.edits[0].messageId, 100);
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' second' } }));
  await sleep(1100);
  assert.equal(host.sends.length, 1, 'failure must not clear messageId and send a second placeholder');
  assert.ok(host.edits.length >= 2);
  assert.ok(host.edits.every((edit) => edit.messageId === 100), 'every retry targets the same message');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
});

test('a failed edit is retried on the same message after backoff (#15)', async () => {
  const { host, ctx } = await setup();
  let failures = 1;
  host.editMessage = async (chatId, messageId, text, options) => {
    host.edits.push({ chatId, messageId, text, options });
    if (failures > 0) {
      failures -= 1;
      return false;
    }
    return true;
  };
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'retry me' } }));
  await sleep(1100);
  assert.equal(host.edits.length, 1, 'first edit failed');
  await sleep(1700);
  assert.equal(host.edits.length, 2, 'backoff retried the same frame');
  assert.deepEqual(host.edits.map((edit) => edit.messageId), [100, 100]);
  assert.match(host.edits[1].text, /retry me/);
  assert.equal(host.sends.length, 1, 'no second placeholder was created');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
});

test('a failed placeholder sends one fallback and never spawns more placeholders (#15)', async () => {
  const { host, ctx } = await setup();
  host.send = async (chatId, text, options) => {
    host.sends.push({ chatId, text, options });
    return undefined;
  };
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await sleep(20);
  assert.equal(host.sends.length, 2, 'placeholder attempt + one fallback notice');
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'more stream' } }));
  await sleep(1100);
  assert.equal(host.sends.length, 2, 'later chunks must not create placeholder after placeholder');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
});
