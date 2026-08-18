import test from 'node:test';
import assert from 'node:assert/strict';
import { diffTodos, listTodos, pendingTodoCount, renderTodos, todoIcon, todoPriority } from '../dist/harness/adapters/todos.js';

const todo = (content, status = 'pending') => ({ content, status });

test('listTodos reads the latest todo/write snapshot and ignores malformed writes', () => {
  const agent = {
    session: {
      events: [
        { type: 'user/message', data: {} },
        { type: 'todo/write', data: { todos: [todo('old', 'completed')] } },
        { type: 'todo/write', data: { todos: [todo('do it', 'in_progress'), { content: 42, status: 'nope' }] } },
      ],
    },
  };
  const ctx = { agents: { get: () => agent } };
  assert.deepEqual(listTodos(ctx, 'a'), [todo('do it', 'in_progress'), todo('42', 'pending')]);
});

test('pendingTodoCount counts every status except completed', () => {
  assert.equal(pendingTodoCount([todo('a'), todo('b', 'in_progress'), todo('c', 'completed')]), 2);
});

test('diffTodos reports additions, transitions, and remaining work', () => {
  const diff = diffTodos(
    [todo('read docs'), todo('write code', 'in_progress'), todo('ship', 'pending')],
    [todo('read docs', 'completed'), todo('write code', 'in_progress'), todo('ship', 'completed'), todo('announce')],
  );
  assert.deepEqual(diff.added, [todo('announce')]);
  assert.deepEqual(diff.started, []);
  assert.deepEqual(diff.completed, [todo('read docs', 'completed'), todo('ship', 'completed')]);
  assert.equal(diff.remaining, 2);
});

test('priority and icons are display-only derivations from content tags', () => {
  assert.equal(todoPriority('[P0] auth outage'), 'high');
  assert.equal(todoPriority('🔴 fix leak'), 'high');
  assert.equal(todoPriority('medium clean up'), 'medium');
  assert.equal(todoPriority('water plants'), 'low');
  assert.equal(todoIcon(todo('x', 'completed')), '\u2705');
  assert.equal(todoIcon(todo('x', 'in_progress')), '\u23F3');
});

test('renderTodos keeps the card one readable line per todo', () => {
  const text = renderTodos([todo('a', 'completed'), todo('b')]);
  assert.match(text, /✅ a .* \[completed\]/);
  assert.match(text, /b .* \[pending\]/);
});
