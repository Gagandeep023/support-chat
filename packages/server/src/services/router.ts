import {
  SupportChatError,
  type AgentRecord,
  type Conversation,
  type Diagnosis,
  type Urgency,
} from "@gagandeep023/support-chat-core";
import type { CacheStore } from "../stores/cache-store.js";
import type { DataStore } from "../stores/data-store.js";

export interface RouterTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: RouterTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface RouterSink {
  offer(input: {
    agentId: string;
    conversationId: string;
    summary: string;
    urgency: Urgency;
    diagnosis: Diagnosis | null;
    waitingSince: string;
    expiresAt: string;
  }): void;
  revoke(input: {
    agentId: string;
    conversationId: string;
    reason: "expired" | "taken" | "resolved" | "cancelled";
  }): void;
  assigned(input: {
    agentId: string;
    conversation: Conversation;
    diagnosis: Diagnosis | null;
  }): void;
  conversationStatus(conversation: Conversation, queuePosition: number | null): void;
  queueUpdate(tenantId: string, depth: number): void;
}

export interface RouterOptions {
  /** How long an agent has to accept before the offer moves on. */
  acceptWindowMs?: number;
  /** How long an agent who missed an offer is skipped for. */
  missCooldownMs?: number;
  timers?: RouterTimers;
}

interface PendingOffer {
  conversationId: string;
  tenantId: string;
  agentId: string;
  timer: unknown;
  attempted: Set<string>;
}

const offerKey = (conversationId: string) => `offer:${conversationId}`;
const cooldownKey = (agentId: string) => `cooldown:${agentId}`;

/**
 * Assigns queued conversations to human agents.
 *
 * The AI is a few hundred lines; this is where products in this category
 * actually fail. Three things carry the design:
 *
 * - Offers are claimed atomically, so two pods cannot hand the same
 *   conversation to two agents and two agents cannot both accept it.
 * - Every offer has a deadline. Without one a conversation rots on an agent who
 *   walked away while the customer waits in a queue of one.
 * - Selection is least-loaded, not round-robin, because round-robin hands a
 *   fourth conversation to a saturated agent while someone else sits idle.
 */
