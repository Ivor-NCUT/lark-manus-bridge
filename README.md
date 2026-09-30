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

## Attribution

The architecture borrows the conversation-scoping, access-control, and reply-routing ideas of [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge). No upstream source code has been copied into this initial repository.

## License

MIT. See [LICENSE](LICENSE).
