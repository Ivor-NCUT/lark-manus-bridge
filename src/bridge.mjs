import { basename } from 'node:path';

export class Bridge {
  constructor({ channel, manus, state, allowedUsers, allowedChats }) {
    this.channel = channel;
    this.manus = manus;
    this.state = state;
    this.allowedUsers = new Set(allowedUsers);
    this.allowedChats = new Set(allowedChats);
    this.scopes = new Map();
  }

  async handleMessage(message) {
    if (message.senderIsBot === true || message.senderType === 'bot' ||
        !this.allowedUsers.has(message.senderId)) return;
    if (message.chatType !== 'p2p' &&
        (!this.allowedChats.has(message.chatId) || !message.mentionedBot)) return;
    const scopeId = await this.#scopeId(message);
    if (!scopeId) return;
    const previous = this.scopes.get(scopeId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#handle(scopeId, message));
    this.scopes.set(scopeId, current);
    try {
      await current;
    } finally {
      if (this.scopes.get(scopeId) === current) this.scopes.delete(scopeId);
    }
  }

  async #scopeId(message) {
    if (message.chatType === 'p2p') return message.chatId;
    const mode = message.threadId ? 'topic' : message.chatMode ?? await this.channel.getChatMode(message.chatId);
    if (mode !== 'topic') return message.chatId;
    let threadId = message.threadId;
    if (!threadId) {
      try {
        const [raw] = await this.channel.fetchRawMessage(message.messageId);
        threadId = raw?.thread_id;
      } catch {
        // Fail closed: never merge an unknown topic into the group-wide task.
      }
    }
    if (!threadId) {
      await this.channel.reply(message, { text: '无法识别当前话题，请稍后重试。' });
      return undefined;
    }
    return `${message.chatId}:${threadId}`;
  }

  async #handle(scopeId, message) {
    if (this.state.message(message.messageId)) return;
    const content = message.content.trim();
    if (content === '/new') {
      await this.state.update((data) => {
        delete data.scopes[scopeId];
        data.messages[message.messageId] = 'done';
      });
      await this.channel.reply(message, { text: '已开启新会话。下一条消息会创建新的 Manus 任务。' });
      return;
    }
    if (content === '/status') {
      const current = this.state.scope(scopeId);
      if (!current) {
        await this.channel.reply(message, { text: '当前会话还没有 Manus 任务。' });
      } else {
        const detail = await this.manus.detail(current.taskId);
        await this.channel.reply(message, {
          text: `Manus 任务 ${current.taskId}：${detail.task?.status ?? '状态未知'}`,
        });
      }
      await this.state.update((data) => { data.messages[message.messageId] = 'done'; });
      return;
    }
    if (content === '/stop') {
      const current = this.state.scope(scopeId);
      if (!current) {
        await this.channel.reply(message, { text: '当前会话还没有 Manus 任务。' });
      } else {
        await this.manus.stop(current.taskId);
        await this.state.update((data) => {
          data.scopes[scopeId].status = 'stopped-by-user';
        });
        await this.channel.reply(message, { text: `已请求停止 Manus 任务 ${current.taskId}。` });
      }
      await this.state.update((data) => { data.messages[message.messageId] = 'done'; });
      return;
    }
    if ((!content && !message.resources?.length) || content.startsWith('/')) return;

    const current = this.state.scope(scopeId);
    if (current?.status === 'waiting-action') {
      await this.channel.reply(message, { text: '此任务正在等待操作确认，请先在 Manus 页面审查并处理。' });
      await this.state.update((data) => { data.messages[message.messageId] = 'done'; });
      return;
    }
    const resources = message.resources ?? [];
    if (resources.length > 3 || resources.some((resource) => !['image', 'file'].includes(resource.type))) {
      await this.channel.reply(message, { text: '最多支持 3 个图片或文件附件；音视频暂不支持。' });
      await this.state.update((data) => { data.messages[message.messageId] = 'done'; });
      return;
    }
    await this.state.update((data) => {
      data.messages[message.messageId] = 'pending';
    });
    try {
      const parts = content ? [{ type: 'text', text: content }] : [];
      for (const resource of resources) {
        // ponytail: the SDK buffers a received resource before its size is known;
        // use a capped streaming downloader if large untrusted media becomes common.
        const bytes = await this.channel.downloadResource(message.messageId, resource.fileKey, resource.type);
        if (bytes.length > 20 * 1024 * 1024) {
          await this.state.update((data) => { data.messages[message.messageId] = 'done'; });
          await this.channel.reply(message, { text: '附件超过 20 MB，请发送较小的文件。' });
          return;
        }
        const filename = basename(resource.fileName ?? (resource.type === 'image' ? 'image.png' : 'attachment.bin'))
          || 'attachment.bin';
        const fileId = await this.manus.uploadFile(filename, bytes);
        parts.push({ type: 'file', file_id: fileId });
      }
      const payload = parts.length === 1 && parts[0].type === 'text' ? content : parts;
      if (current?.taskId) {
        await this.manus.sendMessage(current.taskId, payload);
        await this.state.update((data) => {
          data.messages[message.messageId] = 'done';
          data.scopes[scopeId].replyTo = message.messageId;
          data.scopes[scopeId].status = 'running';
          data.scopes[scopeId].startedAt = Date.now();
        });
        await this.channel.reply(message, { text: '已发送给当前 Manus 任务。' });
      } else {
        const result = await this.manus.createTask(payload, {
          interactive_mode: true,
          share_visibility: 'private',
          locale: 'zh-CN',
        });
        await this.state.update((data) => {
          data.messages[message.messageId] = 'done';
          data.scopes[scopeId] = {
            taskId: result.task_id,
            chatId: message.chatId,
            threadId: scopeId.startsWith(`${message.chatId}:`)
              ? scopeId.slice(message.chatId.length + 1)
              : undefined,
            replyTo: message.messageId,
            status: 'running',
            startedAt: Date.now(),
          };
        });
        await this.channel.reply(message, { text: `已创建 Manus 任务：${result.task_id}` });
      }
    } catch (error) {
      await this.state.update((data) => {
        data.messages[message.messageId] = 'unknown';
      });
      await this.channel.reply(message, { text: 'Manus 请求未确认成功，请用 /status 检查；系统不会自动重发以免重复创建任务。' });
      throw error;
    }
  }
}
