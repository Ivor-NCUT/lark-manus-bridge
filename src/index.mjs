import { ManusClient } from './manus.mjs';

if (!process.env.MANUS_API_KEY) {
  console.error('Missing MANUS_API_KEY. Set it in the environment before starting the bridge.');
  process.exit(1);
}
new ManusClient(process.env.MANUS_API_KEY);
console.log('Manus API configured. Feishu connection is tracked in Issue #2.');
