import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.mjs';
import { ManusClient } from '../src/manus.mjs';
import { StateStore } from '../src/state.mjs';
import { createWebhookServer, verifyWebhook } from '../src/webhook.mjs';

test('uploads a Feishu file before creating a Manus task', async () => {
  const calls = [];
  const client = new ManusClient('test-key', {
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('file.upload')) return Response.json({
        ok: true, file: { id: 'file-1' }, upload_url: 'https://upload.example.test/file',
        upload_expires_at: String(Math.ceil(Date.now() / 1000) + 180),
      });
      if (String(url) === 'https://upload.example.test/file') return new Response(null, { status: 200 });
      if (String(url).includes('file.detail')) return Response.json({ ok: true, file: { status: 'uploaded' } });
      return Response.json({ ok: true, task_id: 'task-1' });
    },
  });
  const state = await new StateStore(join(await mkdtemp(join(tmpdir(), 'manus-file-')), 'state.json')).load();
  const channel = {
    downloadResource: async () => Buffer.from('hello'),
    reply: async () => {},
  };
  await new Bridge({ channel, manus: client, state, allowedUsers: ['user'], allowedChats: [] }).handleMessage({
    messageId: 'm1', chatId: 'dm', chatType: 'p2p', senderId: 'user',
    content: 'Read this', resources: [{ type: 'file', fileKey: 'key', fileName: 'report.txt' }],
  });
  const create = calls.find(({ url }) => url.endsWith('task.create'));
  assert.deepEqual(JSON.parse(create.init.body).message.content, [
    { type: 'text', text: 'Read this' },
    { type: 'file', file_id: 'file-1' },
  ]);
  assert.equal(calls.find(({ url }) => url.startsWith('https://upload.')).init.headers, undefined);
});

test('signed webhook rejects tampering and replay, then deduplicates a valid event', async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ type: 'spki', format: 'pem' });
  const target = 'https://bridge.example.test/manus';
  const body = Buffer.from(JSON.stringify({
    event_id: 'evt-1', event_type: 'task_stopped', task_detail: { task_id: 'task-1' },
  }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (bytes, ts = timestamp) => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const signer = createSign('RSA-SHA256');
    signer.update(`${ts}.${target}.${digest}`);
    return signer.sign(privateKey, 'base64');
  };
  assert.equal(verifyWebhook({
    body, url: target, signature: sign(body), timestamp, publicKey: key,
  }), true);
  assert.equal(verifyWebhook({
    body: Buffer.from('changed'), url: target, signature: sign(body), timestamp, publicKey: key,
  }), false);
  assert.equal(verifyWebhook({
    body, url: target, signature: sign(body, '1'), timestamp: '1', publicKey: key,
  }), false);

  const state = await new StateStore(join(await mkdtemp(join(tmpdir(), 'manus-webhook-')), 'state.json')).load();
  await state.update((data) => {
    data.scopes.dm = { taskId: 'task-1', chatId: 'dm' };
  });
  let polls = 0;
  const server = createWebhookServer({
    url: target,
    manus: { webhookPublicKey: async () => ({ public_key: key }) },
    state,
    lifecycle: { pollScope: async () => { polls++; } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const local = `http://127.0.0.1:${server.address().port}/manus`;
  const post = (bytes, sig) => fetch(local, {
    method: 'POST', body: bytes,
    headers: { 'x-webhook-signature': sig, 'x-webhook-timestamp': timestamp },
  });
  assert.equal((await post(Buffer.from('changed'), sign(body))).status, 401);
  assert.equal((await post(body, sign(body))).status, 200);
  assert.equal((await post(body, sign(body))).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 1);
});
