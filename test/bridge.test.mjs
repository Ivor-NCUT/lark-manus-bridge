import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.mjs';
import { StateStore } from '../src/state.mjs';

test('authorized messages bind one task, deduplicate, and survive restart', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'manus-bridge-')), 'state.json');
  const sent = [];
  const replies = [];
  const manus = {
    createTask: async (text) => {
      sent.push(['create', text]);
      return { task_id: `task-${sent.filter(([kind]) => kind === 'create').length}` };
    },
    sendMessage: async (id, text) => { sent.push(['continue', id, text]); },
  };
  const channel = {
    reply: async (msg, body) => { replies.push([msg.messageId, body.text]); },
    getChatMode: async () => 'topic',
    fetchRawMessage: async () => [{ thread_id: 'topic-a' }],
  };
  const makeBridge = async () => new Bridge({
    channel, manus, state: await new StateStore(path).load(),
    allowedUsers: ['user-1'], allowedChats: ['group-1'],
  });
  let bridge = await makeBridge();
  const dm = { messageId: 'm1', chatId: 'dm-1', chatType: 'p2p', senderId: 'user-1', content: 'hello' };
  await bridge.handleMessage(dm);
  await bridge.handleMessage(dm);
  bridge = await makeBridge();
  await bridge.handleMessage({ ...dm, messageId: 'm2', content: 'more' });
  await bridge.handleMessage({ ...dm, messageId: 'm3', senderId: 'stranger' });
  await bridge.handleMessage({ ...dm, messageId: 'm4', chatType: 'group', chatId: 'group-1', mentionedBot: false });
  await bridge.handleMessage({ ...dm, messageId: 'm5', chatType: 'group', chatId: 'group-1', mentionedBot: true });
  await bridge.handleMessage({ ...dm, messageId: 'm6', chatType: 'group', chatId: 'group-1', mentionedBot: true, threadId: 'topic-b' });
  assert.deepEqual(sent, [
    ['create', 'hello'],
    ['continue', 'task-1', 'more'],
    ['create', 'hello'],
    ['create', 'hello'],
  ]);
  assert.equal(replies.length, 4);
  const data = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(data.scopes['group-1:topic-a'].taskId, 'task-2');
  assert.equal(data.scopes['group-1:topic-a'].threadId, 'topic-a');
  assert.equal(data.scopes['group-1:topic-b'].taskId, 'task-3');
  assert.equal(data.messages.m1, 'done');
});

test('warns once about a pending Manus write after restart without resubmitting it', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'manus-pending-')), 'state.json');
  const state = await new StateStore(path).load();
  await state.update((data) => {
    data.messages.m7 = { status: 'pending', chatId: 'group-1', threadId: 'topic-a' };
  });
  const sent = [];
  const bridge = new Bridge({
    state: await new StateStore(path).load(),
    channel: { send: async (...args) => { sent.push(args); return { messageId: 'warning-1' }; } },
    manus: { createTask: () => { throw new Error('must not retry'); } },
    allowedUsers: ['user-1'], allowedChats: ['group-1'],
  });
  await bridge.recoverPending();
  await bridge.recoverPending();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'group-1');
  assert.equal(sent[0][2].replyTo, 'm7');
  assert.equal(sent[0][2].replyInThread, true);
  assert.equal((await new StateStore(path).load()).message('m7'), 'unknown');
});
