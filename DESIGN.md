# Support Chat: Design

An embeddable AI support chat system distributed as npm packages. A host application
installs it, mounts it into its own server and dashboard, and gets an AI agent that
answers from the host's own docs, plus a handoff path to human agents.

Status: design. Nothing is built yet.

---

## 1. What this is, and what it is not

**It is** a self-hosted library. The customer brings their own database, their own
LLM key, and their own auth. We ship the engine, the protocol, the widget, and the
agent console.

**It is not** a hosted service. We never see customer data, never run their sockets,
and never hold their support transcripts. This removes uptime liability and data
liability, and it is the reason the whole thing can be a set of npm packages rather
than a product with a control plane.

The practical consequence: every external dependency must be an interface with at
least two implementations, one of which needs no infrastructure at all. If a
first-time evaluator cannot get a working chat in under a minute with zero services
running, the plug-and-play claim is false.

---

## 2. Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Distribution | Self-hosted npm library | No infra to run, no data liability, open-core path stays open |
| Database | Pluggable adapter interface | Reach beyond Postgres shops; cost is accepted and mitigated in section 5 |
| Agent identity | Host app owns it, signed JWT | Zero user management to build, genuinely droppable into an existing dashboard |
| AI | Prompt + RAG on a cheap hosted model | See section 3.1 |
| Session state | Redis or in-memory, never socket memory | See section 3.2 |
| Encryption | Schema in v1, implementation in v1.1 | See section 12 |
| Wire protocol | Versioned envelope, `{ v, type, id, ts, payload }` | One schema validates every frame; version is a field, not a transport concern; survives a move off socket.io |

---

## 3. Rejected approaches

Recording these so they do not get re-proposed in three months.

### 3.1 Fine-tuning a cheap model for answer generation

Rejected. Fine-tuning teaches style and format, not facts. Support answers are facts
about a specific product, and those facts change weekly, so the model would need
retraining on every docs update.

It also does not survive the distribution model. Every customer has different docs,
so "fine-tune a cheap model" becomes N models to train, host, version, and evict.
That is not something a self-hosted npm package can ask of anyone. And fine-tuning
needs thousands of labeled transcripts, which do not exist on day one.

A cheap hosted model with a tight system prompt and retrieval over the customer's own
docs costs a fraction of a cent per reply, needs no training infrastructure, and
updates the moment the customer updates their docs.

**Where fine-tuning may return:** classification, not generation. Intent detection and
"should this escalate" are small, stable, label-cheap tasks where a small tuned model
genuinely beats prompting on both latency and cost. Revisit only after suggest-mode
(section 13) has produced clean labeled transcripts.

### 3.2 Keeping sessions alive in the socket server's memory

Rejected. If session state lives in socket.io process memory, a single pod restart
drops every live conversation, and horizontal scaling is impossible because a user's
socket and their conversation state can land on different nodes.

The socket layer holds zero authoritative state. Durable state is in the DataStore,
ephemeral state is in the CacheStore, and the socket is a dumb transport. On reconnect
the client sends its last seen message id and the server replays the gap.

### 3.3 CSS class overrides for widget theming

Rejected. If customers target our class names, every internal markup change is a
breaking change for them, and we would be frozen on our first DOM structure forever.
Replaced by the three-tier model in section 10.

### 3.4 Cross-table transactions

Rejected, as a consequence of the pluggable DataStore. Postgres, SQLite, and Mongo all
have transactions with meaningfully different semantics and failure modes. Relying on
them guarantees adapters that diverge in ways integration tests will not catch.

Every write is a single-row operation. Anything that needs "persist, then fan out"
uses an outbox row, which is what at-least-once delivery requires regardless.

---

## 4. Package layout

Monorepo, published as separate packages so a consumer installs only what they mount.

| Package | Contents |
| --- | --- |
| `core` | Types, event protocol, zod schemas, shared pure logic. Zero runtime deps. |
| `server` | The engine. Returns a mountable router plus a socket attach function. |
| `widget` | End-user chat bubble. Web component build plus a React wrapper. |
| `dashboard` | Agent console as a React component, plus a standalone build. |
| `react-native` | WebView wrapper and native bridge. |
| `cli` | `migrate`, `dev`, `seed`. |

Adapters ship as entry points inside `server` rather than separate packages
(`server/adapters/postgres`, `server/adapters/redis`, and so on). Separate packages
would mean version-matrix pain for a gain nobody asked for.

The widget is a web component, not a React component, at its core. A React-only widget
excludes every Vue, Angular, Svelte, Rails, and plain-HTML site, which is most of the
addressable market. React gets a thin wrapper on top.

---

## 5. The six interfaces

Everything external is behind one of these. Core logic depends only on the interfaces.

```ts
createSupportChat({
  data:    DataStore,    // postgres | sqlite | mongo
  cache:   CacheStore,   // redis | memory
  vector:  VectorStore,  // pgvector | qdrant | memory
  chat:    ChatProvider, // anthropic | openai-compatible
  embed:   EmbeddingProvider, // local-onnx | voyage | openai-compatible
  storage: FileStore,    // s3 | local
  config:  SupportChatConfig,
}) // => { router, attach(httpServer), close() }
```

### 5.1 DataStore

Narrow and domain-shaped. No query builder, no `find`, no `where`, no joins exposed.
A generic interface here degenerates into a bad ORM and guarantees adapter drift.

```ts
interface DataStore {
  init(): Promise<void>                       // adapter owns its own migrations

  // tenants
  getTenant(id: string): Promise<Tenant | null>
  upsertTenant(t: NewTenant): Promise<Tenant>

  // conversations
  createConversation(c: NewConversation): Promise<Conversation>
  getConversation(tenantId: string, id: string): Promise<Conversation | null>
  setConversationStatus(id: string, status: ConversationStatus, meta?: Json): Promise<void>
  assignConversation(id: string, agentId: string | null): Promise<void>
  listConversations(tenantId: string, f: ConversationFilter): Promise<Page<Conversation>>

  // messages
  appendMessage(m: NewMessage): Promise<Message>
  listMessages(conversationId: string, o: { afterId?: string; limit: number }): Promise<Message[]>

  // end users and agents
  upsertEndUser(u: NewEndUser): Promise<EndUser>
  upsertAgent(a: AgentRecord): Promise<void>
  getAgent(tenantId: string, id: string): Promise<AgentRecord | null>

  // audit
  appendEvent(e: ConversationEvent): Promise<void>
  listEvents(conversationId: string): Promise<ConversationEvent[]>

  // knowledge base
  upsertDocument(d: NewDocument): Promise<Document>
  deleteDocument(tenantId: string, id: string): Promise<void>
  listDocuments(tenantId: string): Promise<Document[]>

  // attachments
  recordAttachment(a: NewAttachment): Promise<Attachment>

  // outbox
  claimOutbox(limit: number): Promise<OutboxEntry[]>
  ackOutbox(ids: string[]): Promise<void>
}
```

About twenty methods, all cursor-paginated where they return lists. An adapter is a
day of work. We write Postgres, SQLite, and Mongo ourselves before anyone else writes
one, so the interface is proven against three genuinely different storage shapes
rather than three flavours of SQL.

### 5.2 CacheStore

Ephemeral coordination state. Presence, queue, load counters, and cross-node pub/sub.

