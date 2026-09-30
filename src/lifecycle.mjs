const QUESTION_TYPES = new Set(['messageAskUser', 'cascadeAskUser']);

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
    if (!binding || binding.status === 'stopped-by-user') return;
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
    const newEvents = events.filter((event) => event.id !== binding.lastEventId);
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
      if (QUESTION_TYPES.has(detail?.waiting_for_event_type)) return;
      if (binding.status !== 'waiting-action') {
        await this.#deliver(scopeId, binding, `Manus 正等待操作确认：${detail?.waiting_description ?? '请在 Manus 页面查看'}。当前不会自动批准。`, 'waiting-action');
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
      if (binding.status === 'completed') return;
      const answers = newEvents.filter((event) =>
        event.type === 'assistant_message' && event.assistant_message?.content?.trim());
      const answer = [...answers].reverse().find((event) => event.assistant_message.delivery_kind === 'result')
        ?? [...answers].reverse().find((event) => event.assistant_message.delivery_kind !== 'progress')
        ?? answers.at(-1);
      await this.#deliver(scopeId, binding, answer?.assistant_message.content ?? 'Manus 任务已完成。', 'completed', events.at(-1)?.id);
      return;
    }
    if (status === 'error' && binding.status !== 'error') {
      const error = [...newEvents].reverse().find((event) => event.type === 'error_message');
      await this.#deliver(scopeId, binding, `Manus 任务失败：${error?.error_message?.content ?? '请查看 Manus 任务详情'}`, 'error', events.at(-1)?.id);
    }
  }

  async #deliver(scopeId, binding, text, status, lastEventId) {
    if (this.state.scope(scopeId)?.taskId !== binding.taskId) return;
    const receipt = await this.channel.send(binding.chatId, { text }, {
      replyTo: binding.replyTo,
      ...(binding.threadId ? { replyInThread: true } : {}),
    });
    if (!receipt?.messageId) throw new Error('Feishu reply missing message receipt');
    await this.state.update((data) => {
      if (data.scopes[scopeId]?.taskId !== binding.taskId) return;
      data.scopes[scopeId].status = status;
      if (lastEventId) data.scopes[scopeId].lastEventId = lastEventId;
    });
  }
}
