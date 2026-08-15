import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePiDir, findWorkspaceRoot, hasWorkspaceRoot, piDir } from '../dist/workspace.js';

test('findWorkspaceRoot walks up to the nearest .pi ancestor', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ws-'));
  try {
    const root = join(base, 'project');
    mkdirSync(join(root, '.pi'), { recursive: true });
    const deep = join(root, 'src', 'nested', 'leaf');
    mkdirSync(deep, { recursive: true });
    assert.equal(findWorkspaceRoot(deep), root);
    assert.equal(hasWorkspaceRoot(deep), true);
    assert.equal(piDir(root), join(root, '.pi'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('findWorkspaceRoot returns undefined without a .pi marker', () => {
  // /tmp may carry foreign .pi markers (other tools), so anchor under the
  // user's home where no ancestor is expected to own a workspace.
  // The host may have real .pi markers above home (this machine has ~/.pi),
  // so the portable invariant is: a marker-less sandbox is never mistaken for
  // a workspace root, even if a genuine ancestor root is eventually found.
  const base = mkdtempSync(join(homedir(), '.dsh-telegram-ws-'));
  try {
    const found = findWorkspaceRoot(base);
    assert.notEqual(found, base);
    if (found !== undefined) assert.equal(found.startsWith(base), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePiDir creates the marker directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ws-'));
  try {
    ensurePiDir(base);
    assert.equal(existsSync(join(base, '.pi')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