```ts
interface CacheStore {
  publish(channel: string, payload: Json): Promise<void>
  subscribe(channel: string, handler: (p: Json) => void): Promise<Unsubscribe>

  heartbeat(tenantId: string, agentId: string, ttlSec: number): Promise<void>
  onlineAgents(tenantId: string): Promise<string[]>

  incrLoad(agentId: string): Promise<number>
  decrLoad(agentId: string): Promise<number>
  getLoad(agentIds: string[]): Promise<Record<string, number>>

  enqueue(tenantId: string, conversationId: string): Promise<void>
  dequeue(tenantId: string): Promise<string | null>
  queueDepth(tenantId: string): Promise<number>
}
```

Redis adapter for multi-node, in-memory adapter for single-node and dev. The in-memory
adapter is not a toy; a team running one instance should never be forced to operate
Redis, and that is only true if the fallback is a real implementation. Both run the same
conformance suite, because a gap between them is a bug that appears only in production.

Three details in the Redis adapter are load-bearing, and each fails a conformance test
when removed:

- **Every multi-step operation is a Lua script.** Read-then-write from application code
  is a race between pods, which is the exact situation this adapter exists for; if one
  process were enough the in-memory store already works. Claim, holder-checked release,
  floored decrement and deduplicated enqueue are all `EVAL`.
- **Release must compare the holder atomically.** `GET` then `DEL` from the client lets
  the TTL expire between the two calls, and the `DEL` then removes somebody else's
  claim.
- **Presence is a sorted set scored by expiry, not one key per agent.** Listing online
  agents runs on every routing decision; per-agent keys would make that a `SCAN` across
  the keyspace.

**A RedisCacheStore alone does not make a second pod work.** socket.io rooms are
per-process, so `nsp.to(room).emit()` reaches the pod that ran it and nowhere else. A
customer whose socket is held by pod A never sees the reply typed by an agent on pod B,
and nothing errors: messages silently go missing for some users and not others. The
`socketAdapter: { type: "redis" }` config attaches socket.io's own Redis adapter, and
there is a two-server test that fails with a timeout when it is removed.

Presence is a TTL heartbeat, deliberately not "is the socket connected". Agents leave
laptops open on locked screens, and socket liveness would route conversations to them.

### 5.3 VectorStore

Deliberately separate from DataStore. This is what keeps the pluggable-DB decision
affordable.

```ts
interface VectorStore {
  upsert(chunks: VectorChunk[]): Promise<void>
  search(embedding: number[], o: { topK: number; filter?: Json }): Promise<VectorChunk[]>
  deleteByDocument(documentId: string): Promise<void>
}
```

Three adapters:

- `pgvector`: costs nothing extra for anyone already on Postgres. Retrieval stays a
  single-service deployment, which is the strongest self-hosting story available.

  **It defaults to exact search, with no vector index, and that is deliberate.** A
  single HNSW index shared across tenants is silently wrong: `WHERE tenant_id = $1` is
  applied *after* the approximate scan, so the index returns its nearest candidates
  across every tenant and the filter then discards the ones belonging to somebody else.
  A tenant whose chunks sit away from the query direction gets nothing back at all.

  Measured on a 30,000-row table with a two-chunk tenant: a global HNSW index returned
  **zero** rows, a per-tenant partial index returned both, and so did an exact scan.
  `hnsw.iterative_scan`, even with a raised scan budget, did not rescue it.

  The failure takes the worst available shape. Retrieval comes back empty, the grounding
  rule correctly makes the bot say it does not know, and it does that for every question
  asked by the tenants with the least data, which is every new customer. Nothing errors
  and nothing looks broken.

  A knowledge base is hundreds to low thousands of chunks per tenant, where an exact
  scan is sub-millisecond, so the approximation was buying nothing worth a correctness
  cliff. `index: "per-tenant"` builds a partial HNSW index per tenant for anyone who
  genuinely outgrows that, and there is deliberately no option for a global one.
- `qdrant`: for Mongo, MySQL, or anyone who wants a dedicated vector service.
- `memory`: brute-force cosine similarity. Fine to a few thousand chunks, which covers
  most documentation sites, and it makes dev mode work with zero services.

### 5.4 ChatProvider and EmbeddingProvider

These are two interfaces, not one. An earlier draft had a single `AIProvider` with
both `complete` and `embed` on it, which is wrong: Anthropic has no embeddings
endpoint, so the Anthropic adapter cannot implement `embed` at all. Retrieval quality
and answer quality are also independent choices a customer should be allowed to make
separately.

```ts
interface ChatProvider {
  complete(req: CompletionRequest): AsyncIterable<CompletionDelta>
}

interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
  readonly dimensions: number   // VectorStore needs this at index creation time
}
```

`complete` must support tool calls, because escalation is modelled as a tool
(section 8) rather than as string matching on the model's prose.

Adapters: Anthropic and OpenAI-compatible for chat, where the OpenAI-compatible one
covers Moonshot, Groq, Together, Fireworks, DeepInfra, OpenRouter, vLLM, and Ollama in
a single implementation.

**Embeddings default to none, and retrieval then runs on keyword search alone.**

*Corrected while implementing.* An earlier draft called for defaulting to a local ONNX
model, on the grounds that it needs no key and makes reindexing free. Both are true, and
the measured numbers are good: MiniLM-L6 embeds a chunk in 2.7ms warm with a 0.3s cold
start once weights are cached. What the draft missed is the install. `@huggingface/transformers`
pulls `onnxruntime-node` at 215MB on disk, plus the model download on first use. "Plug
and play" and "a 300MB native runtime" do not belong in the same sentence, and nobody
should acquire that by accident.

So there are three real choices, and the docs should present them as such:

| Choice | Cost | What it gets you |
| --- | --- | --- |
| None (default) | nothing | BM25 only. Handles the error codes, SKUs and exact feature names support users actually paste. |
| `LocalEmbeddingProvider` | ~215MB install, model download | Semantic retrieval, no key, no per-token bill, free reindexing. |
| `OpenAICompatibleEmbeddingProvider` | a key, or one local container | Semantic retrieval with nothing heavy in this package. Covers OpenAI, Voyage, Jina, and a local Ollama or TEI server. |

That third row is the underrated one: pointing the OpenAI-compatible provider at a local
embedding container gets the benefit of local embeddings without the dependency.

**What the vector half actually buys, measured.** For "how do I get my money back",
against a document whose refunds section never uses the word refund in those terms,
keyword search returns nothing relevant and hybrid retrieval returns the refunds
section first. Against a pasted error code, keyword search still wins and hybrid keeps
it. Both are regression tests; a hybrid that only beat one of them would be a single
method with extra steps.

`HashedEmbeddingProvider` also ships, and the naming is deliberate: it is a random
projection of a bag of words, so it measures lexical overlap and not meaning. It exists
to exercise the vector path with no download and to act as a floor to measure a real
model against. On the paraphrase above its margin over the next-best chunk was 0.100
against MiniLM's 0.245.

**Changing the embedding model is a reindex, not a config change.** Vectors from
different models are not comparable, and dimensions usually differ. The
EmbeddingProvider's model id is recorded alongside every indexed chunk, and a mismatch
on startup is a hard error with a `reindex` instruction, not a silent degradation into
nonsense retrieval.

### 5.4.1 Model choice

Per million tokens, with cost modelled on a typical turn of 3,000 input tokens
(system prompt, retrieved chunks, history) and 200 output tokens, across ten thousand
five-turn conversations per month:

