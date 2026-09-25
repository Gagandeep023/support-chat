# @gagandeep023/support-chat-cli

Command line tools for [support-chat](https://github.com/Gagandeep023/support-chat):
run the whole thing locally, check a model can do the job, and score it against
your own documentation.

```bash
npx @gagandeep023/support-chat-cli help
```

## `dev`, with nothing installed

```bash
npx support-chat dev
```

No database, no Redis, and no API key. It ingests a sample document, serves a
page with the widget on it, and answers questions. With no model configured the
replies are **scripted**, so you can watch the entire loop, ask something the
docs do not cover, and queue for a human before spending anything.

```
support-chat dev
  Open       http://localhost:4000
  Model      a scripted stand-in (no model configured)
  Embeddings none (keyword search only)
  Knowledge  1 document, 3 chunks
  Storage    in memory
```

Point it at real docs and a real model:

```bash
export ANTHROPIC_API_KEY=...
npx support-chat dev --docs ./docs --db ./local.db
```

| Flag | Default |
| --- | --- |
| `--port`, `-p` | `4000` |
| `--docs`, `-d` | a built-in sample document |
| `--model`, `-m` | from the environment |
| `--db` | in memory |
| `--embeddings`, `-e` | `none`, or `hashed` / `local` |

## `doctor`, before you commit to a model

```bash
support-chat doctor --model <id> [--top-k 8]
```

Checks the configured model can actually do the job: streaming, a parseable
escalation verdict, tool calling, and context budget. "Use any model you like"
is not a feature if you have no way to find out that one of them cannot return a
verdict you can parse.

## `eval`, against your own docs

```bash
support-chat eval --cases ./cases.jsonl [--docs ./docs] [--model <id>]
```

```jsonl
{"question": "what does error E4021 mean?", "grounded": true, "escalate": false}
{"question": "what is the capital of France?", "grounded": false}
{"question": "I want to talk to a human", "escalate": true}
```

Scores grounding, refusal and escalation accuracy. The second case matters as
much as the first: a model that answers questions your documentation does not
cover is the failure mode that costs you trust.

## Environment

| Variable | For |
| --- | --- |
| `ANTHROPIC_API_KEY` | the Anthropic API |
| `SUPPORT_CHAT_BASE_URL` | any OpenAI-compatible endpoint |
| `SUPPORT_CHAT_MODEL` | model id at that endpoint |
| `SUPPORT_CHAT_API_KEY` | key for that endpoint, when it needs one |

That covers Moonshot (Kimi), Groq, Together, Fireworks, OpenRouter, vLLM and
Ollama. With none of them set, replies are scripted so the loop still runs.

---

## The rest of support-chat

| Package | What it is |
| --- | --- |
| `@gagandeep023/support-chat-core` | Types, wire protocol, reconnect backoff |
| `@gagandeep023/support-chat-server` | The engine: socket gateway, retrieval, routing, host tools, stores |
| `@gagandeep023/support-chat-widget` | Customer-facing chat: web component, React, or headless |
| `@gagandeep023/support-chat-agent-console` | Agent side, as a React component for your dashboard |
| `@gagandeep023/support-chat-cli` | `dev`, `doctor`, `eval` |

The [repository README](https://github.com/Gagandeep023/support-chat#readme) is
the full walkthrough, and `DESIGN.md` records what was rejected and why.

## Requests and feedback

[![Request a feature](https://img.shields.io/badge/request-a%20feature-64ffda)](https://github.com/Gagandeep023/support-chat/discussions/new?category=ideas)
[![Report a bug](https://img.shields.io/badge/report-a%20bug-cc4444)](https://github.com/Gagandeep023/support-chat/issues/new?template=bug_report.yml)

Ideas and questions go to Discussions, bugs to Issues.

## License

MIT
