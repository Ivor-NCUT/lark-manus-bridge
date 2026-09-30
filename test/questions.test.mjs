import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.mjs';
import { Lifecycle } from '../src/lifecycle.mjs';
import { StateStore } from '../src/state.mjs';

test('shows a Manus question once and sends the user answer as an ordinary message', async () => {
  const state = await new StateStore(join(await mkdtemp(join(tmpdir(), 'manus-question-')), 'state.json')).load();
  await state.update((data) => {
    data.scopes.dm = { taskId: 'task-1', chatId: 'dm', replyTo: 'm1', status: 'running', startedAt: Date.now() };
  });
  const replies = [];
  const sent = [];
  const channel = {
    send: async (_chat, body) => { replies.push(body.text); return { messageId: 'out-1' }; },
    reply: async (_message, body) => { replies.push(body.text); },
  };
  const manus = {
    listMessages: async () => ({ messages: [
      { id: 'ask-1', type: 'assistant_message', assistant_message: {
        content: 'Which format?', question_expectation: {
          options: ['PDF', 'DOCX'], selection_mode: 'single', response_method: 'send_message',
        },
      } },
      { id: 'wait-1', type: 'status_update', status_update: {
        agent_status: 'waiting', status_detail: {
          waiting_for_event_type: 'messageAskUser', waiting_for_event_id: 'ask-1',
        },
      } },
    ] }),
    sendMessage: async (taskId, answer) => { sent.push([taskId, answer]); },
  };
  const lifecycle = new Lifecycle({ channel, manus, state });
  await lifecycle.pollScope('dm');
  await lifecycle.pollScope('dm');
  assert.equal(replies.length, 1);
  assert.match(replies[0], /PDF、DOCX/);
  const bridge = new Bridge({ channel, manus, state, allowedUsers: ['user'], allowedChats: [] });
  await bridge.handleMessage({ messageId: 'm2', chatId: 'dm', chatType: 'p2p', senderId: 'user', content: 'PDF' });
  assert.deepEqual(sent, [['task-1', 'PDF']]);
});

test('never confirms an unknown waiting action from chat', async () => {
  const state = await new StateStore(join(await mkdtemp(join(tmpdir(), 'manus-action-')), 'state.json')).load();
  await state.update((data) => {
    data.scopes.dm = { taskId: 'task-1', chatId: 'dm', replyTo: 'm1', status: 'running', startedAt: Date.now() };
  });
  const sent = [];
  const channel = {
    send: async (_chat, body) => { sent.push(body.text); return { messageId: 'out-1' }; },
    reply: async (_message, body) => { sent.push(body.text); },
  };
  const manus = {
    listMessages: async () => ({ messages: [{ id: 'wait-1', type: 'status_update', status_update: {
      agent_status: 'waiting', status_detail: {
        waiting_for_event_type: 'gmailSendAction', waiting_description: 'Send an email',
        confirm_input_schema: { type: 'object', required: ['accept'] },
      },
    } }] }),
    sendMessage: async () => { throw new Error('should not send'); },
  };
  await new Lifecycle({ channel, manus, state }).pollScope('dm');
  await new Bridge({ channel, manus, state, allowedUsers: ['user'], allowedChats: [] }).handleMessage({
    messageId: 'm2', chatId: 'dm', chatType: 'p2p', senderId: 'user', content: 'yes',
  });
  assert.equal(state.scope('dm').status, 'waiting-action');
  assert.match(sent[0], /Send an email/);
  assert.match(sent[1], /Manus 页面/);
});
