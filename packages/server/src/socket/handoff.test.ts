import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { envelope, newFrameId, newTenantId, type Envelope } from "@gagandeep023/support-chat-core";
import { MemoryCacheStore } from "../adapters/memory-cache-store.js";
import { MemoryDataStore } from "../adapters/memory-data-store.js";
import { createSupportChat, type SupportChat } from "../index.js";
import { signAgentToken } from "../auth/jwt.js";

const SECRET = "handoff-secret";
const PUBLISHABLE = "pk_handoff";
const BASE = "/support-chat";

let http: HttpServer;
let chat: SupportChat;
let data: MemoryDataStore;
let port: number;
let tenantId: string;
const clients: ClientSocket[] = [];

type AnyFrame = Envelope<string, Record<string, unknown>>;

function widget(): ClientSocket {
  const socket = connect(`http://localhost:${port}${BASE}/widget`, {
    path: `${BASE}/socket.io`,
    transports: ["websocket"],
    auth: { publishableKey: PUBLISHABLE },
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

function agent(externalId: string): ClientSocket {
  const socket = connect(`http://localhost:${port}${BASE}/agent`, {
    path: `${BASE}/socket.io`,
    transports: ["websocket"],
    auth: {
      tenantId,
      token: signAgentToken({ agentId: externalId, tenantId, name: externalId }, SECRET),
    },
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

  chat = createSupportChat({
    data,
    cache: new MemoryCacheStore(),
    secretKey: SECRET,
    basePath: BASE,
    routing: { acceptWindowMs: 500, missCooldownMs: 200 },
  });

  http = createServer();
  chat.attach(http);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await chat.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("handoff end to end", () => {
  it("routes a queued conversation to an agent and assigns it on accept", async () => {
    const asha = agent("asha");
    await connected(asha);
    send(asha, "agent.hello", {});
    await nextFrame(asha, "agent.ready");

    const customer = widget();
    await connected(customer);
    send(customer, "session.start", {});
    const ready = await nextFrame(customer, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    send(customer, "message.send", {
      conversationId,
      clientMessageId: "c1",
      body: "my charger stopped mid-session",
    });
    await nextFrame(customer, "message.ack");

    // Collected from before the request, not awaited after it: the queued status
    // is emitted synchronously with the handoff and a later listener misses it.
    const statuses = collect(customer, "conversation.status");
    const offered = nextFrame(asha, "agent.offer");
    send(customer, "handoff.request", { conversationId, reason: "needs a person" });
    const offer = await offered;
    expect(offer.payload.conversationId).toBe(conversationId);
    expect(typeof offer.payload.expiresAt).toBe("string");

    const assigned = nextFrame(asha, "agent.conversation.assigned");
    send(asha, "agent.offer.respond", { conversationId, accept: true });

    const assignment = await assigned;
    // The agent opens holding the whole transcript, rather than asking the
    // customer to repeat what they already typed.
    expect((assignment.payload.messages as unknown[]).length).toBeGreaterThan(0);
    expect((assignment.payload.conversation as { status: string }).status).toBe("assigned");

    // The customer sees the whole journey: queued while waiting, then assigned.
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses.map((f) => f.payload.status)).toEqual(["queued", "assigned"]);

    const stored = await data.getConversation(tenantId, conversationId);
    expect(stored?.status).toBe("assigned");
  });

  it("reoffers to a second agent when the first lets the window lapse", async () => {
    const first = agent("first");
    await connected(first);
    send(first, "agent.hello", {});
    await nextFrame(first, "agent.ready");

    const second = agent("second");
    await connected(second);
    send(second, "agent.hello", {});
    await nextFrame(second, "agent.ready");

    const customer = widget();
    await connected(customer);
    send(customer, "session.start", {});
    const ready = await nextFrame(customer, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    const firstOffer = nextFrame(first, "agent.offer");
    const secondOffer = nextFrame(second, "agent.offer");
    send(customer, "handoff.request", { conversationId });

    // Whichever is picked, the other must get it once the window lapses.
    const winner = await Promise.race([
      firstOffer.then(() => "first" as const),
      secondOffer.then(() => "second" as const),
    ]);
    const loser = winner === "first" ? secondOffer : firstOffer;
    const revoked = nextFrame(winner === "first" ? first : second, "agent.offer.revoked");

    await expect(loser).resolves.toBeDefined();
    expect((await revoked).payload.reason).toBe("expired");
  });

  it("delivers offers to every console the agent has open", async () => {
    const laptop = agent("asha");
    const phone = agent("asha");
    await Promise.all([connected(laptop), connected(phone)]);
    send(laptop, "agent.hello", {});
    await nextFrame(laptop, "agent.ready");

    const customer = widget();
    await connected(customer);
    send(customer, "session.start", {});
    const ready = await nextFrame(customer, "session.ready");
    const conversationId = (ready.payload.conversation as { id: string }).id;

    // Room per agent, not per socket: an offer must not be lost to whichever tab
    // happens to hold the newest connection.
    const onLaptop = nextFrame(laptop, "agent.offer");
    const onPhone = nextFrame(phone, "agent.offer");
    send(customer, "handoff.request", { conversationId });

    await expect(Promise.all([onLaptop, onPhone])).resolves.toHaveLength(2);
  });
});
