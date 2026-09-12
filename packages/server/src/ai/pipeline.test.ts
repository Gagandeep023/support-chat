import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { envelope, newFrameId, newTenantId, type Envelope } from "@gagandeep023/support-chat-core";
import { MemoryCacheStore } from "../adapters/memory-cache-store.js";
import { MemoryDataStore } from "../adapters/memory-data-store.js";
import { FakeChatProvider } from "../providers/fake-chat-provider.js";
import { createSupportChat, type SupportChat } from "../index.js";

const PUBLISHABLE = "pk_test_ai";
const BASE = "/support-chat";

let http: HttpServer;
let chat: SupportChat;
let data: MemoryDataStore;
let provider: FakeChatProvider;
let port: number;
let tenantId: string;
const clients: ClientSocket[] = [];

type AnyFrame = Envelope<string, Record<string, unknown>>;

const DOC = `# Charging help

## Session stops early

Error code E4021 means the cable was unplugged at the vehicle end. Plug it back in and
start a new session.
`;

function client(): ClientSocket {
  const socket = connect(`http://localhost:${port}${BASE}/widget`, {
    path: `${BASE}/socket.io`,
    transports: ["websocket"],
    auth: { publishableKey: PUBLISHABLE },
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

function send(socket: ClientSocket, type: string, payload: unknown): void {
  socket.emit("frame", envelope(type, payload, newFrameId()));
}

function nextFrame(socket: ClientSocket, type: string, timeoutMs = 2000): Promise<AnyFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("frame", onFrame);
      reject(new Error(`Timed out waiting for "${type}"`));
    }, timeoutMs);
    function onFrame(frame: AnyFrame) {
      if (frame.type !== type) return;
      clearTimeout(timer);
      socket.off("frame", onFrame);
      resolve(frame);
    }
    socket.on("frame", onFrame);
  });
}

function collect(socket: ClientSocket, type: string): AnyFrame[] {
  const frames: AnyFrame[] = [];
  socket.on("frame", (frame: AnyFrame) => {
    if (frame.type === type) frames.push(frame);
  });
  return frames;
}

async function connected(socket: ClientSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

async function startConversation(socket: ClientSocket): Promise<string> {
  send(socket, "session.start", {});
  const ready = await nextFrame(socket, "session.ready");
  return (ready.payload.conversation as { id: string }).id;
}

async function boot(script: ConstructorParameters<typeof FakeChatProvider>[0]) {
  data = new MemoryDataStore();
  const tenant = data.seedTenant({
    id: newTenantId(),
    name: "Acme",
    publishableKey: PUBLISHABLE,
    settings: {},
    createdAt: new Date().toISOString(),
  });
  tenantId = tenant.id;
  provider = new FakeChatProvider(script);

  chat = createSupportChat({
    data,
    cache: new MemoryCacheStore(),
    secretKey: "secret",
    basePath: BASE,
    ai: { chat: provider },
  });
  await chat.ingest(tenantId, { id: "doc-charging", title: "Charging help", content: DOC });

  http = createServer();
  chat.attach(http);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await chat.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("ai pipeline", () => {
  beforeEach(async () => {
    await boot([
      { reply: "That error means the cable came loose. Plug it back in." },
      { reply: '{"escalate": false, "reason": "answered"}' },
    ]);
  });

  it("streams an answer and persists it", async () => {
    const socket = client();
    await connected(socket);
    const conversationId = await startConversation(socket);
    const deltas = collect(socket, "message.delta");
    // Registered before the send. The pipeline can complete between the ack
    // resolving and a later listener attaching, so a client that subscribes
    // after awaiting the ack can miss the reply entirely.
    const completed = nextFrame(socket, "message.new");

    send(socket, "message.send", {
      conversationId,
      clientMessageId: "c1",
      body: "I got error E4021, what does it mean?",
    });
    await nextFrame(socket, "message.ack");
    const complete = await completed;

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.payload.text).join("")).toBe(
      "That error means the cable came loose. Plug it back in.",
    );
    const message = complete.payload.message as { senderType: string; body: string };
    expect(message.senderType).toBe("ai");

    const stored = await data.listMessages(conversationId, { limit: 10 });
    expect(stored.map((m) => m.senderType)).toEqual(["user", "ai"]);
  });

  it("retrieves the matching chunk and keeps it out of the system prompt", async () => {
    const socket = client();
    await connected(socket);
    const conversationId = await startConversation(socket);
    send(socket, "message.send", {
      conversationId,
      clientMessageId: "c1",
      body: "error E4021 help",
    });
    await nextFrame(socket, "message.new");

    const answerRequest = provider.requests[0];
    expect(answerRequest?.context.length).toBeGreaterThan(0);
    expect(answerRequest?.context[0]?.text).toContain("E4021");
    expect(answerRequest?.system).not.toContain("E4021");
  });

  it("stays silent once a human owns the conversation", async () => {
    const socket = client();
    await connected(socket);
    const conversationId = await startConversation(socket);
    await data.setConversationStatus(conversationId, "assigned");

    send(socket, "message.send", { conversationId, clientMessageId: "c1", body: "hello?" });
    await nextFrame(socket, "message.ack");
    await new Promise((r) => setTimeout(r, 150));

    // Talking over the agent is worse than saying nothing.
    expect(provider.requests).toHaveLength(0);
    const stored = await data.listMessages(conversationId, { limit: 10 });
    expect(stored.map((m) => m.senderType)).toEqual(["user"]);
  });
});

