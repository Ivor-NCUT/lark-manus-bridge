# lark-manus-bridge

Connect a Feishu/Lark bot to Manus API v2. Send a task in chat, continue it in the same conversation, and receive its result where it started.

> Project idea and Feishu interaction model inspired by [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge). This is an independent Manus integration, not an official Manus or Lark product. The upstream project is MIT licensed.

## Planned behavior

- Private chat and `@bot` messages in approved groups create or continue a Manus task.
- Each private chat or group topic keeps its own task binding.
- The bot reports completion, questions, errors, and stopped tasks in the originating conversation.
- `/new`, `/status`, and `/stop` manage the current conversation.
- State survives a bridge restart. Manus API keys and Feishu app secrets stay outside Git.

The implementation is tracked in this repository's Issues. API behavior follows the [Manus v2 documentation](https://open.manus.im/docs/v2/introduction).

## Development

Requires Node.js 20.12 or newer. Run `npm install` and `npm test`. Set the following environment variables before `npm start`; never put secrets in Git.

| Variable | Purpose |
|---|---|
| `MANUS_API_KEY` | Manus API v2 key |
| `LARK_APP_ID`, `LARK_APP_SECRET` | Feishu/Lark bot credentials |
| `LARK_ALLOWED_USER_IDS` | Comma-separated sender open IDs allowed to use Manus |
| `LARK_ALLOWED_CHAT_IDS` | Comma-separated approved group chat IDs; groups also require @mention |
| `LARK_DOMAIN` | Set to `lark` for Lark global; omit for Feishu |
| `BRIDGE_STATE_FILE` | Optional state path; defaults to `data/state.json` |

Only listed users may invoke the bot, including inside approved groups. Keep the state file on persistent storage. Results and status delivery are tracked in [Issue #3](https://github.com/Ivor-NCUT/lark-manus-bridge/issues/3).

## Attribution

The architecture borrows the conversation-scoping, access-control, and reply-routing ideas of [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge). No upstream source code has been copied into this initial repository.

## License

MIT. See [LICENSE](LICENSE).
