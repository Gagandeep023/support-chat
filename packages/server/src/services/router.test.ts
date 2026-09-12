import { beforeEach, describe, expect, it } from "vitest";
import { newTenantId, type Conversation } from "@gagandeep023/support-chat-core";
import { MemoryCacheStore } from "../adapters/memory-cache-store.js";
import { MemoryDataStore } from "../adapters/memory-data-store.js";
import { Router, type RouterSink, type RouterTimers } from "./router.js";

/** Controllable clock, so a twenty second accept window costs no wall time. */
class FakeTimers implements RouterTimers {
  private current = 1_700_000_000_000;
  private readonly queue = new Map<number, { at: number; handler: () => void }>();
  private nextId = 1;

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.set(id, { at: this.current + ms, handler });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue.delete(handle as number);
  }
  now(): number {
    return this.current;
  }
  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = [...this.queue.entries()].filter(([, t]) => t.at <= this.current);
    for (const [id, task] of due) {
      this.queue.delete(id);
      task.handler();
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
}

class RecordingSink implements RouterSink {
  offers: Array<{ agentId: string; conversationId: string; summary: string }> = [];
  revokes: Array<{ agentId: string; conversationId: string; reason: string }> = [];
  assignments: Array<{ agentId: string; conversationId: string }> = [];
  statuses: Array<{ conversationId: string; status: string }> = [];

  offer(input: Parameters<RouterSink["offer"]>[0]): void {
    this.offers.push({
      agentId: input.agentId,
      conversationId: input.conversationId,
      summary: input.summary,
    });
  }
  revoke(input: Parameters<RouterSink["revoke"]>[0]): void {
    this.revokes.push(input);
  }
  assigned(input: Parameters<RouterSink["assigned"]>[0]): void {
    this.assignments.push({
      agentId: input.agentId,
      conversationId: input.conversation.id,
    });
  }
  conversationStatus(conversation: Conversation): void {
    this.statuses.push({ conversationId: conversation.id, status: conversation.status });
  }
  queueUpdate(): void {}
}

const ACCEPT_MS = 20_000;
let data: MemoryDataStore;
let cache: MemoryCacheStore;
let sink: RecordingSink;
let timers: FakeTimers;
let router: Router;
let tenantId: string;

async function queueConversation(): Promise<string> {
  const user = await data.upsertEndUser({ tenantId, externalId: null });
  const conversation = await data.createConversation({
    tenantId,
    endUserId: user.id,
    channel: "web",
  });
  await data.setConversationStatus(conversation.id, "queued");
  await cache.enqueue(tenantId, conversation.id);
  await data.appendEvent({
    conversationId: conversation.id,
    tenantId,
    type: "escalation.triggered",
    actor: { type: "ai", id: null },
    payload: { summary: "Charged twice", urgency: "high" },
  });
  return conversation.id;
}

async function onlineAgent(externalId: string, maxConcurrent = 3): Promise<string> {
  const agent = await data.upsertAgent({
    tenantId,
    externalId,
    displayName: externalId,
    maxConcurrent,
  });
  await cache.heartbeat(tenantId, agent.id, 30);
  return agent.id;
}

beforeEach(() => {
  data = new MemoryDataStore();
  cache = new MemoryCacheStore({ now: () => Date.now() });
  sink = new RecordingSink();
  timers = new FakeTimers();
  tenantId = newTenantId();
  data.seedTenant({
    id: tenantId,
    name: "Acme",
    publishableKey: "pk",
    settings: {},
    createdAt: new Date().toISOString(),
  });
  router = new Router({ data, cache, sink }, { acceptWindowMs: ACCEPT_MS, timers });
});

describe("offer routing", () => {
  it("offers a queued conversation to an online agent, with the escalation summary", async () => {
    const agentId = await onlineAgent("a1");
    const conversationId = await queueConversation();
    await router.pump(tenantId);

    expect(sink.offers).toHaveLength(1);
    expect(sink.offers[0]?.agentId).toBe(agentId);
    // The agent opens knowing why it reached them, not just that it did.
    expect(sink.offers[0]?.summary).toBe("Charged twice");
    expect(conversationId).toBeTruthy();
  });

  it("does not offer when nobody is online, and records why", async () => {
    const conversationId = await queueConversation();
    await router.pump(tenantId);

    expect(sink.offers).toHaveLength(0);
    const events = await data.listEvents(conversationId);
    expect(events.map((e) => e.type)).toContain("handoff.no_agents");
    // Still queued, so it gets placed the moment somebody appears.
    expect((await data.getConversation(tenantId, conversationId))?.status).toBe("queued");
  });

  it("places the queue as soon as an agent comes online", async () => {
    await queueConversation();
    await router.pump(tenantId);
    expect(sink.offers).toHaveLength(0);

    await onlineAgent("a1");
    await router.pump(tenantId);
    expect(sink.offers).toHaveLength(1);
  });

  it("picks the least loaded agent rather than round-robin", async () => {
    const busy = await onlineAgent("busy");
    const idle = await onlineAgent("idle");
    await cache.incrLoad(busy);
    await cache.incrLoad(busy);

    await queueConversation();
    await router.pump(tenantId);
    expect(sink.offers[0]?.agentId).toBe(idle);
  });

  it("skips an agent already at capacity", async () => {
    const full = await onlineAgent("full", 1);
    await cache.incrLoad(full);
    await queueConversation();
    await router.pump(tenantId);
    expect(sink.offers).toHaveLength(0);
  });
});

