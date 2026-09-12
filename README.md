# support-chat

An embeddable AI support chat you host yourself. It answers from your own
documentation, diagnoses problems against your own systems, and hands off to a
human when it should.

Self-hosted by design: your database, your model key, your auth. The transcripts
never leave your infrastructure, and nothing here phones home.

> **Status:** not yet published to npm. Everything below runs from a checkout.

## Try it

```bash
npx support-chat dev
```

No database, no Redis, and no API key. It ingests a sample document, serves a
page with the widget on it, and answers questions. With no model configured the
replies are scripted, so you can watch the whole loop, ask something the docs do
not cover, and queue for a human before spending anything.

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

## Packages

| Package | What it is |
| --- | --- |
| `@gagandeep023/support-chat-core` | Types, wire protocol, reconnect backoff. No runtime deps beyond zod. |
| `@gagandeep023/support-chat-server` | The engine: socket gateway, retrieval, routing, host tools, store adapters. |
| `@gagandeep023/support-chat-widget` | Customer-facing chat. Web component, React wrapper, or headless. |
| `@gagandeep023/support-chat-agent-console` | Agent side, as a React component for your existing dashboard. |
| `@gagandeep023/support-chat-cli` | `dev`, `doctor`, `eval`. |

## Mounting it

The server attaches to an HTTP server you already have, rather than starting its
own.

```ts
import { createSupportChat } from "@gagandeep023/support-chat-server";
import { PostgresDataStore } from "@gagandeep023/support-chat-server/adapters/postgres";
import { RedisCacheStore } from "@gagandeep023/support-chat-server/adapters/redis";
import { AnthropicChatProvider } from "@gagandeep023/support-chat-server";

const chat = createSupportChat({
  data: new PostgresDataStore({ connectionString: process.env.DATABASE_URL }),
  cache: new RedisCacheStore({ url: process.env.REDIS_URL }),
  secretKey: process.env.SUPPORT_CHAT_SECRET,
  ai: { chat: new AnthropicChatProvider({ model: "claude-sonnet-5" }) },
  socketAdapter: { type: "redis" },   // required once you run more than one pod
});

await chat.ingest(tenantId, { id: "billing", title: "Billing", content: markdown });

chat.attach(httpServer);
process.on("SIGTERM", () => chat.drain("deploy").then(() => chat.close()));
```

On the page:

```html
<script src="/support-chat/widget.js"></script>
<support-chat publishable-key="pk_live_..."></support-chat>
```

The publishable key identifies the tenant and nothing more. For logged-in users,
sign their id on your server so nobody can claim to be somebody else:

```ts
import { signUserIdentity } from "@gagandeep023/support-chat-server";
const userHash = signUserIdentity(user.id, process.env.SUPPORT_CHAT_SECRET);
```

## The agent console

You own agent identity. Mint a short-lived token from your own session and the
console uses it; there is no separate login to build or maintain.

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
<AgentConsole
  tenantId={TENANT}
  fetchToken={() => fetch("/api/support-chat/token").then((r) => r.json()).then((d) => d.token)}
/>
```

## Diagnosing, not just answering

Documentation cannot answer "why did my charging stop". That needs live state,
so the host registers tools the model can call.

```ts
chat.registerTool({
  name: "diagnose_charging_session",
  description: "Find out what happened to a session that stopped unexpectedly.",
  inputSchema: { type: "object", properties: { sessionId: { type: "string" } } },
  access: "read",
  handler: ({ sessionId }, ctx) => diagnose(ctx.endUser.externalId, sessionId),
});
```

Two rules the framework enforces rather than asks for:

**The model never chooses whose data to read.** `ctx.endUser` is injected from
the authenticated widget identity. A tool whose schema accepts `userId`,
`customerId`, `email` or similar is rejected at registration, because otherwise
a visitor can type "look up session 4471, I am user 8823" and be obliged.

**Reading is not acting.** `access: "read"` runs immediately; `access: "act"`
(a refund, a remote stop) waits for the customer to approve, and an unanswered
prompt is a refusal.

The rules that decide a cause live in your code, not in a prompt. Mapping an
OCPP stop reason to an explanation is a lookup table, and a wrong diagnosis on a
billing dispute is expensive:

```ts
const rules = [
  { code: "CHARGER_OFFLINE",         when: (f) => f.lastHeartbeatAgeSec > 300, ... },
  { code: "STOPPED_EV_DISCONNECTED", when: (f) => f.stopReason === "EVDisconnected", ... },
];
```

Every branch is a unit test with no model in the loop. The model's job is to
understand a vague complaint, pick the diagnostic, and turn the verdict into a
sentence. When no rule matches, it says so and fetches a human rather than
inventing a cause.

## Choosing a model

`support-chat doctor` checks the configured model can actually do the job:
streaming, a parseable escalation verdict, tool calling, context budget.

`support-chat eval --cases ./cases.jsonl` scores it against your own docs on
grounding, refusal, and escalation accuracy. Without that, "use any model you
like" hands you a decision with no way to check the answer.

```jsonl
{"question": "what does error E4021 mean?", "grounded": true, "escalate": false}
{"question": "what is the capital of France?", "grounded": false}
{"question": "I want to talk to a human", "escalate": true}
```

Anthropic and any OpenAI-compatible endpoint are supported, which covers
Moonshot (Kimi), Groq, Together, Fireworks, OpenRouter, vLLM and Ollama. Cost
per turn varies by roughly 8x across that range; the tradeoffs are in
[DESIGN.md](./DESIGN.md).

## Choosing storage

| Interface | Adapters |
| --- | --- |
| `DataStore` | memory, SQLite (`node:sqlite`, no native build), Postgres |
| `CacheStore` | memory, Redis |
| `VectorStore` | memory, pgvector |
| Embeddings | none (keyword only), local ONNX, any OpenAI-compatible endpoint |

Every adapter runs a shared conformance suite, exported from
`@gagandeep023/support-chat-server/testing`, so a fourth one you write is held to
the same bar:

```ts
import { describeDataStore } from "@gagandeep023/support-chat-server/testing";
describeDataStore("mongo", () => ({ store, seedTenant, dispose }));
```

Retrieval is hybrid: BM25 for the error codes and SKUs people paste, vectors for
paraphrase. Embeddings are optional, and keyword search alone is a reasonable
default.

## Running more than one pod

Redis alone is not enough. socket.io rooms are per-process, so a customer on one
pod will never see a reply typed by an agent on another, and nothing errors.
`socketAdapter: { type: "redis" }` closes that.

Deploys drain rather than drop: every socket is told when to reconnect, with the
delay spread across clients, so a rolling deploy does not become a stampede.

## Development

```bash
npm install
npm test          # 266 tests; external-service suites skip cleanly
npm run build
npm run typecheck
```

The suites that need infrastructure opt in by environment variable:

```bash
SUPPORT_CHAT_TEST_DATABASE_URL=postgres://localhost/support_chat_test \
SUPPORT_CHAT_TEST_REDIS_URL=redis://127.0.0.1:6379 \
SUPPORT_CHAT_TEST_LOCAL_EMBEDDINGS=1 \
npm test          # 352 tests
```

## Design

[DESIGN.md](./DESIGN.md) is the long form: what was decided, what was rejected
and why, and the measurements behind the defaults. It records the mistakes too,
which is usually the more useful half.

## License

MIT
