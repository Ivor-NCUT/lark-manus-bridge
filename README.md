# lark-manus-bridge

Connect a Feishu/Lark bot to Manus API v2. Send a task in chat, continue it in the same conversation, and receive its result where it started.

> Project idea and Feishu interaction model inspired by [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge). This is an independent Manus integration, not an official Manus or Lark product. The upstream project is MIT licensed.

## Features

- Private chat and `@bot` messages in approved groups create or continue a Manus task.
- Each private chat or group topic keeps its own task binding.
- The bot reports completion, questions, errors, and stopped tasks in the originating conversation.
- Images and files are uploaded to Manus; generated files are returned as labeled temporary download links.
- An optional signed Manus webhook speeds up completion delivery. Periodic polling remains the recovery path.
- `/new`, `/status`, `/stop`, and `/help` manage the current conversation.
- State survives a bridge restart. Manus API keys and Feishu app secrets stay outside Git.

The work is tracked in this repository's [Issues](https://github.com/Ivor-NCUT/lark-manus-bridge/issues). API behavior follows the [Manus v2 documentation](https://open.manus.im/docs/v2/introduction).

## Setup

Requires Node.js 20.12 or newer and a Feishu/Lark bot app with message receiving, message sending, and message-resource permissions. Configure the app to receive events over a WebSocket connection. Create a Manus API key in Manus Developers settings. Run `npm ci` and `npm test` before starting.

| Variable | Purpose |
|---|---|
| `MANUS_API_KEY` | Manus API v2 key |
| `LARK_APP_ID`, `LARK_APP_SECRET` | Feishu/Lark bot credentials |
| `LARK_ALLOWED_USER_IDS` | Comma-separated sender open IDs allowed to use Manus |
| `LARK_ALLOWED_CHAT_IDS` | Comma-separated approved group chat IDs; groups also require @mention |
| `LARK_DOMAIN` | Set to `lark` for Lark global; omit for Feishu |
| `BRIDGE_STATE_FILE` | Optional state path; defaults to `data/state.json` |
| `MANUS_WEBHOOK_URL` | Optional public HTTPS callback URL, including path |
| `PORT` | Local HTTP port when webhook is enabled; defaults to 3000 |

Export the required values through your service's secret manager or shell environment, then run `npm start`. The bridge connects to Feishu/Lark over WebSocket; a public inbound endpoint is needed only for the optional Manus webhook. Keep `BRIDGE_STATE_FILE` on persistent storage and run only one bridge instance per state file.

Only listed users may invoke the bot, including inside approved groups. A group is also required to be listed and the message must @mention the bot. An API key grants broad access to its Manus account; use a dedicated account or keep the allowlist narrow. Manus tasks are created with private visibility.

### Commands

| Command | Effect |
|---|---|
| `/new` | Clear this chat/topic's task binding; the next message starts a new task |
| `/status` | Query the bound task's current Manus status |
| `/stop` | Ask Manus to stop the bound task |
| `/help` | Show the bot's usage and commands |

Text messages continue the bound task. For a Manus question, reply in the same chat/topic with a non-empty answer. Actions requiring confirmation must be reviewed in the Manus UI; the bot does not approve them.
Task creation, `/status`, and action prompts include the private Manus task URL when available. Opening it requires access to the task creator's Manus account. Generated attachments are listed even when Manus returns them without answer text.

### Optional webhook

Set `MANUS_WEBHOOK_URL` to the exact externally reachable HTTPS URL and register it once in Manus Developers settings. Forward that URL's path to the container's `PORT`. Manus signs each request; the bridge checks the raw body, URL, timestamp, and RSA signature before processing. A webhook is an acceleration path; the 30-second poll recovers missed deliveries.

### Limits and recovery

- Manus currently limits `task.create` and `task.sendMessage` to 10 requests per minute per user. Read-side 429 errors use bounded backoff; writes are not retried automatically because an uncertain result could duplicate work.
- Up to three image/file attachments per message are accepted, each at most 20 MB after download. Voice/video are not supported. The SDK buffers received files before the size check, so keep the bot private when handling untrusted large media.
- The state file stores task bindings and message IDs, not API credentials. Back it up before moving hosts. If a write's result is uncertain, the bot reports that state rather than resubmitting it. Pending requests found after restart also trigger a warning in the original chat.
- Result replies use a stable Feishu `uuid` per task event, so retries after a crash are deduplicated within Feishu's idempotency retention window. Extremely delayed retries may still repeat a result; review the task ID before acting on one.
- A stopped main Manus run is delivered as complete only when the API reports no running background jobs. After a two-hour wait with no conclusive state, the bot reports uncertainty and continues checking.
- Completed tasks are omitted from routine polling. A new Feishu follow-up resumes polling, while a signed Manus webhook can report a later externally triggered run.

### Container

`docker build -t lark-manus-bridge .` builds the image. Mount a writable persistent directory at `/app/data` and inject the environment variables through your platform's secret settings. The container can run as a worker when webhooks are disabled; expose `PORT` when webhooks are enabled.

## Attribution

The architecture borrows the conversation-scoping, access-control, and reply-routing ideas of [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge). The Manus integration is independently implemented.

## License

MIT. See [LICENSE](LICENSE).
