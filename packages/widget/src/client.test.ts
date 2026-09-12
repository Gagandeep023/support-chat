import { beforeEach, describe, expect, it } from "vitest";
import {
  envelope,
  newFrameId,
  type Conversation,
  type Message,
} from "@gagandeep023/support-chat-core";
import { SupportChatClient, type WidgetState } from "./client.js";
import type { Transport, TransportFactory, TransportHandlers } from "./transport.js";

class FakeTransport implements Transport {
  connected = false;
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  closeCount = 0;

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
    this.closeCount += 1;
    this.connected = false;
  }
  /** Simulate the socket dropping without the client asking. */
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
  readonly store = new Map<string, string>();

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
    const pending = this.timers.splice(0);
    for (const timer of pending) timer.handler();
  }

  build(overrides: Partial<ConstructorParameters<typeof SupportChatClient>[0]> = {}) {
    return new SupportChatClient({
      transport: this.factory,
      now: () => 1_700_000_000_000,
      random: () => 0.5,
      setTimeout: (handler, ms) => {
        this.timers.push({ handler, ms });
        return this.timers.length;
      },
      clearTimeout: () => undefined,
      storage: {
        getItem: (key) => this.store.get(key) ?? null,
        setItem: (key, value) => void this.store.set(key, value),
        removeItem: (key) => void this.store.delete(key),
      },
      ...overrides,
    });
  }
}

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: "cnv_1",
  tenantId: "ten_1",
  endUserId: "usr_1",
  status: "ai",
  assignedAgentId: null,
  channel: "web",
  subject: null,
  tags: [],
  lastSeq: 0,
  lastMessageAt: null,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  resolvedAt: null,
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "msg_1",
  conversationId: "cnv_1",
  tenantId: "ten_1",
  seq: 1,
  senderType: "ai",
  senderId: null,
  body: "hello",
  bodyEncrypted: null,
  contentType: "text/plain",
  clientMessageId: null,
  metadata: {},
  createdAt: new Date(1_700_000_000_000).toISOString(),
  ...overrides,
});

let harness: Harness;
let client: SupportChatClient;

function open(): void {
  client.connect();
  harness.current.receive("session.ready", {
    conversation: conversation(),
    messages: [],
    agent: null,
    resumed: false,
  });
}

beforeEach(() => {
  harness = new Harness();
  client = harness.build();
});

