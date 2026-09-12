import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import {
  envelope,
  newFrameId,
  newTenantId,
  type Envelope,
} from "@gagandeep023/support-chat-core";
import { MemoryCacheStore } from "../adapters/memory-cache-store.js";
import { MemoryDataStore } from "../adapters/memory-data-store.js";
import { createSupportChat, type SupportChat } from "../index.js";
import { signAgentToken } from "../auth/jwt.js";
import { signUserIdentity } from "../auth/identity.js";
import type { Gateway } from "./gateway.js";

const SECRET = "test-tenant-secret";
const PUBLISHABLE = "pk_test_123";
const BASE = "/support-chat";

let http: HttpServer;
let chat: SupportChat;
let gateway: Gateway;
let data: MemoryDataStore;
let cache: MemoryCacheStore;
let port: number;
let tenantId: string;
const clients: ClientSocket[] = [];

type AnyFrame = Envelope<string, Record<string, unknown>>;

function widgetClient(auth: Record<string, unknown> = {}): ClientSocket {
  const socket = connect(`http://localhost:${port}${BASE}/widget`, {
    path: `${BASE}/socket.io`,
    transports: ["websocket"],
    auth: { publishableKey: PUBLISHABLE, ...auth },
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

function agentClient(auth: Record<string, unknown>): ClientSocket {
  const socket = connect(`http://localhost:${port}${BASE}/agent`, {
    path: `${BASE}/socket.io`,
    transports: ["websocket"],
    auth,
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

/** Resolve on the next frame of a given type. */
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

function send(socket: ClientSocket, type: string, payload: unknown): void {
  socket.emit("frame", envelope(type, payload, newFrameId()));
}

async function connected(socket: ClientSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

beforeEach(async () => {
  data = new MemoryDataStore();
  const tenant = data.seedTenant({
    id: newTenantId(),
    name: "Acme",
    publishableKey: PUBLISHABLE,
    settings: {},
    createdAt: new Date().toISOString(),
  });
  tenantId = tenant.id;

  cache = new MemoryCacheStore();
  chat = createSupportChat({
    data,
    cache,
    secretKey: SECRET,
    basePath: BASE,
    drain: { windowMs: 400, graceMs: 20 },
  });

  http = createServer();
  gateway = chat.attach(http);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await chat.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("widget connection", () => {
  it("rejects an unknown publishable key", async () => {
    const socket = connect(`http://localhost:${port}${BASE}/widget`, {
      path: `${BASE}/socket.io`,
      transports: ["websocket"],
      auth: { publishableKey: "pk_wrong" },
      reconnection: false,
    });
    clients.push(socket);
    await expect(connected(socket)).rejects.toThrow();
  });

  it("rejects an externalId presented without a signature", async () => {
    // The whole point of the signed identity: a bare user id from the browser
    // is an assertion, not a credential.
    const socket = widgetClient({ externalId: "user-42" });
    await expect(connected(socket)).rejects.toThrow();
  });

  it("rejects a signature belonging to a different user", async () => {
    const socket = widgetClient({
      externalId: "user-victim",
      userHash: signUserIdentity("user-attacker", SECRET),
    });
    await expect(connected(socket)).rejects.toThrow();
  });

  it("accepts a correctly signed identity", async () => {
    const socket = widgetClient({
      externalId: "user-42",
      userHash: signUserIdentity("user-42", SECRET),
    });
    await expect(connected(socket)).resolves.toBeUndefined();
  });

  it("allows anonymous visitors by default", async () => {
    await expect(connected(widgetClient())).resolves.toBeUndefined();
  });
});

describe("message flow", () => {
  it("starts a session, persists a message, and acks it", async () => {
    const socket = widgetClient();
    await connected(socket);

    send(socket, "session.start", {});
    const ready = await nextFrame(socket, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    send(socket, "message.send", {
      conversationId,
      clientMessageId: "c1",
      body: "my charging stopped",
    });
    const ack = await nextFrame(socket, "message.ack");
    expect(ack.payload.clientMessageId).toBe("c1");
    expect(ack.payload.seq).toBe(1);

    const stored = await data.listMessages(conversationId, { limit: 10 });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toBe("my charging stopped");
  });

  it("is idempotent on clientMessageId across a reconnect", async () => {
    const first = widgetClient();
    await connected(first);
    send(first, "session.start", {});
    const ready = await nextFrame(first, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    send(first, "message.send", { conversationId, clientMessageId: "c1", body: "hello" });
    const ack1 = await nextFrame(first, "message.ack");
    first.disconnect();

    // The widget buffers unacked sends and flushes on reconnect. If it flushed
    // one that did land, the user must not see their message twice.
    const second = widgetClient();
    await connected(second);
    send(second, "message.send", { conversationId, clientMessageId: "c1", body: "hello" });
    const ack2 = await nextFrame(second, "message.ack");

    expect(ack2.payload.messageId).toBe(ack1.payload.messageId);
    expect(await data.listMessages(conversationId, { limit: 10 })).toHaveLength(1);
  });

  it("replays only the gap on resume", async () => {
    const socket = widgetClient();
    await connected(socket);
    send(socket, "session.start", {});
    const ready = await nextFrame(socket, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    send(socket, "message.send", { conversationId, clientMessageId: "c1", body: "one" });
    await nextFrame(socket, "message.ack");
    send(socket, "message.send", { conversationId, clientMessageId: "c2", body: "two" });
    await nextFrame(socket, "message.ack");
    socket.disconnect();

    const resumed = widgetClient();
    await connected(resumed);
    send(resumed, "session.resume", { conversationId, lastSeq: 1 });
    const gap = await nextFrame(resumed, "session.ready");
    expect((gap.payload.messages as unknown[]).length).toBe(1);
    expect(gap.payload.resumed).toBe(true);
  });

  it("replays nothing when the client is already current", async () => {
    // The reconnect-storm fast path: a deploy drops every socket, and almost
    // every client comes back already up to date.
    const socket = widgetClient();
    await connected(socket);
    send(socket, "session.start", {});
    const ready = await nextFrame(socket, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;
    send(socket, "message.send", { conversationId, clientMessageId: "c1", body: "one" });
    await nextFrame(socket, "message.ack");
    socket.disconnect();

    const resumed = widgetClient();
    await connected(resumed);
    send(resumed, "session.resume", { conversationId, lastSeq: 1 });
    const frame = await nextFrame(resumed, "session.ready");
    expect(frame.payload.messages).toEqual([]);
  });

  it("answers a malformed frame with an error instead of dropping the connection", async () => {
    const socket = widgetClient();
    await connected(socket);
    socket.emit("frame", { v: 1, type: "message.send", id: "frm_x", ts: 1, payload: {} });
    const error = await nextFrame(socket, "error");
    expect(error.payload.code).toBe("malformed_frame");
    expect(error.payload.frameId).toBe("frm_x");
    expect(socket.connected).toBe(true);
  });

  it("reports an unsupported protocol version distinctly", async () => {
    const socket = widgetClient();
    await connected(socket);
    socket.emit("frame", { v: 99, type: "message.send", id: "frm_y", ts: 1, payload: {} });
    const error = await nextFrame(socket, "error");
    expect(error.payload.code).toBe("unsupported_protocol_version");
  });

  it("queues a conversation when the user asks for a human", async () => {
    const socket = widgetClient();
    await connected(socket);
    send(socket, "session.start", {});
    const ready = await nextFrame(socket, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    send(socket, "handoff.request", { conversationId, reason: "still broken" });
    const status = await nextFrame(socket, "conversation.status");
    expect(status.payload.status).toBe("queued");
    expect(status.payload.queuePosition).toBe(1);

    const events = await data.listEvents(conversationId);
    expect(events.map((e) => e.type)).toContain("escalation.triggered");
  });
});

describe("agent connection", () => {
  const token = () =>
    signAgentToken({ agentId: "ext-agent-1", tenantId, name: "Asha" }, SECRET);

  it("rejects a token signed by another secret", async () => {
    const socket = agentClient({
      tenantId,
      token: signAgentToken(
        { agentId: "a", tenantId, name: "Mallory" },
        "not-the-secret",
      ),
    });
    await expect(connected(socket)).rejects.toThrow();
  });

  it("rejects a token whose tenant does not match the connection", async () => {
    const socket = agentClient({
      tenantId,
      token: signAgentToken(
        { agentId: "a", tenantId: "ten_other", name: "Mallory" },
        SECRET,
      ),
    });
    await expect(connected(socket)).rejects.toThrow();
  });

  it("registers presence on hello and clears it on disconnect", async () => {
    const socket = agentClient({ tenantId, token: token() });
    await connected(socket);
    send(socket, "agent.hello", { skills: ["billing"] });
    const ready = await nextFrame(socket, "agent.ready");
    const agentId = (ready.payload.agent as { id: string }).id;
    expect(await cache.onlineAgents(tenantId)).toEqual([agentId]);

    socket.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // Cleared immediately rather than left to expire. During a deploy a stale
    // presence key makes the router offer conversations to agents who are not
    // connected, so every accept window expires in turn before anything queues.
    expect(await cache.onlineAgents(tenantId)).toEqual([]);
  });

  it("keeps one agent record across reconnects", async () => {
    // Re-upserting on the internal id instead of the host's user id silently
    // creates a second agent whose id matches no assignment.
    const first = agentClient({ tenantId, token: token() });
    await connected(first);
    send(first, "agent.hello", {});
    const a = await nextFrame(first, "agent.ready");
    first.disconnect();

    const second = agentClient({ tenantId, token: token() });
    await connected(second);
    send(second, "agent.hello", {});
    const b = await nextFrame(second, "agent.ready");

    expect((b.payload.agent as { id: string }).id).toBe(
      (a.payload.agent as { id: string }).id,
    );
  });

  it("delivers an agent reply to the widget across namespaces", async () => {
    const widget = widgetClient();
    await connected(widget);
    send(widget, "session.start", {});
    const ready = await nextFrame(widget, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    const agent = agentClient({ tenantId, token: token() });
    await connected(agent);
    send(agent, "agent.hello", {});
    const agentReady = await nextFrame(agent, "agent.ready");
    const agentId = (agentReady.payload.agent as { id: string }).id;

    await data.assignConversation(conversationId, agentId);
    await data.setConversationStatus(conversationId, "assigned");
    send(agent, "agent.conversation.subscribe", { conversationId });
    await nextFrame(agent, "agent.conversation.assigned");

    send(agent, "agent.message.send", {
      conversationId,
      clientMessageId: "a1",
      body: "Looking into it now.",
    });

    // Rooms are namespace-scoped in socket.io, so this only works because the
    // broadcaster addresses both namespaces explicitly.
    const delivered = await nextFrame(widget, "message.new");
    expect((delivered.payload.message as { body: string }).body).toBe(
      "Looking into it now.",
    );
  });
});

describe("drain", () => {
  it("tells every client when to come back, then closes", async () => {
    const a = widgetClient();
    const b = widgetClient();
    await Promise.all([connected(a), connected(b)]);

    const notices = Promise.all([
      nextFrame(a, "server.draining"),
      nextFrame(b, "server.draining"),
    ]);
    const closed = gateway.drain("deploy");
    const [first, second] = await notices;

    for (const frame of [first, second]) {
      expect(frame.payload.reason).toBe("deploy");
      expect(frame.payload.reconnectAfterMs).toBeGreaterThanOrEqual(0);
      expect(frame.payload.reconnectAfterMs).toBeLessThanOrEqual(400);
    }
    expect(await closed).toBe(2);
  });
});