export class Router {
  private readonly acceptWindowMs: number;
  private readonly missCooldownMs: number;
  private readonly timers: RouterTimers;
  private readonly pending = new Map<string, PendingOffer>();
  /** Serialises pump() per tenant so one queue is not drained twice at once. */
  private readonly pumping = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: { data: DataStore; cache: CacheStore; sink: RouterSink },
    options: RouterOptions = {},
  ) {
    this.acceptWindowMs = options.acceptWindowMs ?? 20_000;
    this.missCooldownMs = options.missCooldownMs ?? 60_000;
    this.timers = options.timers ?? realTimers;
  }

  /**
   * Try to place queued conversations.
   *
   * Called whenever the situation changes: something queued, an agent came
   * online, an offer expired, a conversation resolved. Cheap when there is
   * nothing to do.
   */
  async pump(tenantId: string): Promise<void> {
    const inFlight = this.pumping.get(tenantId);
    if (inFlight) return inFlight;

    const run = this.pumpOnce(tenantId).finally(() => this.pumping.delete(tenantId));
    this.pumping.set(tenantId, run);
    return run;
  }

  private async pumpOnce(tenantId: string): Promise<void> {
    // The whole queue in order, not just its head. A conversation that cannot be
    // placed right now (everyone has already declined it, or it needs a skill
    // nobody online has) must not block every conversation behind it.
    for (const conversationId of await this.deps.cache.listQueue(tenantId)) {
      // Already offered to someone and still inside their window.
      if (await this.deps.cache.peek(offerKey(conversationId))) continue;

      const conversation = await this.deps.data.getConversation(tenantId, conversationId);
      if (!conversation || conversation.status !== "queued") {
        await this.deps.cache.unqueue(tenantId, conversationId);
        continue;
      }

      const attempted = this.pending.get(conversationId)?.attempted ?? new Set<string>();
      let agent = await this.pickAgent(tenantId, attempted);

      if (!agent && attempted.size > 0) {
        // Everyone available has already seen this one. Start the rotation over
        // rather than leaving it unplaceable forever: an agent who declined ten
        // minutes ago is a better outcome for the customer than nobody.
        attempted.clear();
        agent = await this.pickAgent(tenantId, attempted);
      }

      if (!agent) {
        await this.deps.data.appendEvent({
          conversationId,
          tenantId,
          type: "handoff.no_agents",
          actor: { type: "system", id: null },
          payload: { queueDepth: await this.deps.cache.queueDepth(tenantId) },
        });
        continue;
      }

      const claimed = await this.deps.cache.claim(
        offerKey(conversationId),
        agent.id,
        Math.ceil(this.acceptWindowMs / 1000) + 1,
      );
      if (!claimed) continue;

      await this.issueOffer(conversation, agent, attempted);
      // One offer per pump. The next is issued when this one resolves or lapses,
      // so a burst of queued conversations does not flood every console at once.
      return;
    }
  }

  private async pickAgent(
    tenantId: string,
    attempted: Set<string>,
  ): Promise<AgentRecord | null> {
    const onlineIds = await this.deps.cache.onlineAgents(tenantId);
    const loads = await this.deps.cache.getLoad(onlineIds);

    const preferred: AgentRecord[] = [];
    const cooling: AgentRecord[] = [];

    for (const id of onlineIds) {
      if (attempted.has(id)) continue;
      const agent = await this.deps.data.getAgent(tenantId, id);
      if (!agent) continue;
      if ((loads[id] ?? 0) >= agent.maxConcurrent) continue;
      // An agent who just missed an offer is deprioritised rather than skipped
      // outright, so one unattended console does not absorb and expire the whole
      // queue. It must not be a hard filter: in a single-agent deployment that
      // would take the queue dead for the whole cooldown after one missed offer,
      // and a customer waiting on nobody is worse than a second notification.
      if (await this.deps.cache.peek(cooldownKey(id))) cooling.push(agent);
      else preferred.push(agent);
    }

    const byLoad = (a: AgentRecord, b: AgentRecord) => {
      const difference = (loads[a.id] ?? 0) - (loads[b.id] ?? 0);
      return difference !== 0 ? difference : a.id < b.id ? -1 : 1;
    };

    const pool = preferred.length > 0 ? preferred.sort(byLoad) : cooling.sort(byLoad);
    return pool[0] ?? null;
  }

  private async issueOffer(
    conversation: Conversation,
    agent: AgentRecord,
    attempted: Set<string>,
  ): Promise<void> {
    const events = await this.deps.data.listEvents(conversation.id);
    const escalation = [...events]
      .reverse()
      .find((event) => event.type === "escalation.triggered");
    const payload = (escalation?.payload ?? {}) as {
      summary?: string;
      urgency?: Urgency;
      diagnosis?: Diagnosis;
    };

    const expiresAt = new Date(this.timers.now() + this.acceptWindowMs).toISOString();
    attempted.add(agent.id);

    const timer = this.timers.setTimeout(() => {
      void this.expire(conversation.id).catch(() => undefined);
    }, this.acceptWindowMs);

    this.pending.set(conversation.id, {
      conversationId: conversation.id,
      tenantId: conversation.tenantId,
      agentId: agent.id,
      timer,
      attempted,
    });

    await this.deps.data.appendEvent({
      conversationId: conversation.id,
      tenantId: conversation.tenantId,
      type: "handoff.offered",
      actor: { type: "system", id: null },
      payload: { agentId: agent.id, expiresAt },
    });

    this.deps.sink.offer({
      agentId: agent.id,
      conversationId: conversation.id,
      // The agent opens already knowing why this reached them and what the bot
      // tried. Starting from scratch makes the customer repeat everything, which
      // is the fastest way to make handoff feel worse than no bot at all.
      summary: payload.summary ?? "A customer is waiting for help.",
      urgency: payload.urgency ?? "normal",
      diagnosis: payload.diagnosis ?? null,
      waitingSince: conversation.lastMessageAt ?? conversation.createdAt,
      expiresAt,
    });
  }

  /** An agent answered an offer. */
  async respond(input: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    accept: boolean;
  }): Promise<void> {
    const holder = await this.deps.cache.peek(offerKey(input.conversationId));
    if (holder !== input.agentId) {
      // The window closed, or it was offered to someone else. Answering late is
      // normal, not an error, so the agent is told rather than shouted at.
      this.deps.sink.revoke({
        agentId: input.agentId,
        conversationId: input.conversationId,
        reason: "taken",
      });
      return;
    }

    this.clearPending(input.conversationId);

    if (!input.accept) {
      await this.deps.cache.release(offerKey(input.conversationId), input.agentId);
      await this.deps.cache.claim(
        cooldownKey(input.agentId),
        "declined",
        Math.ceil(this.missCooldownMs / 1000),
      );
      await this.pump(input.tenantId);
      return;
    }

    const conversation = await this.deps.data.getConversation(
      input.tenantId,
      input.conversationId,
    );
    if (!conversation) {
      throw new SupportChatError("conversation_not_found", "No such conversation.");
    }

    await this.deps.data.assignConversation(conversation.id, input.agentId);
    await this.deps.data.setConversationStatus(conversation.id, "assigned");
    await this.deps.cache.incrLoad(input.agentId);
    await this.deps.cache.unqueue(input.tenantId, conversation.id);
    await this.deps.cache.release(offerKey(conversation.id), input.agentId);
    await this.deps.data.appendEvent({
      conversationId: conversation.id,
      tenantId: input.tenantId,
      type: "handoff.assigned",
      actor: { type: "agent", id: input.agentId },
      payload: {},
    });

    const assigned: Conversation = {
      ...conversation,
      status: "assigned",
      assignedAgentId: input.agentId,
    };
    this.deps.sink.assigned({
      agentId: input.agentId,
      conversation: assigned,
      diagnosis: null,
    });
    this.deps.sink.conversationStatus(assigned, null);
    this.deps.sink.queueUpdate(
      input.tenantId,
      await this.deps.cache.queueDepth(input.tenantId),
    );
    await this.pump(input.tenantId);
  }

  /** An assigned conversation ended. Frees capacity and re-examines the queue. */
  async release(input: { tenantId: string; agentId: string }): Promise<void> {
    await this.deps.cache.decrLoad(input.agentId);
    await this.pump(input.tenantId);
  }

  /** An agent went offline mid-offer. */
  async abandon(input: { tenantId: string; agentId: string }): Promise<void> {
    for (const offer of [...this.pending.values()]) {
      if (offer.agentId !== input.agentId) continue;
      this.clearPending(offer.conversationId);
      await this.deps.cache.release(offerKey(offer.conversationId), input.agentId);
    }
    await this.pump(input.tenantId);
  }

  private async expire(conversationId: string): Promise<void> {
    const offer = this.pending.get(conversationId);
    if (!offer) return;
    this.clearPending(conversationId);

    await this.deps.cache.release(offerKey(conversationId), offer.agentId);
    await this.deps.cache.claim(
      cooldownKey(offer.agentId),
      "missed",
      Math.ceil(this.missCooldownMs / 1000),
    );
    await this.deps.data.appendEvent({
      conversationId,
      tenantId: offer.tenantId,
      type: "handoff.offer_expired",
      actor: { type: "system", id: null },
      payload: { agentId: offer.agentId },
    });
    this.deps.sink.revoke({
      agentId: offer.agentId,
      conversationId,
      reason: "expired",
    });

    // The attempted set carries forward so the next pump tries someone else
    // rather than looping back to the agent who just let it lapse.
    this.pending.set(conversationId, { ...offer, timer: null, agentId: "" });
    await this.pump(offer.tenantId);
  }

  private clearPending(conversationId: string): void {
    const offer = this.pending.get(conversationId);
    if (offer?.timer) this.timers.clearTimeout(offer.timer);
  }

  /** Stop every outstanding timer. Called on shutdown. */
  stop(): void {
    for (const offer of this.pending.values()) {
      if (offer.timer) this.timers.clearTimeout(offer.timer);
    }
    this.pending.clear();
  }
}