describe("ai pipeline escalation", () => {
  it("queues for a human when the classifier says so", async () => {
    await boot([
      { reply: "I am sorry about the double charge." },
      {
        reply:
          '{"escalate": true, "reason": "billing dispute", "summary": "Charged twice", "urgency": "high"}',
      },
    ]);
    const socket = client();
    await connected(socket);
    const conversationId = await startConversation(socket);

    send(socket, "message.send", {
      conversationId,
      clientMessageId: "c1",
      body: "you charged me twice for one session",
    });
    const status = await nextFrame(socket, "conversation.status");
    expect(status.payload.status).toBe("queued");

    const events = await data.listEvents(conversationId);
    expect(events.map((e) => e.type)).toContain("escalation.triggered");
    expect(events.map((e) => e.type)).toContain("handoff.queued");
  });

  it("escalates rather than going silent when the provider fails", async () => {
    await boot([{ reply: "", fail: true }]);
    const socket = client();
    await connected(socket);
    const conversationId = await startConversation(socket);

    send(socket, "message.send", { conversationId, clientMessageId: "c1", body: "help" });
    const status = await nextFrame(socket, "conversation.status");
    expect(status.payload.status).toBe("queued");

    // The user still gets told something, rather than watching a dead widget.
    const stored = await data.listMessages(conversationId, { limit: 10 });
    expect(stored.at(-1)?.senderType).toBe("ai");
    expect(stored.at(-1)?.body).toMatch(/colleague/i);
  });
});

describe("streaming identity", () => {
  it("persists the reply under the id the deltas were streamed with", async () => {
    // Otherwise the client gets deltas for one id and a finished message with
    // another, and cannot tell they are the same reply: the streamed bubble
    // never resolves and a duplicate appears beneath it.
    await boot([{ reply: "Plug the cable back in." }, { reply: '{"escalate": false}' }]);
    const socket = client();
    await connected(socket);
    const conversationId = await startConversation(socket);

    const deltas = collect(socket, "message.delta");
    const completed = nextFrame(socket, "message.new");
    send(socket, "message.send", { conversationId, clientMessageId: "c1", body: "E4021" });
    const final = await completed;

    const streamedId = deltas[0]?.payload.messageId;
    expect(streamedId).toBeTruthy();
    expect((final.payload.message as { id: string }).id).toBe(streamedId);
  });
});