| Model | Input | Output | Context | Per turn | Per 10k conversations |
| --- | --- | --- | --- | --- | --- |
| Kimi K2.5 (`kimi-k2.5`) | $0.60 | $3.00 | 256K | $0.0024 | $120 |
| Kimi K2.6 | $0.95 | $4.00 | 256K | $0.0037 | $182 |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | $1.00 | $5.00 | 200K | $0.0040 | $200 |
| Claude Sonnet 5 (`claude-sonnet-5`) | $2.00 | $10.00 | 1M | $0.0080 | $400 |
| Kimi K3 | $3.00 | $15.00 | 1M | $0.0120 | $600 |
| Claude Opus 5 (`claude-opus-5`) | $5.00 | $25.00 | 1M | $0.0200 | $1,000 |

Prices verified September 2026. They move; re-check before quoting them to anyone.

**Default is `claude-sonnet-5`, not Haiku.** The reflex to pick the cheapest model is
wrong here, because tokens are not the dominant cost in a support system.

A typical turn is roughly 3,000 input tokens (system prompt, retrieved chunks,
conversation history) and 200 output tokens. That is about $0.004 per turn on Haiku
4.5 and $0.008 on Sonnet 5. Across ten thousand five-turn conversations a month, the
difference is roughly $200 against $400, before caching cuts both substantially.

Meanwhile one unnecessary escalation consumes something like ten minutes of a human
agent's time. If Sonnet 5 prevents twenty unnecessary escalations a month it has
already paid for the entire difference. That is a very low bar for a model at twice
the price and meaningfully better instruction-following and tool-use reliability.

The shipped default is `claude-sonnet-5` because it is the most predictable thing to
put in front of a developer who has not configured anything yet. **Kimi K2.5 is the
first-class documented alternative**, and at $120 per ten thousand conversations it is
cheaper than Haiku 4.5 while being a far more capable model, so a cost-sensitive deploy
should be a one-line config change and not a downgrade. See 5.4.1b.

Model is per-tenant configuration in every case, because in a self-hosted library it is
the customer's bill. Context window is not a factor in this decision; 200K is already
far beyond what a support conversation with retrieval uses.

**Recommended request configuration for the responder:**

```ts
client.messages.stream({
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'low' },
  system: [...],
  tools: [requestHumanTool],
  messages: [...],
})
```

Notes on each choice:

- **Effort `low`.** Chat and classification routes do not repay high effort, and
  support chat is latency-sensitive. This is the single largest cost lever after
  caching.
- **Thinking stays on (adaptive), rather than disabled.** With thinking disabled, a
  model can write a tool call into its visible text instead of emitting a `tool_use`
  block. The turn succeeds, nothing errors, and the call never runs. Since escalation
  *is* a tool call here, that failure mode silently breaks handoff. Adaptive thinking
  at low effort is both safer and still cheap.
- **Thinking display stays at the default (omitted).** Reasoning is never shown to end
  users in a support widget.
- **`max_tokens: 1024`.** Support answers are short. This is one of the rare cases
  where a low cap is correct rather than a truncation risk.
- **`strict: true` on the escalation tool**, with `additionalProperties: false` and
  `required` set, so the handoff payload always validates. Core code branches on those
  fields, so a malformed one is a routing bug.
- **No assistant prefill.** It returns a 400 on every model in the table. Use
  `output_config.format` if output shape ever needs constraining.

Per-model request differences are owned by the adapter, never by core. Haiku 4.5 takes
the older `thinking: { type: 'enabled', budget_tokens: N }` and rejects
`output_config.effort` entirely, while Sonnet 5 and Opus 5 take adaptive thinking and
effort. Core asks for a completion at a quality tier; the adapter translates.

### 5.4.1b Open-weight models

Open weights are supported with no new code, because the OpenAI-compatible
`ChatProvider` adapter already reaches every provider that serves them. Two findings
shape how the docs should present this.

**"Open weights" does not mean "self-hostable" at the frontier.** Kimi K2.5 is a 1T
parameter mixture-of-experts model released under a Modified MIT license in January
2026. Serving it in production takes roughly 8x H200, about 1.1TB of VRAM at FP8, which
rents for somewhere in the region of $15,000 to $25,000 a month. Quantized CPU-offload
setups run it on a single consumer GPU at five to ten tokens per second, which is
unusable for interactive chat. For every realistic user of this library, K2.5 means an
API call, not a GPU.

Self-hosting is only plausible for small models in the 7B to 14B class, and there the
economics still lose: a GPU instance capable of serving one runs $550 to $750 a month,
against $120 to $400 a month for a hosted frontier model at ten thousand conversations.
Self-hosted open weights start winning on cost somewhere north of fifty thousand
conversations a month, and give worse answers until then. The documentation should say
this plainly rather than let people discover it from a cloud bill.

**Where open weights genuinely pay off is provider choice.** Because K2.5's weights are
open, it is served by US and EU hosted providers as well as by Moonshot directly. A
customer with data residency obligations can run the same model without routing support
transcripts, which contain customer PII by definition, through any single jurisdiction.
That option does not exist for a closed model at any price, and for a support product it
is worth more than the token savings.

The earlier concern that open models cannot be trusted with the escalation tool call
applies to 7B-class models, not to K2.5, which holds tool-call coherence across
hundreds of sequential calls and leads the agentic benchmarks. It is not a compromise
pick on this workload.

Two things to verify per provider before recommending one, since neither is a property
of the model:

- **Prompt caching.** Section 5.4.2 leans on caching the tools and system prefix.
  Anthropic exposes explicit `cache_control` breakpoints; OpenAI-compatible providers
  vary between automatic prefix caching, no caching, and their own cache-hit pricing.
  `ChatProvider` therefore carries a `supportsExplicitCaching` capability flag, and the
  prompt is assembled stable-prefix-first regardless, so it benefits from automatic
  prefix caching wherever that is what the provider offers.
- **Latency.** Large MoE models can have higher time-to-first-token than a small dense
  model. In a chat widget that is felt directly, so it should be measured on the actual
  provider rather than assumed from the benchmark tables.

### 5.4.2 Prompt assembly and caching

This is an architecture decision rather than a tuning knob, because getting it wrong
costs money on every single request and the symptom is invisible.

Requests render in the order `tools` -> `system` -> `messages`, and caching is a
prefix match, so any byte that changes invalidates everything after it. In this system
the tool definitions and the tenant's system prompt are identical on every request for
that tenant, while retrieved chunks and the user's question change every time.

Two rules follow:

1. **Retrieved chunks never go in the system prompt.** Putting them there changes the
   prefix on every request, so nothing ever caches. They go in the user message, after
   the breakpoint.
2. **Do not use top-level automatic `cache_control`.** Automatic caching places its
   breakpoint after the last cacheable block, which here is the per-request retrieved
   content. Every request would then pay the cache-write premium on bytes that are
   never read back, which is a pure surcharge. Place an explicit breakpoint on the last
   system block instead, which caches tools and system together.

```ts
system: [
  { type: 'text', text: tenantSystemPrompt,
    cache_control: { type: 'ephemeral' } },   // explicit, at the stability boundary
],
messages: [
  ...history,
  { role: 'user', content: [
    { type: 'text', text: renderRetrievedChunks(chunks) },  // volatile, uncached
    { type: 'text', text: userMessage },
  ]},
]
```

