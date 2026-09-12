import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { envelope, newFrameId, newTenantId, type Envelope } from "@gagandeep023/support-chat-core";
import { MemoryDataStore } from "./memory-data-store.js";
import { RedisCacheStore } from "./redis-cache-store.js";
import { createSupportChat, signAgentToken, type SupportChat } from "../index.js";

const url = process.env.SUPPORT_CHAT_TEST_REDIS_URL ?? "";
const suite = url ? describe : describe.skip;
const SECRET = "multipod-secret";
const PK = "pk_multipod";
const BASE = "/support-chat";
type AnyFrame = Envelope<string, Record<string, unknown>>;

/**
 * Two servers sharing one database and one Redis, which is what two pods behind a
 * load balancer are. The customer's socket lands on one and the agent's on the
 * other, which is the ordinary case with any real load balancer.
 */
suite("two pods", () => {
  const clients: ClientSocket[] = [];
  let data: MemoryDataStore;
  let podA: { chat: SupportChat; http: HttpServer; port: number };
  let podB: { chat: SupportChat; http: HttpServer; port: number };
  let tenantId: string;
  const prefix = `sc-mp-${Math.random().toString(36).slice(2, 10)}`;

  async function startPod() {
    const chat = createSupportChat({
      data,
      cache: new RedisCacheStore({ url, prefix }),
      secretKey: SECRET,
      basePath: BASE,
      socketAdapter: { type: "redis", url },
    });
    const http = createServer();
    chat.attach(http);
    await new Promise<void>((r) => http.listen(0, r));
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { chat, http, port: address.port };
  }

  function frameWaiter(socket: ClientSocket, type: string, timeoutMs = 4000) {
    return new Promise<AnyFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${type}`)), timeoutMs);
      socket.on("frame", (f: AnyFrame) => {
        if (f.type !== type) return;
        clearTimeout(timer);
        resolve(f);
      });
    });
  }
  const send = (s: ClientSocket, type: string, payload: unknown) =>
    s.emit("frame", envelope(type, payload, newFrameId()));
  const connected = (s: ClientSocket) =>
    new Promise<void>((res, rej) => {
      s.once("connect", res);
      s.once("connect_error", rej);
    });

  beforeEach(async () => {
    data = new MemoryDataStore();
    tenantId = newTenantId();
    data.seedTenant({
      id: tenantId, name: "Acme", publishableKey: PK, settings: {},
      createdAt: new Date().toISOString(),
    });
    podA = await startPod();
    podB = await startPod();
    await new Promise((r) => setTimeout(r, 300));
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    await podA.chat.close();
    await podB.chat.close();
    await new Promise<void>((r) => podA.http.close(() => r()));
    await new Promise<void>((r) => podB.http.close(() => r()));
  });

  it("carries an agent's reply from one pod to a customer on the other", async () => {
    const customer = connect(`http://localhost:${podA.port}${BASE}/widget`, {
      path: `${BASE}/socket.io`, transports: ["websocket"],
      auth: { publishableKey: PK }, reconnection: false,
    });
    clients.push(customer);
    await connected(customer);
    send(customer, "session.start", {});
    const ready = await frameWaiter(customer, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    const agent = connect(`http://localhost:${podB.port}${BASE}/agent`, {
      path: `${BASE}/socket.io`, transports: ["websocket"],
      auth: {
        tenantId,
        token: signAgentToken({ agentId: "ext-1", tenantId, name: "Asha" }, SECRET),
      },
      reconnection: false,
    });
    clients.push(agent);
    await connected(agent);
    send(agent, "agent.hello", {});
    const agentReady = await frameWaiter(agent, "agent.ready");
    const agentId = (agentReady.payload.agent as { id: string }).id;

    await data.assignConversation(conversationId, agentId);
    await data.setConversationStatus(conversationId, "assigned");
    send(agent, "agent.conversation.subscribe", { conversationId });
    await frameWaiter(agent, "agent.conversation.assigned");

    // Without the socket.io Redis adapter this never arrives, and nothing errors.
    const delivered = frameWaiter(customer, "message.new");
    send(agent, "agent.message.send", {
      conversationId, clientMessageId: "a1", body: "On it, checking your session now.",
    });
    expect((((await delivered).payload.message) as { body: string }).body).toBe(
      "On it, checking your session now.",
    );
  });
});
