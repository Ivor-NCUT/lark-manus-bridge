import { createHash } from 'node:crypto';

const QUESTION_TYPES = new Set(['messageAskUser', 'cascadeAskUser']);

function textChunks(text) {
  const chunks = [];
  let chunk = '';
  let size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (chunk && size + bytes > 8000) {
      chunks.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += character;
    size += bytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class Lifecycle {
  constructor({ channel, manus, state, deadlineMs = 2 * 60 * 60_000 }) {
    this.channel = channel;
    this.manus = manus;
    this.state = state;
    this.deadlineMs = deadlineMs;
    this.busy = new Set();
  }

  async pollAll() {
    for (const scopeId of Object.keys(this.state.data.scopes)) {
      if (this.state.scope(scopeId)?.status === 'completed') continue;
      try {
        await this.pollScope(scopeId);
      } catch (error) {
        console.error(`Manus status check failed for ${scopeId}:`, error.message);
      }
    }
  }

  async pollScope(scopeId) {
    if (this.busy.has(scopeId)) return;
    this.busy.add(scopeId);
    try {
      await this.#poll(scopeId);
    } finally {
      this.busy.delete(scopeId);
    }
  }

  async #poll(scopeId) {
    const binding = this.state.scope(scopeId);
    if (!binding) return;
    const events = [];
    let cursor;
    do {
      const page = await this.manus.listMessages(binding.taskId, {
        order: 'asc',
        limit: 100,
        ...(cursor ? { cursor } : binding.lastEventId ? { start_event_id: binding.lastEventId } : {}),
      });
      events.push(...(page.messages ?? []));
      cursor = page.has_more ? page.next_cursor : undefined;
      if (page.has_more && !cursor) throw new Error('Manus pagination cursor missing');
    } while (cursor);
    const markerIndex = events.findIndex((event) => event.id === binding.lastEventId);
    const newEvents = markerIndex < 0 ? events : events.slice(markerIndex + 1);
    const statusEvent = [...events].reverse().find((event) => event.type === 'status_update');
    const status = statusEvent?.status_update?.agent_status;
    if (binding.lastEventId && newEvents.length === 0) return;
    if (!status || status === 'running') {
      if (Date.now() - binding.startedAt > this.deadlineMs && binding.status !== 'unknown') {
        await this.#deliver(scopeId, binding, 'Manus 任务仍在执行，已超过等待期限；可用 /status 查询。', 'unknown');
      }
      return;
    }
    if (status === 'waiting') {
      const detail = statusEvent.status_update.status_detail;
      if (QUESTION_TYPES.has(detail?.waiting_for_event_type)) {
        if (binding.status === 'waiting-question') return;
        const question = events.find((event) => event.id === detail.waiting_for_event_id)
          ?? [...newEvents].reverse().find((event) => event.type === 'assistant_message');
        const expectation = question?.assistant_message?.question_expectation;
        if (expectation?.response_method && expectation.response_method !== 'send_message') {
          await this.#deliver(scopeId, binding, 'Manus 使用了未知的提问方式，请在 Manus 页面处理。', 'waiting-action', events.at(-1)?.id);
          return;
        }
        const options = expectation?.options?.length
          ? `\n可选：${expectation.options.join('、')}。也可以直接回复文字。`
          : '\n请直接回复文字。';
        await this.#deliver(
          scopeId,
          binding,
          `Manus 需要你回答：${question?.assistant_message?.content ?? detail.waiting_description ?? '请补充信息'}${options}`,
          'waiting-question',
          events.at(-1)?.id,
        );
        return;
      }
      if (binding.status !== 'waiting-action') {
        const schema = detail?.confirm_input_schema
          ? `\n确认参数：${JSON.stringify(detail.confirm_input_schema)}`
          : '';
        await this.#deliver(
          scopeId,
          binding,
          `Manus 正等待操作确认：${detail?.waiting_description ?? '请在 Manus 页面查看'}。${schema}\n请在 Manus 页面审查并操作；机器人不会自动批准。`,
          'waiting-action',
          events.at(-1)?.id,
        );
      }
      return;
    }
    if (status === 'stopped') {
      const detail = await this.manus.detail(binding.taskId);
      if (detail.task?.has_running_background_jobs !== false) {
        if (Date.now() - binding.startedAt > this.deadlineMs && binding.status !== 'unknown') {
          await this.#deliver(scopeId, binding, 'Manus 主任务已停止，但后台工作状态未确认；可用 /status 查询。', 'unknown');
        }
        return;
      }
      const answers = newEvents.filter((event) =>
        event.type === 'assistant_message' && event.assistant_message?.content?.trim());
      const answer = [...answers].reverse().find((event) => event.assistant_message.delivery_kind === 'result')
        ?? [...answers].reverse().find((event) => event.assistant_message.delivery_kind !== 'progress')
        ?? answers.at(-1);
      const links = (answer?.assistant_message.attachments ?? []).flatMap((attachment) => {
        try {
          if (new URL(attachment.url).protocol !== 'https:') return [];
          return [`- ${attachment.filename ?? '文件'}：${attachment.url}`];
        } catch {
          return [];
        }
      });
      const text = `${answer?.assistant_message.content ?? (binding.status === 'stopped-by-user'
        ? 'Manus 任务已停止。' : 'Manus 任务已完成。')}${links.length
        ? `\n\n生成文件（临时下载链接，可能过期）：\n${links.join('\n')}`
        : ''}`;
      await this.#deliver(scopeId, binding, text, 'completed', events.at(-1)?.id);
      return;
    }
    if (status === 'error' && binding.status !== 'error') {
      const error = [...newEvents].reverse().find((event) => event.type === 'error_message');
      await this.#deliver(scopeId, binding, `Manus 任务失败：${error?.error_message?.content ?? '请查看 Manus 任务详情'}`, 'error', events.at(-1)?.id);
    }
  }

  async #deliver(scopeId, binding, text, status, lastEventId) {
    if (this.state.scope(scopeId)?.taskId !== binding.taskId) return;
    const chunks = textChunks(text);
    for (const [index, chunk] of chunks.entries()) {
      const uuid = createHash('sha256')
        .update(`${scopeId}\0${binding.taskId}\0${binding.startedAt}\0${status}\0${lastEventId ?? ''}\0${index}`)
        .digest('hex').slice(0, 32);
      const receipt = await this.channel.rawClient.im.v1.message.reply({
        path: { message_id: binding.replyTo },
        data: {
          content: JSON.stringify({ text: chunk }),
          msg_type: 'text',
          reply_in_thread: Boolean(binding.threadId),
          uuid,
        },
      });
      if (receipt.code && receipt.code !== 0) throw new Error(`Feishu reply failed: ${receipt.code}`);
      if (!receipt.data?.message_id) throw new Error('Feishu reply missing message receipt');
    }
    await this.state.update((data) => {
      if (data.scopes[scopeId]?.taskId !== binding.taskId) return;
      data.scopes[scopeId].status = status;
      if (lastEventId) data.scopes[scopeId].lastEventId = lastEventId;
    });
  }
}
