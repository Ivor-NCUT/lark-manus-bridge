import { createHash, createVerify } from 'node:crypto';
import { createServer } from 'node:http';

export function verifyWebhook({ body, url, signature, timestamp, publicKey, now = Date.now() }) {
  if (!/^\d+$/.test(String(timestamp)) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) {
    return false;
  }
  if (!signature || !publicKey) return false;
  const digest = createHash('sha256').update(body).digest('hex');
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${timestamp}.${url}.${digest}`);
    return verifier.verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

export function createWebhookServer({ url, manus, state, lifecycle, logger = console }) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('MANUS_WEBHOOK_URL must be HTTPS');
  let cachedKey;
  let keyExpiresAt = 0;
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== `${target.pathname}${target.search}`) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      if (Date.now() >= keyExpiresAt) {
        cachedKey = (await manus.webhookPublicKey()).public_key;
        keyExpiresAt = Date.now() + 60 * 60_000;
      }
      const body = Buffer.concat(chunks);
      if (!verifyWebhook({
        body,
        url,
        signature: request.headers['x-webhook-signature'],
        timestamp: request.headers['x-webhook-timestamp'],
        publicKey: cachedKey,
      })) {
        response.writeHead(401).end();
        return;
      }
      const event = JSON.parse(body.toString('utf8'));
      if (!event.event_id || !event.task_detail?.task_id) {
        response.writeHead(400).end();
        return;
      }
      if (state.data.webhookEvents?.[event.event_id]) {
        response.writeHead(200).end();
        return;
      }
      await state.update((data) => {
        data.webhookEvents ??= {};
        for (const [id, seenAt] of Object.entries(data.webhookEvents)) {
          if (Date.now() - seenAt > 7 * 24 * 60 * 60_000) delete data.webhookEvents[id];
        }
        data.webhookEvents[event.event_id] = Date.now();
      });
      response.writeHead(200).end();
      if (event.event_type === 'task_stopped') {
        for (const [scopeId, binding] of Object.entries(state.data.scopes)) {
          if (binding.taskId === event.task_detail.task_id) {
            void lifecycle.pollScope(scopeId).catch((error) => logger.error('Webhook follow-up failed:', error.message));
          }
        }
      }
    } catch (error) {
      logger.error('Webhook handling failed:', error.message);
      if (!response.headersSent) response.writeHead(503).end();
    }
  });
}
