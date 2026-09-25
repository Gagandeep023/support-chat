# @gagandeep023/support-chat-agent-console

The other side of the conversation in
[support-chat](https://github.com/Gagandeep023/support-chat): a headless client
plus a React component that drops into a dashboard you already have, rather than
a separate app to deploy and sign into.

```bash
npm i @gagandeep023/support-chat-agent-console
```

`react` is an **optional peer**; the headless client works without it.

## You own agent identity

There is no login to build here. Mint a short-lived token from your existing
session and the console uses it:

```ts
app.get("/api/support-chat/token", requireAuth, (req, res) => {
  res.json({
    token: signAgentToken(
      { agentId: req.user.id, tenantId: TENANT, name: req.user.name },
      process.env.SUPPORT_CHAT_SECRET,
      { expiresIn: "5m" },
    ),
  });
});
```

```tsx
import { AgentConsole } from "@gagandeep023/support-chat-agent-console/react";

<AgentConsole
  tenantId={TENANT}
  fetchToken={() => fetch("/api/support-chat/token").then((r) => r.json()).then((d) => d.token)}
/>;
```

`fetchToken` is a function rather than a token because the token is deliberately
short-lived: the console re-fetches when it expires, so a console left open
overnight does not hold a long-lived credential.

## Headless, or your own UI

```ts
import { AgentConsoleClient, socketIoTransport } from "@gagandeep023/support-chat-agent-console";

const client = new AgentConsoleClient({ tenantId, fetchToken, transport: socketIoTransport });
```

```tsx
import { useAgentConsole } from "@gagandeep023/support-chat-agent-console/react";
```

## What the client models

| Type | Is |
| --- | --- |
| `Offer` | a conversation being offered to this agent, which can be accepted or declined |
| `ActiveConversation` | one the agent has taken, with its messages and state |
| `AgentConsoleState` | queue, active conversations, and availability |
| `ConnectionState` | socket status, so the UI can show it rather than silently stall |

Offers rather than a shared queue everyone races on: routing decides who is
asked, so two agents do not open the same conversation and answer twice.

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
