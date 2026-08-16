import test from 'node:test';
import assert from 'node:assert/strict';
import { questionKeyboard, questionIdAt, renderQuestions, attachInteractive } from '../dist/harness/adapters/interactive.js';

function fakeDelivery() {
  const sent = [];
  return {
    sent,
    async broadcast(text, keyboard, chatId) {
      sent.push({ text, keyboard, chatId });
      return [{ chatId: chatId ?? 111, messageId: 999 }];
    },
    async edit(chatId, messageId, text, keyboard) {
      sent.push({ edit: { chatId, messageId, text, keyboard } });
      return true;
    },
  };
}

function questionRequest(agentId, questions, signal) {
  return { agent: { id: agentId }, questions, ...(signal === undefined ? {} : { signal }) };
}

function fakeEvents() {
  const listeners = new Map();
  return {
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    listeners,
  };
}

function fakeCtx({ approval = false, userQuestions = false } = {}) {
  const events = fakeEvents();
  let provider;
  const ctx = {
    get: (name) => {
      if (name === 'approval' && approval) return {};
      if (name === 'userQuestions' && userQuestions) return {};
      return undefined;
    },
    registerProvider: undefined,
  };
  const questionsService = {
    registerProvider(p) {
      provider = p;
      return () => {
        provider = undefined;
      };
    },
  };
  ctx.userQuestionsService = questionsService;
  ctx.events = events;
  return ctx;
}

test('renderQuestions numbers questions and reflects selections', () => {
  const pending = {
    id: 7,
    sessionId: 's1',
    questions: [
      { id: 'q1', question: 'A or B?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', question: 'Why?' },
    ],
    selections: new Map([['q1', ['a']], ['q2', []]]),
    custom: new Map(),
  };
  const text = renderQuestions(pending, 0);
  assert.match(text, /1\. A or B\?/);
  assert.match(text, /✅ A/);
  assert.match(text, /○ B/);
  assert.match(text, /2\. Why\?/);
});

test('questionKeyboard builds one row per option plus submit/cancel', () => {
  const pending = {
    id: 7,
    sessionId: 's1',
    questions: [{ id: 'q1', question: 'A or B?', options: [{ id: 'a', label: 'A' }] }],
    selections: new Map([['q1', ['a']]]),
  };
  const keyboard = questionKeyboardFor(pending);
  const rows = keyboard.inline_keyboard;
  assert.equal(rows[0][0].callback_data, 'qu:7:0:a');
  assert.equal(rows[0][0].text.includes('✅'), true);
  assert.equal(rows[1][0].callback_data, 'qu:7:s');
  assert.equal(rows[1][1].callback_data, 'qu:7:c');
});

test('questionIdAt resolves the question by index', () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s1', [{ id: 'q-abc', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }]));
  promise.catch(() => {});
  assert.equal(questionIdAt(1, 0), 'q-abc');
  assert.equal(questionIdAt(1, 1), undefined);
  interactive.detach();
});

test('answerApproval settles once and rejects the second answer', () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = {
    get: (name) => (name === 'approval' ? {} : undefined),
  };
  ctx.on = events.on.bind(events);
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  assert.equal(typeof listener, 'function');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app1', callId: 'c1' } }] } },
    toolName: 'bash',
    callId: 'c1',
    reason: 'needs a shell',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  let settled;
  answer.then((outcome) => {
    settled = outcome;
  });
  const prompt = delivery.sent[0];
  const data = prompt.keyboard.inline_keyboard[0][0].callback_data;
  const id = Number(data.split(':')[1]);
  const first = interactive.answerApproval(id, 'allowed-once');
  assert.equal(first, true);
  assert.equal(interactive.answerApproval(id, 'rejected'), false);
  return answer.then((outcome) => {
    assert.equal(outcome, 'allowed-once');
    void settled;
    interactive.detach();
  });
});

test('approval waterfall defers to next when no matching approval/asked event', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [] } },
    toolName: 'bash',
    signal: undefined,
  };
  const outcome = await listener(req, async () => 'fallback');
  assert.equal(outcome, 'fallback');
  interactive.detach();
});

function questionKeyboardFor(pending) {
  return {
    inline_keyboard: [
      [{ text: '✅ A', callback_data: 'qu:7:0:a' }],
      [
        { text: '✔️ Submit', callback_data: 'qu:7:s' },
        { text: '✖ Cancel', callback_data: 'qu:7:c' },
      ],
    ],
  };
}

test('userQuestions provider is left alone when another UI owns it', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: { ask: async () => ({ answers: [] }) }, registerProvider() { registered += 1; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  assert.equal(registered, 0);
  interactive.detach();
});

test('userQuestions provider yields to a mounted web api proxy', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      return undefined;
    },
  };
  const interactive = attachInteractive(ctx, delivery);
  assert.equal(registered, 0);
  interactive.detach();
});

test('approval settle edits the card in place and removes its keyboard', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app2', callId: 'c2' } }] } },
    toolName: 'bash',
    callId: 'c2',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(id, 'allowed-once');
  await answer.catch(() => {});
  // The settle must edit the existing card (not spawn a second message) and
  // hand over no keyboard so the host can remove the now-dead buttons.
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.startsWith('🛡 Approval requested') && entry.edit.text.includes('allowed-once'));
  assert.ok(settle, 'settlement must edit the card in place');
  assert.equal(settle.edit.keyboard, undefined);
  assert.equal(settle.edit.messageId, 999);
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no separate settle message next to the card');
  interactive.detach();
});

test('approval request and settle route to the session-owned chat only', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 777 : undefined);
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's-owner', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app3', callId: 'c3' } }] } },
    toolName: 'bash',
    callId: 'c3',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  assert.equal(prompt.chatId, 777, 'request card goes to the owner chat');
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(id, 'allowed-once');
  await answer;
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.startsWith('🛡 Approval requested'));
  assert.ok(settle, 'settlement edits the card');
  assert.equal(settle.edit.chatId, 777, 'settle edit goes to the same chat, not every roster chat');
  interactive.detach();
});

test('question cards and the answered status route to the session-owned chat', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s-owner', [{ id: 'q1', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }]));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  assert.equal(prompt.chatId, 555);
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(555, id, 'q1', 'o1');
  await interactive.submitQuestions(555, id);
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text?.startsWith('✅ Questions answered'));
  assert.ok(settle, 'answered status edits the card in place');
  assert.equal(settle.edit.chatId, 555);
  assert.equal(settle.edit.keyboard, undefined);
  assert.equal(delivery.sent.filter((entry) => !entry.edit && entry.text?.startsWith('✅ Questions answered')).length, 0);
  interactive.detach();
});
