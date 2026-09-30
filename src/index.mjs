import { ManusClient } from './manus.mjs';
import { createLarkChannel } from '@larksuite/channel';
import { Bridge } from './bridge.mjs';
import { StateStore } from './state.mjs';
import { Lifecycle } from './lifecycle.mjs';
import { createWebhookServer } from './webhook.mjs';

const required = ['MANUS_API_KEY', 'LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_ALLOWED_USER_IDS'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing configuration: ${missing.join(', ')}`);
  process.exit(1);
}
const splitIds = (value = '') => value.split(',').map((id) => id.trim()).filter(Boolean);
const channel = createLarkChannel({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: process.env.LARK_DOMAIN === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
  source: 'lark-manus-bridge',
  resolveChatMode: true,
  policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
  safety: { chatQueue: { enabled: false } },
});
if (!channel.rawClient?.im?.v1?.message?.reply) {
  throw new Error('The Feishu channel SDK does not expose idempotent message replies');
}
const state = await new StateStore(process.env.BRIDGE_STATE_FILE ?? 'data/state.json').load();
const bridge = new Bridge({
  channel,
  manus: new ManusClient(process.env.MANUS_API_KEY),
  state,
  allowedUsers: splitIds(process.env.LARK_ALLOWED_USER_IDS),
  allowedChats: splitIds(process.env.LARK_ALLOWED_CHAT_IDS),
});
channel.on({ message: (message) => bridge.handleMessage(message).catch((error) => {
  console.error('Message handling failed:', error.message);
}) });
await channel.connect();
console.log('Feishu/Lark connected.');
await bridge.recoverPending();
const lifecycle = new Lifecycle({ channel, manus: bridge.manus, state });
const poll = () => lifecycle.pollAll().catch((error) => console.error('Manus status check failed:', error.message));
await poll();
setInterval(poll, 30_000).unref();
if (process.env.MANUS_WEBHOOK_URL) {
  const port = Number(process.env.PORT ?? 3000);
  createWebhookServer({ url: process.env.MANUS_WEBHOOK_URL, manus: bridge.manus, state, lifecycle })
    .listen(port, '0.0.0.0', () => console.log(`Manus webhook listening on port ${port}.`));
}
