import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDocumentAttachment, transcribeVoice } from '../dist/harness/adapters/media.js';

test('transcribeVoice posts multipart form data to an OpenAI-compatible endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ text: '  hello from voice  ' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res = await transcribeVoice(new Uint8Array([1, 2, 3]), 'voice.ogg', { baseUrl: 'https://example.test/v1/', apiKey: 'key', model: 'whisper-1' }, {}, fetchImpl);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hello from voice');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/v1/audio/transcriptions');
  assert.equal(calls[0].headers.Authorization, 'Bearer key');
  assert.ok(calls[0].body instanceof FormData);
});

test('transcribeVoice degrades cleanly without a key and on provider errors', async () => {
  const missing = await transcribeVoice(new Uint8Array([1]), 'voice.ogg', {}, {}, async () => new Response('{}'));
  assert.equal(missing.ok, false);
  assert.match(missing.text, /api key/);

  const failing = await transcribeVoice(
    new Uint8Array([1]),
    'voice.ogg',
    { apiKey: 'k' },
    {},
    async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
  );
  assert.equal(failing.ok, false);
  assert.match(failing.text, /401/);
  assert.match(failing.text, /bad key/);
});

test('saveDocumentAttachment stores bytes under the session attachments directory', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-media-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const res = await saveDocumentAttachment('session-a', new Uint8Array([9, 9, 9]), '../../notes-中文.txt', 1234);
    assert.equal(res.ok, true);
    assert.match(res.path, /\/session-a\/attachments\/1234-notes/);
    assert.equal(existsSync(res.path), true);
    assert.deepEqual(await readFile(res.path), Buffer.from([9, 9, 9]));
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(base, { recursive: true, force: true });
  }
});