**Verification is part of the implementation, not an afterthought.** Log
`usage.cache_read_input_tokens` on every completion. If it is zero across repeated
requests within a tenant, a silent invalidator is at work, and the usual culprit is an
interpolated timestamp or a non-deterministic tool ordering in the system prefix. This
should be an assertion in the integration tests, not something discovered on a bill.

### 5.4.3 Supporting any model

The goal is that a customer can point this at whatever model they want, including an
internal or proprietary one. That is already true structurally, since `ChatProvider`
is an interface, but "any model" done naively fails in a specific way worth naming.

**The failure mode is capability, not transport.** Sending a request to any model is
easy; nearly everything speaks an OpenAI-compatible API. What breaks is that core
logic silently depends on capabilities that vary: native tool calling, explicit cache
control, a separate system role, structured outputs, reasoning configuration, context
and output limits. Write core against the union of those and it breaks on weak models
with no error. Write it against the intersection and capable models are wasted.

**The answer is declared capabilities plus one implementation per tier**, rather than
capability checks scattered through the code:

```ts
interface ProviderCapabilities {
  toolCalling: 'native' | 'json-mode' | 'none'
  explicitCaching: boolean
  systemRole: boolean
  streaming: boolean
  maxContextTokens: number
  maxOutputTokens: number
}

interface ChatProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  complete(req: CompletionRequest): AsyncIterable<CompletionDelta>
}
```

Core resolves the strategy once at startup from `capabilities`, and every path is a
real tested implementation rather than a degraded one. The escalation detector is the
clearest case, and it is why section 8 no longer routes escalation through tool
calling: a separate detection step has a working implementation at every tier, down to
a plain text completion parsed for yes or no, which any model that emits text can do.

**Adapter count stays small.** One OpenAI-compatible adapter reaches Moonshot, Groq,
Together, Fireworks, DeepInfra, OpenRouter, vLLM, and Ollama. Anthropic gets a native
adapter because explicit `cache_control` is worth it. Google and Bedrock get one each
if demand appears. Past that, `ChatProvider` is public and documented with a template,
so a customer can wire up an internal model without forking anything. That escape
hatch, not the adapter list, is the real answer to "any model".

**There is a quality floor, and pretending otherwise is dishonest.** A model too weak
to stay grounded in retrieved context will invent refund policies and damage the
customer's brand, which is worse than having no bot. So the docs carry two tiers:
*supported*, meaning there are evals in CI against it, and *works with*, meaning the
interface fits and the customer owns the outcome. Configuring an unlisted model logs a
warning at startup, not an error.

**The scripted fallback is part of the promise, not a testing convenience.** With no
key set at all, `dev` answers with a stand-in and says so. "No infrastructure" is only
half the barrier; requiring an API key before anything moves is the other half, and
somebody deciding whether they like this should be able to watch the whole loop, ask a
question, and queue for a human before spending anything.

**Two CLI commands make this real rather than merely possible:**

- `support-chat doctor` runs a preflight against the configured provider at boot or on
  demand: streaming works, the escalation detector returns a parseable verdict, the
  context window fits the configured retrieval budget, and embedding dimensions match
  the index. Failing loudly at startup beats failing at 2am inside a customer
  conversation.
- `support-chat eval` scores a chosen model on the customer's own documentation:
  answer grounding, refusal when retrieval is empty, and escalation accuracy against a
  labelled set. Without this, "use any model you like" hands the customer a decision
  they have no way to evaluate. With it, model choice becomes measurable, and it is the
  same harness that would later justify a fine-tuned classifier per section 3.1.

### 5.5 FileStore

`put`, `getSignedUrl`, `delete`. S3-compatible adapter and a local-disk adapter.

---

## 6. Data model

Storage-agnostic shape. The Postgres adapter maps this to tables, the Mongo adapter to
collections.

- **tenants**: id, name, publishable_key, secret_key_hash, settings (json), created_at.
  Multi-tenant even in single-tenant installs, because retrofitting a tenant column
  later is a migration nobody enjoys.
- **end_users**: id, tenant_id, external_id (nullable, from signed identity),
  is_anonymous, display_name, email, attributes (json), created_at.
- **agents**: id, tenant_id, external_id, display_name, avatar_url, skills (string[]),
  max_concurrent, created_at. A projection of the host's user record, created on first
  authenticated connect. We are not the system of record for agents.
- **conversations**: id, tenant_id, end_user_id, status, assigned_agent_id (nullable),
  channel, subject, tags, last_message_at, created_at, resolved_at.
- **messages**: id, conversation_id, tenant_id, sender_type, sender_id, body (nullable),
  body_encrypted (nullable), content_type, metadata (json), client_message_id,
  created_at.
- **conversation_events**: id, conversation_id, type, actor, payload (json), created_at.
- **documents** and **chunks**: knowledge base source records. Embeddings live in the
  VectorStore, not here.
- **attachments**: id, message_id, tenant_id, file_key, mime, size, created_at.
- **outbox**: id, topic, payload (json), created_at, claimed_at, delivered_at.

`conversations.status` is one of `ai`, `queued`, `assigned`, `resolved`. Every
transition writes a `conversation_events` row. That audit trail is what makes
escalation thresholds tunable against real data later instead of by guesswork.

`messages.sender_type` is one of `user`, `ai`, `agent`, `system`. `client_message_id`
is supplied by the client and unique per conversation, which makes message sends
idempotent across reconnects without needing a transaction.

---

## 7. Authentication

Three separate identities. Conflating any two of them is the most common way this
class of product gets a security hole.

### 7.1 End user, in the browser

The widget carries a **publishable key**, which is public by design and identifies the
tenant only. It grants the ability to start an anonymous conversation, nothing more.

For logged-in users the host app additionally passes a **signed identity**:

```ts
// on the host's server, never in the browser
const userHash = hmacSha256(SECRET_KEY, externalUserId)
```

The widget sends `{ externalUserId, userHash }`. The server recomputes the HMAC and
rejects a mismatch. Without this, anyone can open devtools, send someone else's user
id, and read that person's support history. The secret key never reaches the browser.

### 7.2 Agent, in the host's dashboard

The host owns agent identity. Their server mints a short-lived JWT from their own
session:

```ts
import { signAgentToken } from '@scope/support-chat-server'

app.get('/api/support-chat/token', requireAuth, (req, res) => {
  res.json({
    token: signAgentToken(
      { agentId: req.user.id, tenantId: TENANT, name: req.user.name,
        skills: req.user.supportSkills, role: req.user.isAdmin ? 'admin' : 'agent' },
      process.env.SUPPORT_CHAT_SECRET,
      { expiresIn: '5m' },
    ),
  })
})
```

```tsx
<AgentConsole fetchToken={() => fetch('/api/support-chat/token').then(r => r.json())} />
```

The console refreshes the token before expiry and reconnects transparently. Roles come
from JWT claims. We build no signup, no login, no password reset, and no invite flow.
This is the entire answer to "droppable into anyone's dashboard".

### 7.3 Server to server

The secret key, as a bearer header, for admin operations: ingesting knowledge base
documents, exporting transcripts, and administrative reads.

---

## 7A. Knowledge ingestion

How the customer's own content reaches the model. This is the retrieval layer, not
training: the knowledge lives in an index the system reads at question time and drops
into the request, never in the model's weights.

That is not just a cost preference. Section 5.4.3 commits to running on any model the
customer picks, and a fine-tune is the opposite of portable: one model, one provider,
retrained on every documentation change, once per tenant, and discarded the moment
they switch. Retrieval is the only design where the customer's knowledge survives a
model swap.

