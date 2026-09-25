# @gagandeep023/support-chat-core

The shared vocabulary of [support-chat](https://github.com/Gagandeep023/support-chat):
domain types, the wire protocol both ends speak, and the reconnect backoff they
agree on.

```bash
npm i @gagandeep023/support-chat-core
```

`zod` is the only dependency. Every other support-chat package depends on this
one, so you rarely install it directly. Reach for it when you are writing your
own server, your own widget, or a provider, and need to be sure you agree with
everything else about what a message is.

## What is in it

```ts
import type {
  Conversation, Message, Actor, Event, Knowledge,
  ChatProvider, EmbeddingProvider, DiagnosisProvider,
} from "@gagandeep023/support-chat-core";
```

**Domain** (`conversation`, `message`, `actor`, `event`, `knowledge`) is the
state both ends reason about. **Providers** are the interfaces you implement to
plug in a model, an embedding backend, or a diagnosis routine; the server
depends on these interfaces rather than on any vendor.

**Ids and errors** are shared so an id minted on the server is the same shape the
widget validates, and a failure means the same thing on both sides.

## The protocol

```ts
import { /* frame schemas */ } from "@gagandeep023/support-chat-core/protocol";
```

A separate entry point covering the widget frames, the agent frames, the
envelope that wraps both, and the reconnect backoff.

The backoff living **in the protocol rather than in each client** is deliberate.
A deploy drains every socket at once, so if each client reconnected on its own
timer the result is a thundering herd against a server that has just restarted.
Both clients import the same schedule, and the server tells them when to come
back.

Frames are zod schemas, not interfaces, so a malformed frame is rejected at the
boundary with a real error instead of becoming `undefined` three layers in.

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
