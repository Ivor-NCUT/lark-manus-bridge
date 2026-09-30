import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Lifecycle } from '../src/lifecycle.mjs';
import { StateStore } from '../src/state.mjs';

test('delivers only after background work finishes and does not repeat after restart', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'manus-lifecycle-')), 'state.json');
  let state = await new StateStore(path).load();
  await state.update((data) => {
    data.scopes.dm = { taskId: 'task-1', chatId: 'dm', replyTo: 'm1', status: 'running', startedAt: Date.now() };
  });
  const sent = [];
  let background = true;
  const channel = { rawClient: { im: { v1: { message: {
    reply: async (args) => { sent.push(args); return { data: { message_id: `out-${sent.length}` } }; },
  } } } } };
  const manus = {
    listMessages: async () => ({
      messages: [
        { id: 'a1', type: 'assistant_message', assistant_message: {
          content: 'Final answer', delivery_kind: 'result',
          attachments: [{ filename: 'report.pdf', url: 'https://files.example.test/report.pdf' }],
        } },
        { id: 's1', type: 'status_update', status_update: { agent_status: 'stopped' } },
      ],
    }),
    detail: async () => ({ task: { has_running_background_jobs: background } }),
  };
  let lifecycle = new Lifecycle({ channel, manus, state });
  await lifecycle.pollScope('dm');
  assert.equal(sent.length, 0);
  background = false;
  await lifecycle.pollScope('dm');
  assert.equal(sent.length, 1);
  assert.match(sent[0].data.content, /Final answer/);
  assert.match(sent[0].data.content, /临时下载链接/);
  assert.match(sent[0].data.content, /report.pdf/);
  state = await new StateStore(path).load();
  lifecycle = new Lifecycle({ channel, manus, state });
  await lifecycle.pollScope('dm');
  assert.equal(sent.length, 1);
  assert.equal(state.scope('dm').lastEventId, 's1');
});

test('reports errors and keeps topic replies in the original thread', async () => {
  const state = await new StateStore(join(await mkdtemp(join(tmpdir(), 'manus-error-')), 'state.json')).load();
  await state.update((data) => {
    data.scopes['group:topic'] = {
      taskId: 'task-2', chatId: 'group', threadId: 'topic', replyTo: 'm2',
      status: 'running', startedAt: Date.now(),
    };
  });
  const sent = [];
  const lifecycle = new Lifecycle({
    state,
    channel: { rawClient: { im: { v1: { message: {
      reply: async (args) => { sent.push(args); return { data: { message_id: 'out-1' } }; },
    } } } } },
    manus: { listMessages: async () => ({
      messages: [
        { id: 'e1', type: 'error_message', error_message: { content: 'failed' } },
        { id: 's1', type: 'status_update', status_update: { agent_status: 'error' } },
      ],
    }) },
  });
  await lifecycle.pollScope('group:topic');
  assert.match(sent[0].data.content, /failed/);
  assert.equal(sent[0].data.reply_in_thread, true);
});

test('reports a user-stopped task after Manus confirms background work has ended', async () => {
  const state = await new StateStore(join(await mkdtemp(join(tmpdir(), 'manus-stop-')), 'state.json')).load();
  await state.update((data) => {
    data.scopes.dm = {
      taskId: 'task-3', chatId: 'dm', replyTo: 'm3',
      status: 'stopped-by-user', startedAt: Date.now(),
    };
  });
  const sent = [];
  const lifecycle = new Lifecycle({
    state,
    channel: { rawClient: { im: { v1: { message: {
      reply: async (args) => { sent.push(JSON.parse(args.data.content).text); return { data: { message_id: 'out-3' } }; },
    } } } } },
    manus: {
      listMessages: async () => ({
        messages: [{ id: 's3', type: 'status_update', status_update: { agent_status: 'stopped' } }],
      }),
      detail: async () => ({ task: { has_running_background_jobs: false } }),
    },
  });
  await lifecycle.pollScope('dm');
  assert.deepEqual(sent, ['Manus 任务已停止。']);
  assert.equal(state.scope('dm').status, 'completed');
});

test('uses the same Feishu UUID after a lost state write and splits a long result', async () => {
  const state = await new StateStore(join(await mkdtemp(join(tmpdir(), 'manus-reply-')), 'state.json')).load();
  await state.update((data) => {
    data.scopes.dm = { taskId: 'task-4', chatId: 'dm', replyTo: 'm4', status: 'running', startedAt: Date.now() };
  });
  const calls = [];
  const channel = { rawClient: { im: { v1: { message: {
    reply: async (args) => { calls.push(args); return { data: { message_id: `out-${calls.length}` } }; },
  } } } } };
  const manus = {
    listMessages: async () => ({ messages: [
      { id: 'a4', type: 'assistant_message', assistant_message: { content: '文'.repeat(4000), delivery_kind: 'result' } },
      { id: 's4', type: 'status_update', status_update: { agent_status: 'stopped' } },
    ] }),
    detail: async () => ({ task: { has_running_background_jobs: false } }),
  };
  const write = state.update.bind(state);
  let fail = true;
  state.update = async (mutator) => {
    if (fail) { fail = false; throw new Error('disk unavailable'); }
    return write(mutator);
  };
  const lifecycle = new Lifecycle({ channel, manus, state });
  await assert.rejects(lifecycle.pollScope('dm'), /disk unavailable/);
  await lifecycle.pollScope('dm');
  assert.equal(calls.length, 4);
  assert.equal(calls[0].data.uuid, calls[2].data.uuid);
  assert.equal(calls[1].data.uuid, calls[3].data.uuid);
  assert.notEqual(calls[0].data.uuid, calls[1].data.uuid);
  assert.equal(state.scope('dm').lastEventId, 's4');
});
