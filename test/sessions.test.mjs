import test from 'node:test';
import assert from 'node:assert/strict';
import { listQueue, updateQueueItem, searchSessions, readHistory, promptSession, listSessionDetails } from '../dist/harness/adapters/sessions.js';

function queueAgent(id, nextTurn, nextStep, status = 'idle') {
  const make = (items) => items.map((item) => ({ id: item.id, content: [{ type: 'text', text: item.text }] }));
  const nextTurnList = make(nextTurn);
  const nextStepList = make(nextStep);
  const inbox = {
    nextTurn: nextTurnList,
    nextStep: nextStepList,
    replace(id, message) {
      const list = nextTurnList.some((m) => m.id === id) ? nextTurnList : nextStepList;
      const index = list.findIndex((m) => m.id === id);
      if (index === -1) return false;
      list[index] = message;
      return true;
    },
    remove(id) {
      const list = nextTurnList.some((m) => m.id === id) ? nextTurnList : nextStepList;
      const index = list.findIndex((m) => m.id === id);
      if (index === -1) return false;
      list.splice(index, 1);
      return true;
    },
  };
  const agent = { id, inbox, status, steerCalls: [] };
  agent.steer = (message) => agent.steerCalls.push(message);
  return agent;
}

function fakeCtx(agent) {
  return {
    agents: {
      get: () => agent,
      list: () => (agent ? [agent] : []),
    },
    get: () => undefined,
    sessions: undefined,
    llm: undefined,
  };
}

test('listQueue projects both inbox targets in order', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], [{ id: 'b', text: 'two' }]);
  const items = listQueue(fakeCtx(agent), 's1');
  assert.deepEqual(items.map((item) => [item.itemId, item.target]), [['a', 'next-turn'], ['b', 'next-step']]);
  assert.equal(items[0].text, 'one');
});

test('updateQueueItem removes a pending item', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], []);
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'remove' });
  assert.equal(res.ok, true);
  assert.equal(agent.inbox.nextTurn.length, 0);
});

test('updateQueueItem edits a pending item in place', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], []);
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'edit', content: 'changed' });
  assert.equal(res.ok, true);
  const text = agent.inbox.nextTurn[0].content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  assert.equal(text, 'changed');
});

test('updateQueueItem steering is refused while idle', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], [], 'idle');
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'steer' });
  assert.equal(res.ok, false);
  assert.match(res.text, /steer-unavailable/);
});

test('updateQueueItem steering works while running', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], [], 'running');
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'steer' });
  assert.equal(res.ok, true);
  assert.equal(agent.steerCalls.length, 1);
  assert.equal(agent.inbox.nextTurn.length, 0);
});

test('updateQueueItem reports a missing item', () => {
  const agent = queueAgent('s1', [], []);
  const res = updateQueueItem(fakeCtx(agent), 's1', 'nope', { kind: 'remove' });
  assert.equal(res.ok, false);
  assert.match(res.text, /queue-item-not-found/);
});

test('searchSessions scans live logs with snippet cap', async () => {
  const events = [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'needle here' }] } },
    { seq: 1, type: 'assistant/message', data: { content: [{ type: 'text', text: 'another' }] } },
  ];
  const ctx = {
    sessions: { list: () => [{ id: 's9', events, header: { cwd: '/tmp' } }], get: (id) => ({ id, events, header: { cwd: '/tmp' } }) },
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
  };
  const hits = await searchSessions(ctx, 'needle');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 's9');
  assert.equal(hits[0].seq, 0);
  assert.equal(hits[0].snippet, 'needle here');
});

test('readHistory returns the requested window with roles', async () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    seq: i,
    type: i % 2 === 0 ? 'user/message' : 'assistant/message',
    data: { content: [{ type: 'text', text: `msg ${i}` }] },
  }));
  const ctx = {
    sessions: { list: () => [{ id: 's1', events, header: {} }], get: () => ({ id: 's1', events, header: {} }) },
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
  };
  const items = await readHistory(ctx, 's1', 4);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => item.seq), [6, 7, 8, 9]);
  assert.equal(items[0].role, 'user');
  assert.equal(items[1].role, 'assistant');
});

test('promptSession queues without waking', () => {
  const calls = [];
  const agent = { id: 's1', send(message, target, wakeup) { calls.push([target, wakeup]); }, followup() { throw new Error('must not followup'); }, steer() {} };
  const ctx = { agents: { get: () => agent, list: () => [agent] }, get: () => undefined, sessions: undefined, llm: undefined };
  const res = promptSession(ctx, 's1', 'later', 'queue');
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ['next-turn', false]);
});


test('listSessionDetails sorts by most recent prompt (web updatedAt desc)', async () => {
  const sessions = {
    list: () => [
      { id: 'old', events: [{ seq: 0, type: 'user/message', at: 100, data: { content: [{ type: 'text', text: 'old prompt' }] } }] },
      { id: 'new', events: [{ seq: 0, type: 'user/message', at: 300, data: { content: [{ type: 'text', text: 'new prompt' }] } }] },
      { id: 'never', events: [] },
    ],
  };
  const ctx = {
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? sessions : undefined),
  };
  const details = await listSessionDetails(ctx);
  assert.deepEqual(details.map((d) => d.id), ['new', 'old', 'never']);
  assert.equal(details[0].lastPromptAt, 300);
  assert.equal(details[1].title, 'old prompt');
  assert.equal(details[2].lastPromptAt, undefined);
});