describe("accepting", () => {
  it("assigns the conversation and tells the widget", async () => {
    const agentId = await onlineAgent("a1");
    const conversationId = await queueConversation();
    await router.pump(tenantId);
    await router.respond({ tenantId, conversationId, agentId, accept: true });

    const conversation = await data.getConversation(tenantId, conversationId);
    expect(conversation?.status).toBe("assigned");
    expect(conversation?.assignedAgentId).toBe(agentId);
    expect(sink.assignments).toEqual([{ agentId, conversationId }]);
    expect(sink.statuses.at(-1)?.status).toBe("assigned");
    expect(await cache.queueDepth(tenantId)).toBe(0);
  });

  it("lets only one agent win the same conversation", async () => {
    // Two consoles, one conversation. Without an atomic claim both agents start
    // typing replies to the same customer.
    const first = await onlineAgent("a1");
    const second = await onlineAgent("a2");
    const conversationId = await queueConversation();
    await router.pump(tenantId);

    const offered = sink.offers[0]?.agentId;
    const other = offered === first ? second : first;

    await router.respond({ tenantId, conversationId, agentId: offered!, accept: true });
    await router.respond({ tenantId, conversationId, agentId: other, accept: true });

    expect(sink.assignments).toHaveLength(1);
    expect(sink.revokes.at(-1)).toMatchObject({ agentId: other, reason: "taken" });
  });

  it("moves on when an agent declines", async () => {
    const first = await onlineAgent("a1");
    const second = await onlineAgent("a2");
    const conversationId = await queueConversation();
    await router.pump(tenantId);

    const offered = sink.offers[0]?.agentId!;
    await router.respond({ tenantId, conversationId, agentId: offered, accept: false });

    expect(sink.offers).toHaveLength(2);
    expect(sink.offers[1]?.agentId).toBe(offered === first ? second : first);
  });
});

describe("accept window", () => {
  it("reassigns when an agent lets the offer lapse", async () => {
    // Without a deadline the conversation rots on someone who walked away while
    // the customer waits in a queue of one.
    const first = await onlineAgent("a1");
    const second = await onlineAgent("a2");
    const conversationId = await queueConversation();
    await router.pump(tenantId);
    const offered = sink.offers[0]?.agentId!;

    await timers.advance(ACCEPT_MS + 1);

    expect(sink.revokes.at(-1)).toMatchObject({ agentId: offered, reason: "expired" });
    expect(sink.offers).toHaveLength(2);
    expect(sink.offers[1]?.agentId).toBe(offered === first ? second : first);

    const events = await data.listEvents(conversationId);
    expect(events.map((e) => e.type)).toContain("handoff.offer_expired");
  });

  it("prefers an agent who has not just missed an offer", async () => {
    // One unattended console would otherwise absorb and expire the whole queue.
    const missed = await onlineAgent("a1");
    await queueConversation();
    await router.pump(tenantId);
    await timers.advance(ACCEPT_MS + 1);

    const fresh = await onlineAgent("a2");
    await queueConversation();
    await router.pump(tenantId);

    expect(sink.offers.at(-1)?.agentId).toBe(fresh);
    expect(fresh).not.toBe(missed);
  });

  it("still offers to a cooling agent when they are the only one left", async () => {
    // A hard cooldown filter would take a single-agent deployment dead for the
    // whole cooldown after one missed offer. A customer waiting on nobody is
    // worse than an agent getting a second notification.
    const only = await onlineAgent("a1");
    await queueConversation();
    await router.pump(tenantId);
    await timers.advance(ACCEPT_MS + 1);

    await queueConversation();
    await router.pump(tenantId);

    expect(sink.offers.filter((o) => o.agentId === only).length).toBeGreaterThan(1);
  });

  it("stops the timer once an offer is accepted", async () => {
    const agentId = await onlineAgent("a1");
    const conversationId = await queueConversation();
    await router.pump(tenantId);
    await router.respond({ tenantId, conversationId, agentId, accept: true });

    await timers.advance(ACCEPT_MS * 3);
    expect(sink.revokes).toHaveLength(0);
  });
});

describe("queue ordering", () => {
  it("does not let an unplaceable conversation block the ones behind it", async () => {
    const agentId = await onlineAgent("a1", 1);
    const stuck = await queueConversation();
    const behind = await queueConversation();

    // The first is offered, then declined by the only agent, leaving it with
    // nobody left to try.
    await router.pump(tenantId);
    await router.respond({ tenantId, conversationId: stuck, agentId, accept: false });

    // Next pump must reach the second conversation rather than spinning on the
    // head of the queue forever.
    await timers.advance(1);
    await router.pump(tenantId);

    const offered = sink.offers.map((o) => o.conversationId);
    expect(offered).toContain(behind);
  });
});

describe("capacity", () => {
  it("offers the next conversation when an agent resolves one", async () => {
    const agentId = await onlineAgent("a1", 1);
    const first = await queueConversation();
    await router.pump(tenantId);
    await router.respond({ tenantId, conversationId: first, agentId, accept: true });

    await queueConversation();
    await router.pump(tenantId);
    expect(sink.offers).toHaveLength(1);

    await data.setConversationStatus(first, "resolved");
    await router.release({ tenantId, agentId });
    expect(sink.offers).toHaveLength(2);
  });

  it("releases an offer when the agent disconnects mid-window", async () => {
    const first = await onlineAgent("a1");
    const second = await onlineAgent("a2");
    await queueConversation();
    await router.pump(tenantId);
    const offered = sink.offers[0]?.agentId!;

    await cache.clearPresence(tenantId, offered);
    await router.abandon({ tenantId, agentId: offered });

    expect(sink.offers).toHaveLength(2);
    expect(sink.offers[1]?.agentId).toBe(offered === first ? second : first);
  });
});