### 7A.1 Sources

Four ways content gets in, all landing in the same pipeline:

| Source | Interface |
| --- | --- |
| Push | `POST /documents` with the tenant secret key, for syncing from a CMS |
| Local files | `support-chat ingest ./docs` |
| Site crawl | `support-chat ingest --sitemap https://docs.example.com/sitemap.xml` |
| Programmatic | `chat.ingest({ id, title, url, content })` from the host app |

### 7A.2 Pipeline

```
source -> normalize to { text, title, url, metadata }
       -> chunk
       -> EmbeddingProvider.embed
       -> VectorStore.upsert  +  DataStore.upsertDocument
```

**Chunking decides retrieval quality more than model choice does**, so it is a design
decision rather than a default to tune later:

- Split on document structure first (markdown headings, then paragraphs), falling back
  to token windows only when a section is oversized. Fixed-size splitting cuts
  sentences in half and produces chunks that retrieve well and read badly.
- Target roughly 500 tokens with about 15% overlap.
- **Prepend the heading path to every chunk**, for example
  `Billing > Refunds > Eligibility`. A chunk reading "You can request one within 30
  days" is worthless without it, and this single step is one of the cheapest large
  wins available in a RAG pipeline.
- Carry `url` and `title` on every chunk so answers can cite their source. A support
  answer with a link to the doc it came from is far more useful than one without, and
  it gives the user a way to verify the bot.

### 7A.3 Freshness

Documents are keyed by a stable customer-supplied `id` and carry a content hash, so
re-ingesting skips unchanged documents.

**Deletion must cascade to the VectorStore.** An orphaned vector means the bot
confidently quotes a policy the customer deleted last month, which is among the worst
failure modes this product has. `deleteByDocument` exists on the interface for exactly
this, and the ingest path treats a document missing from the source as a delete when
running in sync mode.

### 7A.4 Retrieval at question time

```
embed(question) -> VectorStore.search(topK: 8)
                -> drop anything below the similarity threshold
                -> if nothing survives: no context
```

**No context is a first-class outcome, not an empty string.** With nothing retrieved,
the system prompt instructs the model to say it does not know and offer a human, and
the escalation detector (section 8) counts the turn as low confidence. A bot that
invents an answer when retrieval comes back empty is worse than no bot, because the
customer's users trust it and the customer's brand absorbs the error.

**Hybrid retrieval is worth the extra work here.** Support users paste error codes, SKU
numbers, exact feature names, and version strings. Dense vector search is weak on
exactly those rare literal tokens, while keyword search handles them well and is poor
at paraphrase. Running both and merging covers the real query distribution. Keyword
search over the chunk table needs no new infrastructure in any DataStore adapter.

Two details that only show up once it runs:

- **Fuse by reciprocal rank, not by adding scores.** Cosine similarity and BM25 are on
  unrelated scales, so summing them quietly lets whichever scorer happens to produce
  larger numbers decide every ranking.
- **Stopwords have to be dropped before scoring.** BM25's IDF term is meant to discount
  common words, but a knowledge base is a few hundred chunks rather than a web corpus,
  and with that few documents the discount is too weak to work. Without a stoplist,
  "what is the capital of France" scores against a charging manual on "is", "the", and
  "of" alone, which means the empty-retrieval path never fires and the bot answers a
  question it has nothing about. The grounding rule in this section is only as good as
  the threshold underneath it.

### 7A.5 Resolved conversations as a source

The highest-value content is not in the docs. It is the answer a human agent typed at
2pm on a Tuesday for a question nobody documented.

When a conversation resolves, the agent can promote its resolution into a knowledge
document with one click, editable before it is saved. This is the loop that makes the
bot measurably better each week, and it costs almost nothing to build on top of the
pipeline above.

Two rules on it:

1. **Promotion is a human decision, never automatic.** Ingesting every resolved
   conversation teaches the bot every wrong answer an agent ever gave, permanently and
   with full confidence.
2. **Redact before indexing.** Conversation text contains names, emails, order numbers,
   and sometimes worse. Conversation-derived documents pass through redaction first,
   and per section 12, tenants with encryption enabled do not get this feature at all,
   since embedding an encrypted transcript writes a reconstructable copy of it into the
   vector store.

### 7A.6 What is never sent anywhere

Customer content goes to exactly one external place: the configured chat provider, in
the request that answers a question, and only the chunks retrieved for that question.

**No transcript is ever sent to any provider for training, and there is no setting that
enables it.** This matters beyond principle: several providers, free tiers especially,
train on API inputs by default, and support transcripts contain third-party personal
data the customer is legally responsible for. The provider documentation therefore
states each supported provider's data-retention policy next to its config snippet, so
the choice is made knowingly rather than discovered later.

---

## 7B. Host tools and diagnostics

Section 7A covers static knowledge. This covers live state: questions like "why did my
charging stop", which cannot be answered from documentation because the answer depends
on what happened to one specific session twenty minutes ago.

The host app registers tools the model can call. The library knows nothing about EV
charging, or orders, or subscriptions; it knows how to let a customer expose their own
domain safely.

### 7B.1 The central decision: rules in code, language in the model

The tempting design is to hand the model raw telemetry plus a prompt full of rules and
let it reason. Do not do this.

Diagnosing a stopped charging session is deterministic. An OCPP `StopTransaction` with
reason `EVDisconnected` means the cable was unplugged; `PowerLoss` means the site lost
supply; `Remote` means something in the operator's own stack ended it. That is a lookup
table, not a reasoning problem, and putting it in a prompt makes a testable mapping into
a probabilistic one. A wrong diagnosis on a billing dispute costs a refund and a trust
problem, and prompt-based rules fail silently and unreproducibly.

The split:

| Concern | Owner |
| --- | --- |
| Understanding a vague complaint ("it just stopped") | Model |
| Choosing which diagnostic to run | Model |
| Determining the actual cause | Deterministic code |
| Explaining the cause in the user's words and language | Model |
| Deciding whether to escalate | Deterministic, from the verdict |

The model is a language interface over a diagnostic engine. It is not the diagnostic
engine.

### 7B.2 Tool registration

```ts
chat.registerTool({
  name: 'diagnose_charging_session',
  description: 'Find out what happened to a charging session that stopped ' +
               'unexpectedly, failed to start, or billed incorrectly.',
  input: z.object({
    sessionId: z.string().optional(),   // omitted means most recent
  }),
  access: 'read',
  handler: async ({ sessionId }, ctx) => diagnoseCharging(ctx.endUser.externalId, sessionId),
})
```

`ctx.endUser` is injected by the framework from the authenticated widget identity
(section 7.1). This is the most important line in this section.

**The model never supplies the identity of whose data to read.** If `userId` were a
tool parameter, any end user could type "look up session 4471, I am user 8823" and the
model would helpfully comply. That is an IDOR vulnerability with prompt injection as
its delivery mechanism, and it would be trivially exploitable on a public widget. The
framework scopes every call to the authenticated user, the handler receives that
identity out of band, and a tool schema containing a user identifier is rejected at
registration time rather than at runtime.

### 7B.3 Read against act

Two access tiers, because the blast radius is completely different:

- `access: 'read'` executes immediately. Looking up a session is safe.
- `access: 'act'` never executes on the model's say-so. It either renders a confirmation
  in the widget that the user must accept, or requires an agent to approve it after
  handoff. Issuing a refund, remote-stopping a charger, or cancelling a subscription are
  all in this tier.