describe("subscription", () => {
  it("delivers the current state immediately, not only future changes", () => {
    // An event-only API makes it trivial to attach a listener after the thing
    // you were waiting for already happened. With a fast reply the whole
    // exchange can finish between a send and a later subscription.
    open();
    const seen: WidgetState[] = [];
    client.subscribe((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.conversationId).toBe("cnv_1");
  });
});

describe("sending", () => {
  it("shows the message immediately as pending, then marks it sent on ack", () => {
    open();
    client.send("hello there");
    expect(client.getState().messages[0]).toMatchObject({
      body: "hello there",
      role: "user",
      state: "pending",
    });

    const sent = harness.current.sent.find((f) => f.type === "message.send");
    harness.current.receive("message.ack", {
      clientMessageId: sent?.payload.clientMessageId,
      messageId: "msg_real",
      seq: 1,
    });

    expect(client.getState().messages[0]).toMatchObject({ id: "msg_real", state: "sent" });
  });

  it("ignores an empty message", () => {
    open();
    client.send("   ");
    expect(client.getState().messages).toHaveLength(0);
  });
});

describe("reconnect", () => {
  it("resends an unacked message under its original id", () => {
    // The server deduplicates on clientMessageId, so reusing it is what makes
    // the flush safe. A fresh id would post the message twice.
    open();
    client.send("did this land?");
    const original = harness.current.sent.find((f) => f.type === "message.send")?.payload
      .clientMessageId;

    harness.current.drop();
    harness.runTimers();
    harness.current.receive("session.ready", {
      conversation: conversation(),
      messages: [],
      agent: null,
      resumed: true,
    });

    const resent = harness.current.sent.find((f) => f.type === "message.send");
    expect(resent?.payload.clientMessageId).toBe(original);
    expect(resent?.payload.body).toBe("did this land?");
  });

  it("does not resend a message that was acked before the drop", () => {
    open();
    client.send("landed");
    const id = harness.current.sent.find((f) => f.type === "message.send")?.payload
      .clientMessageId;
    harness.current.receive("message.ack", {
      clientMessageId: id,
      messageId: "msg_real",
      seq: 1,
    });

    harness.current.drop();
    harness.runTimers();
    harness.current.receive("session.ready", {
      conversation: conversation({ lastSeq: 1 }),
      messages: [],
      agent: null,
      resumed: true,
    });

    expect(harness.current.sent.filter((f) => f.type === "message.send")).toHaveLength(0);
  });

  it("resumes the stored conversation from the last seq it rendered", () => {
    open();
    harness.current.receive("message.new", { message: message({ seq: 4 }) });
    harness.current.drop();
    harness.runTimers();

    const resume = harness.current.sent.find((f) => f.type === "session.resume");
    expect(resume?.payload).toEqual({ conversationId: "cnv_1", lastSeq: 4 });
  });

  it("stays usable while reconnecting", () => {
    open();
    harness.current.drop();
    expect(client.getState().connection).toBe("reconnecting");
    client.send("typed during a deploy");
    expect(client.getState().messages.at(-1)?.state).toBe("pending");
  });
});

describe("drain", () => {
  it("waits the delay the server chose", () => {
    // The server spreads these across connected clients; honouring the hint is
    // the whole mechanism that stops a deploy from stampeding.
    open();
    harness.current.receive("server.draining", { reconnectAfterMs: 4000, reason: "deploy" });

    expect(client.getState().connection).toBe("reconnecting");
    expect(harness.timers.at(-1)?.ms).toBeGreaterThanOrEqual(4000);
    expect(harness.timers.at(-1)?.ms).toBeLessThanOrEqual(4800);
  });

  it("keeps backing off when the socket opens but the session never completes", () => {
    // A pod that accepts connections and dies before the handshake would
    // otherwise reset the backoff every cycle and be retried at full rate.
    client.connect();
    harness.current.drop();
    const first = harness.timers.at(-1)?.ms ?? 0;
    harness.runTimers();
    harness.current.drop();
    const second = harness.timers.at(-1)?.ms ?? 0;
    expect(second).toBeGreaterThan(first);
  });

  it("resets the backoff once a session actually completes", () => {
    client.connect();
    harness.current.drop();
    harness.runTimers();
    harness.current.drop();
    const backedOff = harness.timers.at(-1)?.ms ?? 0;

    harness.runTimers();
    harness.current.receive("session.ready", {
      conversation: conversation(),
      messages: [],
      agent: null,
      resumed: true,
    });
    harness.current.drop();

    expect(harness.timers.at(-1)?.ms ?? 0).toBeLessThan(backedOff);
  });
});

describe("streaming", () => {
  it("accumulates deltas into one bubble and resolves it without duplicating", () => {
    open();
    harness.current.receive("message.delta", { messageId: "msg_ai", text: "Plug " });
    harness.current.receive("message.delta", { messageId: "msg_ai", text: "it back in." });
    expect(client.getState().messages).toHaveLength(1);
    expect(client.getState().messages[0]?.body).toBe("Plug it back in.");
    expect(client.getState().typing).toBe(true);

    harness.current.receive("message.new", {
      message: message({ id: "msg_ai", body: "Plug it back in.", seq: 2 }),
    });

    // The server persists under the id it streamed with, so the finished message
    // replaces the bubble instead of appearing beneath it.
    expect(client.getState().messages).toHaveLength(1);
    expect(client.getState().messages[0]?.state).toBe("done");
    expect(client.getState().typing).toBe(false);
  });

  it("does not duplicate the user's own message echoed from another tab", () => {
    open();
    client.send("from tab one");
    const id = harness.current.sent.find((f) => f.type === "message.send")?.payload
      .clientMessageId as string;
    harness.current.receive("message.new", {
      message: message({
        id: "msg_user",
        senderType: "user",
        body: "from tab one",
        clientMessageId: id,
      }),
    });
    expect(client.getState().messages).toHaveLength(1);
  });
});

describe("status", () => {
  it("tracks queue position while waiting for a person", () => {
    open();
    harness.current.receive("conversation.status", {
      conversationId: "cnv_1",
      status: "queued",
      agent: null,
      queuePosition: 3,
    });
    expect(client.getState().status).toBe("queued");
    expect(client.getState().queuePosition).toBe(3);
  });

  it("surfaces a server error without tearing down the session", () => {
    open();
    harness.current.receive("error", {
      code: "rate_limited",
      message: "Too many messages.",
      retryable: true,
      frameId: null,
    });
    expect(client.getState().error).toBe("Too many messages.");
    expect(client.getState().connection).toBe("open");
  });

  it("ignores an unparseable frame rather than crashing", () => {
    open();
    expect(() => harness.current.receive("message.delta", { nope: true })).not.toThrow();
    expect(() =>
      harness.current.receive("not.a.real.frame", { anything: 1 }),
    ).not.toThrow();
  });
});

describe("storage", () => {
  it("works when storage throws, as in private browsing", () => {
    const throwing = harness.build({
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    });
    throwing.connect();
    expect(() =>
      harness.current.receive("session.ready", {
        conversation: conversation(),
        messages: [],
        agent: null,
        resumed: false,
      }),
    ).not.toThrow();
    expect(throwing.getState().conversationId).toBe("cnv_1");
  });

  it("starts a fresh session after reset", () => {
    open();
    client.reset();
    expect(client.getState().conversationId).toBeNull();
    expect(harness.store.size).toBe(0);
  });
});
