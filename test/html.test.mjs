import test from 'node:test';
import assert from 'node:assert/strict';
import { bold, code, escapeHtml, link, plain, splitText, truncate } from '../dist/telegram/html.js';

test('escapeHtml neutralizes markup characters', () => {
  assert.equal(escapeHtml('a<b>&"c"\'d\''), 'a&lt;b&gt;&amp;&quot;c&quot;&#x27;d&#x27;');
  assert.equal(escapeHtml('plain'), 'plain');
  assert.equal(escapeHtml(''), '');
});

test('bold/code/link/plain escape their inputs', () => {
  assert.equal(bold('<x>'), '<b>&lt;x&gt;</b>');
  assert.equal(code('a&b'), '<code>a&amp;b</code>');
  assert.equal(link('x"y', 'https://e.test/?a=1&b=2'), '<a href="https://e.test/?a=1&amp;b=2">x&quot;y</a>');
  assert.equal(plain('<i>'), '&lt;i&gt;');
});

test('truncate keeps within max and appends an ellipsis', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w\u2026');
  assert.equal(truncate('hello world', 8).length, 8);
});

function checkSplit(text, max) {
  const parts = splitText(text, max);
  assert.equal(parts.join(''), text, 'splitting must preserve the payload');
  for (const part of parts) assert.ok(part.length <= max, `part ${JSON.stringify(part)} exceeds ${max}`);
  return parts;
}

test('splitText prefers newline boundaries', () => {
  assert.deepEqual(checkSplit('abc', 3), ['abc']);
  assert.deepEqual(checkSplit('one\ntwo', 4), ['one\n', 'two']);
  assert.deepEqual(checkSplit('line one\nline two\nline three', 9), ['line one\n', 'line two\n', 'line thre', 'e']);
});

test('splitText falls back to spaces and finally hard-splits', () => {
  assert.deepEqual(checkSplit('hello world', 6), ['hello', ' world']);
  assert.deepEqual(checkSplit('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  checkSplit('x'.repeat(5000), 4096);
});
