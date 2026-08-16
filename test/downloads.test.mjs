import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSessionLog, TELEGRAM_DOCUMENT_LIMIT_BYTES } from '../dist/harness/adapters/downloads.js';

test('Telegram document limit is exactly the Bot API 50 MB bound', () => {
  assert.equal(TELEGRAM_DOCUMENT_LIMIT_BYTES, 50 * 1024 * 1024);
});

test('exportSessionLog degrades with web guidance when the export seam is absent', async () => {
  // This repo does not depend on @deepseek-ai/dsh-host-apiproxy, so the
  // dynamic seam load must fail closed with guidance instead of throwing.
  const oldHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    const res = await exportSessionLog({ get: () => undefined }, 'session-1', false);
    assert.equal(res.result.ok, false);
    assert.match(res.result.text, /web UI/);
    assert.equal(res.buffer, undefined);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
});
