import assert from 'node:assert/strict';
import test from 'node:test';
import { ManusApiError, ManusClient } from '../src/manus.mjs';

test('creates and continues a task using documented v2 requests', async () => {
  const calls = [];
  const client = new ManusClient('test-key', {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true, task_id: 'task-1', request_id: 'req-1' });
    },
  });
  await client.createTask('hello', { interactive_mode: true, share_visibility: 'private' });
  await client.sendMessage('task-1', 'continue');
  await client.detail('task-1');
  await client.listMessages('task-1', { order: 'asc', limit: 10 });
  await client.stop('task-1');
  assert.equal(calls.length, 5);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    message: { content: 'hello' },
    interactive_mode: true,
    share_visibility: 'private',
  });
  assert.equal(calls[0].init.headers['x-manus-api-key'], 'test-key');
  assert.equal(new URL(calls[3].url).searchParams.get('order'), 'asc');
  assert.deepEqual(JSON.parse(calls[4].init.body), { task_id: 'task-1' });
});

test('backs off on read limits but never retries an ambiguous write', async () => {
  let calls = 0;
  const client = new ManusClient('test-key', {
    sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? Response.json({ ok: false, request_id: 'req-429', error: { code: 'rate_limited', message: 'slow down' } }, { status: 429 })
        : Response.json({ ok: true, task: { id: 'task-1' } });
    },
  });
  await client.detail('task-1');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(client.createTask('hello'), (error) => {
    assert.ok(error instanceof ManusApiError);
    assert.equal(error.requestId, 'req-429');
    return true;
  });
  assert.equal(calls, 1);
});
