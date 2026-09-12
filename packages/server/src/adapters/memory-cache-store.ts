import type { CacheStore, Unsubscribe } from "../stores/cache-store.js";

interface PresenceEntry {
  expiresAt: number;
}

/**
 * Single-process CacheStore.
 *
 * A real implementation rather than a stub: a team running one instance should
 * not be forced to operate Redis, and that promise only holds if this behaves
 * correctly, TTL expiry included.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly subscribers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly presence = new Map<string, PresenceEntry>();
  private readonly load = new Map<string, number>();
  private readonly queues = new Map<string, string[]>();
  private readonly seqs = new Map<string, number>();
  private readonly claims = new Map<string, { holder: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async close(): Promise<void> {
    this.subscribers.clear();
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    for (const handler of this.subscribers.get(channel) ?? []) handler(payload);
  }

  async subscribe(
    channel: string,
    handler: (payload: unknown) => void,
  ): Promise<Unsubscribe> {
    const set = this.subscribers.get(channel) ?? new Set();
    set.add(handler);
    this.subscribers.set(channel, set);
    return () => {
      set.delete(handler);
    };
  }

  private presenceKey(tenantId: string, agentId: string): string {
    return `${tenantId}:${agentId}`;
  }

  async heartbeat(tenantId: string, agentId: string, ttlSeconds: number): Promise<void> {
    this.presence.set(this.presenceKey(tenantId, agentId), {
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async clearPresence(tenantId: string, agentId: string): Promise<void> {
    this.presence.delete(this.presenceKey(tenantId, agentId));
  }

  async onlineAgents(tenantId: string): Promise<string[]> {
    const now = this.now();
    const online: string[] = [];
    for (const [key, entry] of this.presence) {
      if (entry.expiresAt <= now) {
        this.presence.delete(key);
        continue;
      }
      const [keyTenant, agentId] = key.split(":");
      if (keyTenant === tenantId && agentId) online.push(agentId);
    }
    return online;
  }

  async incrLoad(agentId: string): Promise<number> {
    const next = (this.load.get(agentId) ?? 0) + 1;
    this.load.set(agentId, next);
    return next;
  }

  async decrLoad(agentId: string): Promise<number> {
    const next = Math.max(0, (this.load.get(agentId) ?? 0) - 1);
    this.load.set(agentId, next);
    return next;
  }

  async getLoad(agentIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of agentIds) out[id] = this.load.get(id) ?? 0;
    return out;
  }

  async enqueue(tenantId: string, conversationId: string): Promise<void> {
    const queue = this.queues.get(tenantId) ?? [];
    if (!queue.includes(conversationId)) queue.push(conversationId);
    this.queues.set(tenantId, queue);
  }

  async dequeue(tenantId: string): Promise<string | null> {
    const queue = this.queues.get(tenantId) ?? [];
    return queue.shift() ?? null;
  }

  /** Remove without taking, for a conversation that left the queue another way. */
  async unqueue(tenantId: string, conversationId: string): Promise<void> {
    const queue = this.queues.get(tenantId) ?? [];
    const index = queue.indexOf(conversationId);
    if (index !== -1) queue.splice(index, 1);
  }

  async listQueue(tenantId: string): Promise<string[]> {
    return [...(this.queues.get(tenantId) ?? [])];
  }

  async queueDepth(tenantId: string): Promise<number> {
    return (this.queues.get(tenantId) ?? []).length;
  }

  async queuePosition(tenantId: string, conversationId: string): Promise<number | null> {
    const index = (this.queues.get(tenantId) ?? []).indexOf(conversationId);
    return index === -1 ? null : index + 1;
  }

  async claim(key: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.claims.get(key);
    if (existing && existing.expiresAt > this.now()) {
      return existing.holder === holder;
    }
    this.claims.set(key, { holder, expiresAt: this.now() + ttlSeconds * 1000 });
    return true;
  }

  async release(key: string, holder: string): Promise<void> {
    // Only the holder may release. A release arriving after the TTL already
    // expired and someone else claimed must not evict the new holder.
    if (this.claims.get(key)?.holder === holder) this.claims.delete(key);
  }

  async peek(key: string): Promise<string | null> {
    const entry = this.claims.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.claims.delete(key);
      return null;
    }
    return entry.holder;
  }

  async setConversationSeq(conversationId: string, seq: number): Promise<void> {
    this.seqs.set(conversationId, seq);
  }

  async getConversationSeq(conversationId: string): Promise<number | null> {
    return this.seqs.get(conversationId) ?? null;
  }
}