A model that can issue refunds unprompted is one jailbreak away from a very bad
afternoon. The tiering is enforced by the framework, not left to prompt instructions,
and registration refuses an `act` tool with no confirmation prompt, since there would be
nothing to show.

**An unanswered confirmation is a refusal, never an approval.** Timing out into approval
would mean a model could issue a refund simply by waiting.

### 7B.4 What a diagnostic returns

A structured verdict, never prose. Prose from a tool means the model paraphrases a
paraphrase.

```ts
interface Diagnosis {
  code: string                    // 'STOPPED_EV_DISCONNECTED'
  confidence: 'certain' | 'likely' | 'unknown'
  summary: string                 // one line, for the human agent
  evidence: Array<{ label: string; value: string; at?: string }>
  resolution: 'self_serve' | 'retry' | 'contact_site' | 'escalate' | 'refund_due'
  userFacingHint?: string         // optional phrasing constraint for regulated wording
}
```

The rules themselves are ordered checks, first match wins, written by the customer
because only they know their domain. For a charging session that looks roughly like:

```ts
const rules = [
  { code: 'NO_SESSION_FOUND',          when: c => !c.session },
  { code: 'AUTH_FAILED',               when: c => c.session.state === 'rejected' },
  { code: 'PREAUTH_FAILED',            when: c => c.payment?.status === 'declined' },
  { code: 'CHARGER_OFFLINE',           when: c => c.lastHeartbeatAgeSec > 300 },
  { code: 'CHARGER_FAULTED',           when: c => c.lastStatus?.errorCode !== 'NoError' },
  { code: 'STOPPED_EV_DISCONNECTED',   when: c => c.stopReason === 'EVDisconnected' },
  { code: 'STOPPED_POWER_LOSS',        when: c => c.stopReason === 'PowerLoss' },
  { code: 'STOPPED_BY_VEHICLE_FULL',   when: c => c.stopReason === 'Local' && c.soc >= 97 },
  { code: 'STOPPED_REMOTE',            when: c => c.stopReason === 'Remote' },
  { code: 'UNKNOWN',                   when: () => true },
]
```

Every branch is a unit test with no model in the loop. Adding a cause is one entry and
one test. Changing wording never touches the logic.

### 7B.5 Grounding

**The model may not state a cause the diagnostic did not return.** This is the same
rule as empty retrieval in 7A.4 and it matters more here, because a speculative "your
charger probably had a network issue" is a factual claim about the customer's
infrastructure, made to their user, in a conversation that may end up attached to a
billing dispute.

`confidence: 'unknown'` therefore routes straight to a human. The bot says it cannot
tell and is getting someone, which is the correct and honest output.

### 7B.6 Handoff carries the verdict

When `resolution` is `escalate` or `refund_due`, the handoff in section 9 carries the
full `Diagnosis` with it. The agent opens the conversation already holding the session
id, the stop reason, the charger's last heartbeat, and the timeline, instead of asking
the user to repeat everything while they go look it up themselves.

This is where most of the human-time saving in the product actually comes from, and it
holds even when the bot could not resolve the issue.

### 7B.7 Costs of this feature, stated plainly

- **It raises the model floor.** Diagnostics needs `toolCalling: 'native'`
  (section 5.4.3). The responder checks this before offering tools at all: handing a
  tool definition to a model that cannot emit a tool-use block produces a turn where the
  call is written into visible text and silently never runs. Escalation deliberately does not depend on tool calling so that any
  model works; this feature does. `support-chat doctor` reports diagnostics as
  unavailable rather than letting it fail quietly on a model that cannot support it.
- **Every tool call is audited.** Name, arguments, verdict, and latency land in
  `conversation_events`, on failure as well as success. For a billing dispute you need to
  be able to show what the bot looked at and what it said.
- **A handler's exception never reaches the customer.** It can carry stack traces, SQL,
  or internal identifiers, and whatever the tool returns is read back to the user by the
  model. Failures become a generic sentence; the real error goes to the audit trail.
- **A deterministic verdict outranks the classifier.** A diagnosis that resolves to
  `escalate` or `refund_due` queues the conversation even when the escalation detector
  disagrees, because the rules are deterministic and the classifier is not.
- **Latency grows.** A diagnosed answer is two model round trips plus the host's own
  query. The widget shows a working state rather than a silent gap.

---

## 8. Message flow

```
user types
  -> ws  message:send { conversationId, clientMessageId, body }
  -> server persists (idempotent on clientMessageId)
  -> ws  message:ack { clientMessageId, messageId, seq }
  -> retrieval: embed query, VectorStore.search, assemble context
  -> ChatProvider.complete(stream)
  -> ws  message:delta  (token stream to the user)
  -> persist final assistant message
  -> escalation detector -> if escalate, go to section 9
```

**Escalation is a separate detection step, not a mid-generation tool call.** An
earlier draft modelled it as a `request_human` tool the model invokes while answering.
That was changed for two reasons. Tool calling is the least portable capability across
models, so any-model support (section 5.4.3) cannot depend on it. And when a model
fails to emit the tool call, nothing errors: the turn succeeds, handoff silently never
fires, and the user sits talking to a bot that should have handed off.

After the answer is generated, a detector returns a verdict:

```ts
interface EscalationVerdict {
  escalate: boolean
  reason: string
  summary: string            // handed to the agent verbatim
  urgency: 'low' | 'normal' | 'high'
}
```

It has one implementation per capability tier: structured outputs where available,
otherwise a small classification completion parsed for a verdict. Both are cheap, both
are independently testable, and escalation accuracy can be measured without generating
answers at all.

Escalation triggers, in priority order:

1. Explicit user request, matched before the model call so it cannot be ignored.
2. The detector's verdict.
3. N consecutive low-confidence turns, where low confidence means retrieval returned
   nothing above the similarity threshold.
4. Configurable keyword or sentiment rules per tenant.

The cost is one extra round trip per turn and escalation landing after the answer
rather than instead of it. Both are acceptable; a user reading one final bot reply
before a human arrives is a much smaller problem than handoff not firing.

Each writes a `conversation_events` row with its trigger type, so a customer can see
which rule is firing and tune it.

**Listener registration precedes sending.** A client that subscribes to replies only
after awaiting its `message.ack` can miss the answer: with a fast provider the whole
pipeline can finish in the gap. The widget attaches its handlers on connect, not per
send, and the same applies to anyone writing a client against this protocol.

**Reconnect.** The client stores the last seen `seq` per conversation. On reconnect it
sends `session:resume { conversationId, lastSeq }` and the server replays from the
DataStore. There is no server-side session object to lose.

---

## 9. Routing and handoff

The AI is a few hundred lines. Routing is where products in this category actually
fail, so it gets designed properly.

```
handoff:request { conversationId, reason, summary, urgency }
  -> status = queued, event recorded
  -> candidates = agents where
       heartbeat age < 30s
       AND current load < max_concurrent
       AND (skills intersect required tags, if any)
  -> pick least loaded; tie-break on longest idle
  -> ws agent:offer -> that agent's console, 20 second accept window

  accepted  -> status = assigned, incrLoad, AI mutes,
               full transcript plus the AI's summary pushed to the agent
  expired   -> record the miss, mark the agent idle-suspect, try the next candidate
  exhausted -> status stays queued
  no candidates -> AI says so honestly, capture email, emit webhook
```

