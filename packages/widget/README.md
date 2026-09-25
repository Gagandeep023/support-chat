# @gagandeep023/support-chat-widget

The customer-facing end of [support-chat](https://github.com/Gagandeep023/support-chat).
One client, three ways to mount it: a web component for any page, a React
wrapper, or headless if you are drawing your own UI.

```bash
npm i @gagandeep023/support-chat-widget
```

`react` is an **optional peer**, so the web component and the headless client
cost you nothing if you are not on React.

## Plain HTML

```html
<script src="/support-chat/widget.js"></script>
<support-chat publishable-key="pk_live_..."></support-chat>
```

The publishable key identifies the tenant and nothing more. For logged-in users,
sign their id on your server and pass the hash, so nobody can claim to be
somebody else.

## React

```tsx
import { SupportChat } from "@gagandeep023/support-chat-widget/react";

<SupportChat publishableKey="pk_live_..." userId={user.id} userHash={hash} />;
```

Or take the hook and draw it yourself:

```tsx
import { useSupportChat } from "@gagandeep023/support-chat-widget/react";

const { state, messages, send, connection } = useSupportChat({ publishableKey });
```

## Headless

```ts
import { SupportChatClient, socketIoTransport } from "@gagandeep023/support-chat-widget";

const client = new SupportChatClient({ publishableKey, transport: socketIoTransport });
```

`SupportChatClient` holds the whole conversation state machine: connection
state, message list, streaming replies, escalation, and tool-approval prompts.
Every rendering layer above is a thin shell over it, so behaviour cannot drift
between them.

## Entry points

| Import | Gives you |
| --- | --- |
| `@gagandeep023/support-chat-widget` | `SupportChatClient`, transports, `WIDGET_STYLES` |
| `.../element` | `SupportChatElement`, the `<support-chat>` custom element |
| `.../react` | `SupportChat` component and `useSupportChat` hook |
| `.../browser` | prebuilt bundle for a `<script>` tag |

## Transports

`socketIoTransport` is the default, and `Transport` / `TransportFactory` are
exported so the client can be driven by something else entirely, including a
fake in tests. The client does not import socket.io directly; it is handed a
transport.

## Reconnecting

Backoff comes from `support-chat-core`, shared with the server, rather than from
a timer in this package. When a deploy drains every socket at once, the server
says when to come back and the delay is spread across clients, so the herd does
not arrive together.

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
