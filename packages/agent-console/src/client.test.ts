import { beforeEach, describe, expect, it } from "vitest";
import {
  envelope,
  newFrameId,
  type AgentRecord,
  type Conversation,
  type Message,
} from "@gagandeep023/support-chat-core";
import { AgentConsoleClient } from "./client.js";
import type { Transport, TransportFactory, TransportHandlers } from "./transport.js";

class FakeTransport implements Transport {
  connected = false;
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  constructor(private readonly handlers: TransportHandlers) {}
  connect(): void {
    this.connected = true;
    this.handlers.onOpen();
  }
  send(frame: unknown): void {
    const f = frame as { type: string; payload: Record<string, unknown> };
    this.sent.push({ type: f.type, payload: f.payload });
  }
  close(): void {
    this.connected = false;
  }
  drop(): void {
    this.connected = false;
    this.handlers.onClose("transport close");
  }
  receive(type: string, payload: unknown): void {
    this.handlers.onFrame(envelope(type, payload, newFrameId()));
  }
}

class Harness {
  readonly transports: FakeTransport[] = [];
  readonly timers: Array<{ handler: () => void; ms: number }> = [];
  readonly intervals: Array<{ handler: () => void; ms: number }> = [];

  factory: TransportFactory = (handlers) => {
    const transport = new FakeTransport(handlers);
    this.transports.push(transport);
    return transport;
  };

  get current(): FakeTransport {
    const last = this.transports.at(-1);
    if (!last) throw new Error("no transport");
    return last;
  }

  runTimers(): void {
    for (const timer of this.timers.splice(0)) timer.handler();
  }
  tickHeartbeats(): void {
    for (const interval of this.intervals) interval.handler();
  }

  build(): AgentConsoleClient {
    return new AgentConsoleClient({
      transport: this.factory,
      now: () => 1_700_000_000_000,
      random: () => 0.5,
      setTimeout: (handler, ms) => {
        this.timers.push({ handler, ms });
        return this.timers.length;
      },
      clearTimeout: () => undefined,
      setInterval: (handler, ms) => {
        this.intervals.push({ handler, ms });
        return this.intervals.length;
      },
      clearInterval: () => undefined,
    });
  }
}

const agent: AgentRecord = {
  id: "agt_1",
  tenantId: "ten_1",
  externalId: "u1",
  displayName: "Asha",
  avatarUrl: null,
  skills: [],
  maxConcurrent: 3,
  role: "agent",
  createdAt: new Date(1_700_000_000_000).toISOString(),
};

const conversation = (id = "cnv_1"): Conversation => ({
  id,
  tenantId: "ten_1",
  endUserId: "usr_1",
  status: "assigned",
  assignedAgentId: "agt_1",
  channel: "web",
  subject: null,
  tags: [],
  lastSeq: 2,
  lastMessageAt: null,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  resolvedAt: null,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "msg_1",
  conversationId: "cnv_1",
  tenantId: "ten_1",
  seq: 1,
  senderType: "user",
  senderId: "usr_1",
  body: "my charger stopped",
  bodyEncrypted: null,
  contentType: "text/plain",
  clientMessageId: null,
  metadata: {},
  createdAt: new Date(1_700_000_000_000).toISOString(),
  ...overrides,
});

const offerPayload = (overrides: Record<string, unknown> = {}) => ({
  conversationId: "cnv_1",
  summary: "Charged twice",
  urgency: "high",
  diagnosis: null,
  waitingSince: new Date(1_700_000_000_000).toISOString(),
  expiresAt: new Date(1_700_000_020_000).toISOString(),
  ...overrides,
});

let harness: Harness;
let client: AgentConsoleClient;

function ready(): void {
  client.connect();
  harness.current.receive("agent.ready", { agent, assigned: [], queueDepth: 0 });
}

beforeEach(() => {
  harness = new Harness();
  client = harness.build();
});

describe("connecting", () => {
  it("announces itself and starts heartbeating", () => {
    ready();
    expect(harness.current.sent[0]?.type).toBe("agent.hello");
    expect(client.getState().agent?.displayName).toBe("Asha");

    harness.tickHeartbeats();
    expect(harness.current.sent.some((f) => f.type === "agent.heartbeat")).toBe(true);
  });

  it("heartbeats well inside the server's presence window", () => {
    ready();
    // Presence TTL defaults to 90s server-side; a 15s beat tolerates the timer
    // throttling browsers apply to background tabs.
    expect(harness.intervals[0]?.ms).toBeLessThanOrEqual(30_000);
  });

  it("drops presence explicitly when the console closes", () => {
    ready();
    client.close();
    const last = harness.current.sent.at(-1);
    // Leaving presence to expire means the router keeps offering conversations
    // to a console that deliberately went away.
    expect(last).toMatchObject({ type: "agent.heartbeat", payload: { status: "offline" } });
  });

  it("delivers current state to a component that mounts mid-session", () => {
    ready();
    const seen: string[] = [];
    client.subscribe((state) => seen.push(state.connection));
    expect(seen).toEqual(["open"]);
  });
});