Design notes that matter:

- **Offers are claimed atomically.** `claim(key, holder, ttl)` on the CacheStore, which
  maps to Redis `SET NX EX`. Without it the check-then-assign is a race, and its symptom
  is two agents typing replies to the same customer.
- **Least-loaded, not round-robin.** Round-robin hands a fourth conversation to a
  saturated agent while someone else sits idle.
- **Accept windows are mandatory.** Without one, a conversation rots on an agent who
  walked away, and the user waits forever in a queue of one.
- **The agent receives the AI's transcript and summary.** If the agent starts from
  scratch the user repeats everything they just typed, which is the single most
  reliable way to make handoff feel worse than no AI at all.
- **The no-agents path is a first-class state**, not an error. The AI should say that
  nobody is available and offer to take an email, which requires it to know the queue
  state.
- **The router walks the whole queue, not just its head.** A conversation nobody can
  take right now, because everyone available has already declined it or it needs a skill
  nobody online has, must not block every conversation behind it. This one is easy to
  miss because it looks correct until the first unplaceable conversation arrives, and
  then the queue simply stops.
- **The missed-offer cooldown is a preference, not a filter.** An agent who just let an
  offer lapse is deprioritised so one unattended console cannot absorb and expire the
  whole queue. It cannot be a hard exclusion: in a single-agent deployment that takes
  the queue dead for the entire cooldown after one miss, and a customer waiting on
  nobody is worse than an agent getting a second notification. For the same reason, once
  every available agent has been tried for a conversation the rotation resets rather
  than leaving it permanently unplaceable.
- **One offer per pump.** A burst of escalations must not flood every console at once;
  the next offer is issued when the current one resolves or lapses.
- **Offers address an agent room, not a socket.** An agent with a laptop and a phone open
  gets the offer on both, instead of it landing on whichever tab happened to connect
  last.

**The presence TTL is generous, not tight.** Browsers throttle timers in hidden tabs to
roughly one per minute, so a thirty second TTL makes an agent who simply switched tabs
flap offline and stop receiving work. The default is therefore ninety seconds, the
console beats every fifteen, re-asserts on `visibilitychange`, and the server refreshes
presence on *any* inbound frame rather than only an explicit heartbeat.

The reasoning is that the accept window, not the TTL, is what protects against a
genuinely dead agent: a stale-online agent costs one offer cycle before the router moves
on, whereas a flapping agent costs every conversation they should have taken. Tightening
the TTL optimises the cheap failure at the expense of the expensive one.

**Fan-out crosses two namespaces.** Rooms in socket.io are scoped to a namespace, so
broadcasting from the agent console reaches other agents and nobody else. Every
conversation has watchers in both namespaces, so all fan-out goes through a single
broadcaster that addresses both explicitly. That one seam is also where the Redis
adapter provides cross-pod delivery, and nothing else in the system fans out.

**Webhooks.** A generic `onEvent` webhook fires for `handoff.queued`,
`handoff.assigned`, `conversation.resolved`, and `queue.stalled`. Self-hosted teams
will want queued conversations to appear in Slack, and a generic webhook gets them
that without us building and maintaining a Slack integration.

---

## 9A. Deploys, reconnects, and the thundering herd

A deploy drops every open socket at once. Left alone, every client reconnects in
the same instant, against pods with cold caches, and a routine rolling deploy becomes a
self-inflicted denial of service. This is the failure mode a persistent-connection
system has that a request/response one does not, so it is designed for rather than
discovered.

### 9A.1 You drain, you do not kill

```
1. new pods become ready
2. load balancer stops routing new connections to the old pods
3. old pods send `server.draining { reconnectAfterMs, reason }` on every socket,
   with reconnectAfterMs drawn per connection from a spread window
4. clients close and wait out their own delay
5. old pods exit when connection count reaches zero, or the drain deadline passes
```

The server picking the delay, per client, is what turns a herd into a trickle. Across a
five second window, ten thousand clients reconnect at roughly two thousand per second
instead of ten thousand at once. The window is configurable and should be set from the
pod's own readiness time, not guessed.

`server.draining` is part of the protocol for both the widget and the agent console.

### 9A.2 The architecture already absorbs most of it

Because no session state lives in the socket process (section 3.2), a reconnect is not
a session rebuild. It is a `session.resume { conversationId, lastSeq }`, and in the
overwhelmingly common case the client is already current.

**That case must cost close to nothing.** The conversation's head sequence is kept in
the CacheStore, so when a resuming client is already current the server answers
`session.ready` with an empty message array and never touches the messages table.

To be precise about what this does and does not save: the conversation row is still
read, so a reconnect wave is one indexed primary-key lookup plus one cache read per
client. What it removes is the range scan over messages, which is the unbounded part
and the one that would actually take the database down. Only clients that genuinely
missed messages pay for that, and they are a small fraction of any wave.

### 9A.3 Full jitter, not fixed backoff

`reconnectDelay` uses full jitter: a delay drawn uniformly from
`[window/10, min(cap, base * 2^attempt)]`.

The reason for randomising rather than backing off on a fixed schedule is that the
failure here is *correlated*. Every socket dropped at the same moment, so any
deterministic delay reconnects them all at the same moment, which is the identical
stampede one step later. Randomising across the whole window is what actually spreads
load. The floor exists so a client can never busy-loop.

A server-supplied `reconnectAfterMs` is treated as the floor, with a small extra spread
on top as insurance against an unjittered server.

### 9A.4 Admission control

A drain is cooperative and a crash is not, so the resume path also defends itself:

- a per-pod cap on concurrent resume processing, with the excess queued rather than
  run, so a wave cannot exhaust the database connection pool
- `rate_limited` with a retry hint as the answer when the queue is saturated

Making five percent of clients wait two seconds is strictly better than making the
database unavailable to all of them.

### 9A.5 The widget must not look broken

During a drain the widget stays usable. Outbound messages are buffered locally, the
composer keeps working, the UI shows a reconnecting state rather than an error, and the
buffer flushes on reconnect. Because every send carries a `clientMessageId` that is
unique per conversation, a message sent twice across a reconnect is deduplicated
server-side rather than double-posted.

From the user's side, a deploy should look like a brief pause, not a failure.

### 9A.6 Agent presence needs explicit invalidation on drain

Presence is a heartbeat with a TTL (section 5.2), which is correct for crashes and
wrong for deploys. If a thirty second TTL survives a drain, then for thirty seconds the
router believes agents are online who are not connected. Offers go to nobody, each
accept window expires, and the router walks the whole roster before giving up.

So a **clean** disconnect clears the agent's presence key immediately; only an unclean
one falls back to TTL expiry. Agents re-register on reconnect, and conversations already
assigned are unaffected, since assignment lives in the database rather than in the
socket.

### 9A.7 Do not use sticky sessions

Sticky routing looks like the obvious answer and makes things worse: a pod restart
forces those clients elsewhere regardless, so it buys nothing during the exact event it
appears to address, while costing balance the rest of the time.

It is only required because socket.io's HTTP long-polling fallback needs a stable pod.
The gateway therefore runs `transports: ["websocket"]`, which removes the requirement
entirely. Sockets are stateless, any pod can serve any client,
and the CacheStore adapter handles cross-pod delivery.

---

## 10. Widget theming

Three tiers, ordered by escape-hatch depth. Each tier has a stable contract.

