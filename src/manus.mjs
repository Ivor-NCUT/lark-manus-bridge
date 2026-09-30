const BASE_URL = 'https://api.manus.ai/v2/';

export class ManusApiError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message);
    this.name = 'ManusApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export class ManusClient {
  constructor(apiKey, { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 30_000 } = {}) {
    if (!apiKey) throw new Error('MANUS_API_KEY is required');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
  }

  createTask(message, options = {}) {
    return this.#request('POST', 'task.create', { message: { content: message }, ...options });
  }

  sendMessage(taskId, message) {
    return this.#request('POST', 'task.sendMessage', { task_id: taskId, message: { content: message } });
  }

  detail(taskId) {
    return this.#request('GET', 'task.detail', undefined, { task_id: taskId });
  }

  listMessages(taskId, options = {}) {
    return this.#request('GET', 'task.listMessages', undefined, { task_id: taskId, ...options });
  }

  stop(taskId) {
    return this.#request('POST', 'task.stop', { task_id: taskId });
  }

  webhookPublicKey() {
    return this.#request('GET', 'webhook.publicKey');
  }

  async uploadFile(filename, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
      throw new Error('Attachment must be 1 byte to 20 MB');
    }
    const record = await this.#request('POST', 'file.upload', { filename });
    const url = new URL(record.upload_url);
    if (url.protocol !== 'https:') throw new Error('Manus returned an insecure upload URL');
    if (Number(record.upload_expires_at) * 1000 <= Date.now()) {
      throw new Error('Manus upload URL has expired');
    }
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      body: bytes,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Manus upload failed with HTTP ${response.status}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const detail = await this.#request('GET', 'file.detail', undefined, { file_id: record.file.id });
      if (detail.file?.status === 'uploaded') return record.file.id;
      if (detail.file?.status === 'error' || detail.file?.status === 'deleted') break;
      await this.sleep(500 * 2 ** attempt);
    }
    throw new Error('Manus did not confirm the uploaded file');
  }

  async #request(method, endpoint, body, query) {
    const url = new URL(endpoint, BASE_URL);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            'x-manus-api-key': this.apiKey,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new ManusApiError('Manus request failed; write outcome may be unknown', { code: error?.name ?? 'network_error' });
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new ManusApiError('Manus returned invalid JSON', { status: response.status });
      }
      if (response.ok && data?.ok === true) return data;
      if (method === 'GET' && response.status === 429 && attempt < 2) {
        await this.sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
      throw new ManusApiError(data?.error?.message ?? 'Manus request failed', {
        status: response.status,
        code: data?.error?.code,
        requestId: data?.request_id,
      });
    }
  }
}
