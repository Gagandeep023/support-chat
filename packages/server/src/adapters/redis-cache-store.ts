import type { CacheStore, Unsubscribe } from "../stores/cache-store.js";

/**
 * The slice of an ioredis client this adapter uses.
 *
 * Structural rather than an ioredis import, so a node-redis user can pass a thin
 * shim and nothing here depends on one client library's types.
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  lpop(key: string): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, handler: (...args: never[]) => void): unknown;
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
}

export interface RedisOptions {
  url?: string;
  /** An existing client to share with the rest of the application. */
  client?: RedisLike;
  /** Namespace, so several deployments can share one Redis instance. */
  prefix?: string;
}

/*
 * Every multi-step operation is a script.
 *
 * Read-then-write against Redis from application code is a race between pods,
 * which is exactly the situation this adapter exists for: if a single process
 * were enough, the in-memory store already works. EVAL runs atomically on the
 * server, so these are the only forms that are actually correct.
 */

/** SET NX, but idempotent for the existing holder rather than reporting failure. */
const CLAIM = `
local ok = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if ok then return 1 end
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/**
 * Release only if still held.
 *
 * GET then DEL from the client is the classic distributed-lock bug: the TTL can
 * expire between the two calls and the DEL then removes somebody else's claim.
 */
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** DECR with a floor, so a double resolve cannot leave an agent on -1 and looking idle. */
const DECR_FLOOR = `
local n = redis.call('DECR', KEYS[1])
if n < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return n`;

/** RPUSH unless already present, checked and written in one step. */
const ENQUEUE_ONCE = `
if redis.call('LPOS', KEYS[1], ARGV[1]) then return 0 end
redis.call('RPUSH', KEYS[1], ARGV[1])
return 1`;

const POSITION = `
local index = redis.call('LPOS', KEYS[1], ARGV[1])
if index == false then return -1 end
return index + 1`;

export class RedisCacheStore implements CacheStore {
  private readonly prefix: string;
  private readonly ownsClient: boolean;
  private client: RedisLike | null;
  private subscriber: RedisLike | null = null;
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly url: string;

  constructor(options: RedisOptions = {}) {
    this.prefix = options.prefix ?? "support-chat";
    this.client = options.client ?? null;
    this.ownsClient = !options.client;
    this.url = options.url ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  }

  private key(...parts: string[]): string {
    return [this.prefix, ...parts].join(":");
  }

  private async connection(): Promise<RedisLike> {
    if (this.client) return this.client;
    let Redis: new (url: string) => RedisLike;
    try {
      const module = (await import("ioredis")) as unknown as {
        default: new (url: string) => RedisLike;
      };
      Redis = module.default;
    } catch {
      throw new Error(
        "support-chat: the Redis adapter needs the `ioredis` package. " +
          "Install it with `npm install ioredis`.",
      );
    }
    this.client = new Redis(this.url);
    return this.client;
  }

  /**
   * A connection in subscriber mode cannot run ordinary commands, so pub/sub
   * gets its own. Sharing one connection is the mistake that makes every other
   * call start failing the moment anything subscribes.
   */
  private async subscriberConnection(): Promise<RedisLike> {
    if (this.subscriber) return this.subscriber;
    const base = await this.connection();
    const subscriber = base.duplicate();
    subscriber.on("message", ((channel: string, message: string) => {
      const listeners = this.handlers.get(channel);
      if (!listeners?.size) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message);
      } catch {
        payload = message;
      }
      for (const listener of listeners) listener(payload);
    }) as unknown as (...args: never[]) => void);
    this.subscriber = subscriber;
    return subscriber;
  }

  async close(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
    this.subscriber = null;
    this.handlers.clear();
    // Only the client this adapter created. Quitting one handed in by the host
    // application would take down the rest of their Redis usage.
    if (this.ownsClient) await this.client?.quit().catch(() => undefined);
    this.client = null;
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    const redis = await this.connection();
    await redis.publish(this.key("ch", channel), JSON.stringify(payload));
  }

  async subscribe(
    channel: string,
    handler: (payload: unknown) => void,
  ): Promise<Unsubscribe> {
    const full = this.key("ch", channel);
    const subscriber = await this.subscriberConnection();
    const existing = this.handlers.get(full);

    if (existing) {
      existing.add(handler);
    } else {
      this.handlers.set(full, new Set([handler]));
      await subscriber.subscribe(full);
    }

    return () => {
      const listeners = this.handlers.get(full);
      if (!listeners) return;
      listeners.delete(handler);
      // Refcounted: only leave the channel when the last local listener goes,
      // or a second subscriber on the same channel silently stops receiving.
      if (listeners.size === 0) {
        this.handlers.delete(full);
        void this.subscriber?.unsubscribe(full).catch(() => undefined);
      }
    };
  }

  /**
   * Presence is a sorted set scored by expiry, not one key per agent.
   *
   * Listing online agents runs on every routing decision, and per-agent keys
   * would make that a SCAN across the keyspace. A ZSET turns it into one
   * range read plus a cheap eviction of anything stale.
   */
  async heartbeat(tenantId: string, agentId: string, ttlSeconds: number): Promise<void> {
    const redis = await this.connection();
    await redis.zadd(this.key("presence", tenantId), Date.now() + ttlSeconds * 1000, agentId);
  }

  async clearPresence(tenantId: string, agentId: string): Promise<void> {
    const redis = await this.connection();
    await redis.zrem(this.key("presence", tenantId), agentId);
  }

  async onlineAgents(tenantId: string): Promise<string[]> {
    const redis = await this.connection();
    const key = this.key("presence", tenantId);
    await redis.zremrangebyscore(key, "-inf", Date.now());
    return redis.zrange(key, 0, -1);
  }

  async incrLoad(agentId: string): Promise<number> {
    const redis = await this.connection();
    return Number(await redis.eval("return redis.call('INCR', KEYS[1])", 1, this.key("load", agentId)));
  }

  async decrLoad(agentId: string): Promise<number> {
    const redis = await this.connection();
    return Number(await redis.eval(DECR_FLOOR, 1, this.key("load", agentId)));
  }

  async getLoad(agentIds: string[]): Promise<Record<string, number>> {
    const redis = await this.connection();
    const out: Record<string, number> = {};
    await Promise.all(
      agentIds.map(async (id) => {
        out[id] = Number((await redis.get(this.key("load", id))) ?? 0);
      }),
    );
    return out;
  }

  async enqueue(tenantId: string, conversationId: string): Promise<void> {
    const redis = await this.connection();
    await redis.eval(ENQUEUE_ONCE, 1, this.key("queue", tenantId), conversationId);
  }

  async dequeue(tenantId: string): Promise<string | null> {
    const redis = await this.connection();
    return redis.lpop(this.key("queue", tenantId));
  }

  async unqueue(tenantId: string, conversationId: string): Promise<void> {
    const redis = await this.connection();
    await redis.lrem(this.key("queue", tenantId), 0, conversationId);
  }

  async listQueue(tenantId: string): Promise<string[]> {
    const redis = await this.connection();
    return redis.lrange(this.key("queue", tenantId), 0, -1);
  }

  async queueDepth(tenantId: string): Promise<number> {
    const redis = await this.connection();
    return Number(await redis.llen(this.key("queue", tenantId)));
  }

  async queuePosition(tenantId: string, conversationId: string): Promise<number | null> {
    const redis = await this.connection();
    const position = Number(
      await redis.eval(POSITION, 1, this.key("queue", tenantId), conversationId),
    );
    return position === -1 ? null : position;
  }

  async claim(key: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const redis = await this.connection();
    return Number(await redis.eval(CLAIM, 1, this.key("claim", key), holder, ttlSeconds)) === 1;
  }

  async release(key: string, holder: string): Promise<void> {
    const redis = await this.connection();
    await redis.eval(RELEASE, 1, this.key("claim", key), holder);
  }

  async peek(key: string): Promise<string | null> {
    const redis = await this.connection();
    return redis.get(this.key("claim", key));
  }

  async setConversationSeq(conversationId: string, seq: number): Promise<void> {
    const redis = await this.connection();
    // A day is far longer than any live conversation and keeps abandoned ones
    // from accumulating forever; the database remains the source of truth, so an
    // expired entry costs one extra read, not correctness.
    await redis.set(this.key("seq", conversationId), String(seq), "EX", 86_400);
  }

  async getConversationSeq(conversationId: string): Promise<number | null> {
    const redis = await this.connection();
    const value = await redis.get(this.key("seq", conversationId));
    return value === null ? null : Number(value);
  }
}
