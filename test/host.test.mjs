import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeHost, listDirectory, createDirectory, isDirectory, openPath, pickDirectoryHint, parentOf } from '../dist/harness/adapters/host.js';

test('listDirectory sorts directories before files and returns entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-list-'));
  try {
    mkdirSync(join(root, 'b-dir'));
    mkdirSync(join(root, 'a-dir'));
    writeFileSync(join(root, 'z-file.txt'), 'hello');
    const res = await listDirectory(root);
    assert.equal(res.ok, true);
    assert.deepEqual(res.entries.map((e) => e.name), ['a-dir', 'b-dir', 'z-file.txt']);
    assert.deepEqual(res.entries.map((e) => e.kind), ['directory', 'directory', 'file']);
    assert.match(res.text, /a-dir/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listDirectory fails with a readable error for a missing path', async () => {
  const res = await listDirectory('/definitely/not/here/dsh-telegram');
  assert.equal(res.ok, false);
  assert.ok(res.text.length > 0);
});

test('createDirectory creates a directory and rejects duplicates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-mkdir-'));
  try {
    const parent = join(root, 'nested');
    mkdirSync(parent);
    const target = join(parent, 'new');
    const res = await createDirectory(target);
    assert.equal(res.ok, true);
    assert.equal(await isDirectory(target), true);
    const duplicate = await createDirectory(target);
    assert.equal(duplicate.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host path helpers resolve, degrade, and walk up', async () => {
  assert.match(openPath('x/y').text, /x\/y/);
  assert.match(pickDirectoryHint('/tmp/current').text, /\/tmp\/current/);
  assert.equal(parentOf('/a/b/c'), '/a/b');
  assert.equal(parentOf('/'), '/');
  assert.equal(await isDirectory('/definitely/not/here/dsh-telegram'), false);
});


test('describeHost reports the bridge version instead of a fake host version', () => {
  const view = describeHost({ agents: { list: () => [] }, get: () => undefined }, '/tmp', '0.3.0');
  assert.equal(view.version, '0.3.0');
  assert.equal(view.cwd, '/tmp');
  assert.equal(view.attachedSessions, 0);
});

test('the exported plugin version matches package.json', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { version } = await import('../dist/index.js');
  assert.equal(version, pkg.version);
});

test('describeHost prefers agentDefaultModel like web host.describe', () => {
  const ctx = {
    agents: { list: () => [{ options: { provider: 'live-provider', model: 'live-model' } }] },
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) } : undefined),
  };
  const view = describeHost(ctx, '/tmp', '0.3.0');
  assert.equal(view.provider, 'default-provider');
  assert.equal(view.model, 'default-model');
  const fallback = describeHost({ agents: ctx.agents, get: () => undefined }, '/tmp');
  assert.equal(fallback.provider, 'live-provider');
});