**Tier 1, design tokens.** Roughly twenty CSS custom properties: `--sc-color-primary`,
`--sc-color-surface`, `--sc-color-text`, `--sc-radius`, `--sc-font`, `--sc-shadow`,
spacing scale. Covers the large majority of customization requests.

**Tier 2, slots.** Render props for `launcher`, `header`, `messageBubble`, `composer`,
and `emptyState`. Covers structural changes without exposing internal markup.

**Tier 3, headless.**

```ts
const { messages, status, typing, send, requestHuman, uploadFile } = useSupportChat(opts)
```

All state and actions, no DOM. They build the entire UI.

Tiers 1 and 2 render inside **Shadow DOM**, so the host site's CSS cannot leak in and
break the widget, and the widget's styles cannot leak out. This is non-negotiable for
an embeddable widget; without it, every customer with an aggressive global stylesheet
files a bug.

### 10.0.1 The agent console

Same architecture as the widget, for the same reason: one headless
`AgentConsoleClient` holding all protocol logic, with React as a skin over it.

It ships structurally complete but visually unstyled, which is deliberate. It mounts
inside the customer's existing dashboard, so imposing a visual identity would fight
whatever design system is already there. Semantic elements and data attributes give them
something to style against.

Three behaviours worth naming:

- **Offers are cleared on disconnect.** They cannot be answered from a dead socket, and
  a stale card invites an agent to accept something that has already gone to somebody
  else.
- **An incoming assignment never steals focus.** It opens automatically only when
  nothing else is being worked on, so a new arrival cannot yank the view away from an
  agent mid-reply.
- **The token is fetched on every connect, not once.** Agent tokens are short-lived by
  design, so caching the first one leaves a console that dropped overnight unable to
  return without a page reload.

### 10.1 The client is the product, the UI is a skin

All protocol logic lives in one transport-agnostic `SupportChatClient`: the outbound
buffer, resume, reconnect scheduling, drain handling, streaming assembly,
deduplication. The custom element, the React component, and anything a customer writes
against the headless hook are all skins over that one object, so they cannot drift
apart in how they behave when a connection drops.

Three decisions in it are worth stating, because each fixes a bug that is otherwise
discovered in production:

- **`subscribe` delivers the current state immediately, not just future changes.** An
  event-only API makes it trivially easy to attach a listener after the thing being
  waited for already happened; with a fast reply the whole exchange can complete
  between a send and a later subscription. A snapshot on subscribe makes that mistake
  impossible to write, which matters because it was made twice while building this.
- **Reconnect backoff resets on a completed session, not on transport open.** A pod
  that accepts connections and dies before the handshake would otherwise reset the
  backoff on every cycle and be retried at full rate forever, which is the exact
  scenario the backoff exists for.
- **The composer stays usable while reconnecting.** Anything typed during a deploy is
  buffered and flushed on reconnect under its original `clientMessageId`, so the server
  deduplicates it. A disabled input during a rolling deploy is a worse experience than
  a brief "Reconnecting" line.

Message bodies render through `textContent`, never `innerHTML`. Bodies contain both
customer and agent input, and either one rendering as markup is a stored XSS on every
page the widget is embedded in.

---

## 11. Mobile

A WebView loading the same widget, plus a `postMessage` bridge:

- register push token
- open the native file picker, return a handle
- report unread count for the app badge
- handle the hardware back button
- notify the host of theme changes

No native UI. The bridge plus a WebView gets roughly ninety-five percent of the value
for a small fraction of the work, and, more importantly, the theming contract stays
identical across web and mobile. Two separate UI implementations would drift within
one release.

---

## 12. Encryption

Shipping the schema in v1 and the implementation in v1.1, so it is never a migration.

**Name it honestly.** If the server decrypts message bodies to feed the AI, this is
encryption at rest, not end-to-end. It protects against database dumps, backup leaks,
and DBA access. It does not protect against a compromised application server. Calling
it end-to-end in marketing copy would be false.

Design when implemented:

- Per-tenant data encryption key, wrapped by a master key from KMS or the environment.
- AES-256-GCM over `messages.body` only. Sender, timestamps, and status stay
  plaintext so listing and filtering still work.
- Per-tenant opt-in flag.

Two consequences that must be stated in the docs rather than discovered:

1. **Search breaks.** Encrypted bodies cannot be queried with SQL text search.
   Encrypted tenants either lose message search or accept a separate encrypted-search
   index. v1.1 ships with search disabled for encrypted tenants and says so plainly.
2. **Embeddings leak.** Embedding an encrypted conversation writes a
   semantically-reconstructable representation of the plaintext into the VectorStore.
   Encrypted tenants therefore do not get conversation-memory embeddings. Knowledge
   base embeddings are unaffected, since those documents are not secret.

---

## 13. Scope

**v1**

- `core`, `server`, `widget`, `agent-console`, `cli` (`dev`, `doctor`, `eval`)
- Adapters: Postgres, SQLite, memory cache, Redis cache, pgvector, memory vector,
  Anthropic chat, OpenAI-compatible chat, local ONNX embeddings, local FileStore
- Declared provider capabilities with one escalation implementation per tier
- Knowledge ingestion: push, local files, sitemap crawl, structure-aware chunking
- AI answering with hybrid retrieval over ingested docs, grounded refusal when empty
- Human handoff with presence, queue, least-loaded routing, accept timeouts
- Agent console (`dashboard`)
- Token and slot theming
- Host tool registration with read/act tiers and injected identity
- Outbox and webhooks
- Graceful drain, jittered reconnect, resume admission control
- `npx support-chat dev`: SQLite plus memory cache plus memory vector, zero services

**v1.1**

- Mongo adapter, Qdrant adapter, S3 adapter
- Encryption at rest
- Headless hook
- React Native package
- Message search
- Promoting resolved conversations into the knowledge base
- Diagnostic rule engine and verdict-carrying handoff

**v2, the differentiator**

AI **suggest mode**: when a human takes over, the AI keeps running and drafts replies
the agent can accept, edit, or ignore. The infrastructure is already built by then,
since it is the same completion path with a different destination.

Two reasons it is worth building second rather than first. It is where the perceived
value jumps, because it helps the agent rather than replacing them. And it produces
clean labeled data, every accept, edit, and rejection is a training signal, which is
the only path by which fine-tuning (section 3.1) ever becomes rational.

Deliberately out of scope: email and SMS channels, ticketing, SLAs and reporting,
CSAT surveys, canned responses, and a co-browsing feature. Each is a product on its
own, and a chat library that does all of them badly loses to a chat library that does
one thing well.

---

## 14. Open questions

1. **AI conversation memory.** Last N messages verbatim, a rolling summary plus the
   last few, or retrieval over the conversation's own history. Last N is simplest and
   fine for the typical support conversation length. Rolling summary costs an extra
   model call per turn. Retrieval over own history conflicts with the encryption
   decision in section 12. Leaning last N with a token budget, and revisiting only if
   real transcripts turn out to run long.

2. **Multi-tenancy in the default install.** The schema is multi-tenant throughout, but
   should the default config create a single implicit tenant so nobody has to think
   about it? Leaning yes, with an explicit opt-in to multi-tenant mode.

3. **Rate limiting.** Almost certainly needed at the widget edge, since the
   publishable key is public and every conversation costs money in model calls. Open
   question is whether it belongs in this library or is left to the host's own
   middleware. Leaning in-library with sane defaults, because a host who forgets it
   gets a surprise model bill.