describe("offers", () => {
  it("surfaces an offer with its deadline and diagnosis", () => {
    ready();
    harness.current.receive("agent.offer", offerPayload({
      diagnosis: {
        code: "STOPPED_EV_DISCONNECTED",
        confidence: "certain",
        summary: "Cable unplugged at the vehicle",
        evidence: [{ label: "Stop reason", value: "EVDisconnected" }],
        resolution: "self_serve",
      },
    }));

    const offer = client.getState().offers[0];
    expect(offer?.summary).toBe("Charged twice");
    expect(offer?.diagnosis?.code).toBe("STOPPED_EV_DISCONNECTED");
    expect(offer?.expiresAt).toBeTruthy();
  });

  it("marks an offer as responding so it cannot be double-clicked", () => {
    ready();
    harness.current.receive("agent.offer", offerPayload());
    client.respond("cnv_1", true);
    expect(client.getState().offers[0]?.responding).toBe("accept");
  });

  it("clears an offer taken by someone else, and says so", () => {
    ready();
    harness.current.receive("agent.offer", offerPayload());
    client.respond("cnv_1", true);
    harness.current.receive("agent.offer.revoked", {
      conversationId: "cnv_1",
      reason: "taken",
    });

    expect(client.getState().offers).toHaveLength(0);
    expect(client.getState().error).toMatch(/taken/i);
  });

  it("clears offers on disconnect rather than leaving dead cards", () => {
    // Answering from a dead socket does nothing, and a stale card invites an
    // agent to accept something that has already moved on.
    ready();
    harness.current.receive("agent.offer", offerPayload());
    harness.current.drop();
    expect(client.getState().offers).toHaveLength(0);
    expect(client.getState().connection).toBe("reconnecting");
  });

  it("replaces rather than duplicates a re-offered conversation", () => {
    ready();
    harness.current.receive("agent.offer", offerPayload());
    harness.current.receive("agent.offer", offerPayload({ summary: "Updated" }));
    expect(client.getState().offers).toHaveLength(1);
    expect(client.getState().offers[0]?.summary).toBe("Updated");
  });
});

describe("assignment", () => {
  it("opens with the full transcript the bot produced", () => {
    ready();
    harness.current.receive("agent.offer", offerPayload());
    harness.current.receive("agent.conversation.assigned", {
      conversation: conversation(),
      messages: [message(), message({ id: "msg_2", senderType: "ai", body: "Have you tried..." })],
      diagnosis: null,
    });

    const entry = client.getState().conversations[0];
    expect(entry?.messages).toHaveLength(2);
    expect(client.getState().offers).toHaveLength(0);
    expect(client.getState().activeConversationId).toBe("cnv_1");
  });

  it("does not steal focus from a conversation already being worked on", () => {
    ready();
    harness.current.receive("agent.conversation.assigned", {
      conversation: conversation("cnv_first"),
      messages: [],
      diagnosis: null,
    });
    harness.current.receive("agent.conversation.assigned", {
      conversation: conversation("cnv_second"),
      messages: [],
      diagnosis: null,
    });
    expect(client.getState().activeConversationId).toBe("cnv_first");
  });

  it("appends live messages to the right conversation without duplicating", () => {
    ready();
    harness.current.receive("agent.conversation.assigned", {
      conversation: conversation(),
      messages: [],
      diagnosis: null,
    });
    harness.current.receive("message.new", { message: message({ id: "msg_9" }) });
    harness.current.receive("message.new", { message: message({ id: "msg_9" }) });
    expect(client.getState().conversations[0]?.messages).toHaveLength(1);
  });

  it("removes a conversation on resolve and clears the selection", () => {
    ready();
    harness.current.receive("agent.conversation.assigned", {
      conversation: conversation(),
      messages: [],
      diagnosis: null,
    });
    client.resolve("cnv_1", { promoteToKnowledge: true });

    expect(client.getState().conversations).toHaveLength(0);
    expect(client.getState().activeConversationId).toBeNull();
    const sent = harness.current.sent.at(-1);
    expect(sent?.type).toBe("agent.conversation.resolve");
    expect(sent?.payload.promoteToKnowledge).toBe(true);
  });

  it("omits promoteToKnowledge unless it was asked for", () => {
    ready();
    client.resolve("cnv_1");
    expect(harness.current.sent.at(-1)?.payload.promoteToKnowledge).toBeUndefined();
  });
});

describe("reconnect", () => {
  it("honours a drain delay from the server", () => {
    ready();
    harness.current.receive("server.draining", { reconnectAfterMs: 3000, reason: "deploy" });
    expect(client.getState().connection).toBe("reconnecting");
    expect(harness.timers.at(-1)?.ms).toBeGreaterThanOrEqual(3000);
  });

  it("keeps backing off until a session actually completes", () => {
    client.connect();
    harness.current.drop();
    const first = harness.timers.at(-1)?.ms ?? 0;
    harness.runTimers();
    harness.current.drop();
    expect(harness.timers.at(-1)?.ms ?? 0).toBeGreaterThan(first);
  });
});
