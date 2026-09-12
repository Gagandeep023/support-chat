export type Unsubscribe = () => void;

/**
 * Ephemeral coordination state: presence, queue, load counters, and cross-node
 * fan-out.
 *
 * The in-memory implementation is not a toy. A team running a single instance
 * should never be forced to operate Redis, and that is only true if the fallback
 * is a real implementation rather than a stub that quietly drops messages.
 */
export interface CacheStore {
  close(): Promise<void>;

  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: (payload: unknown) => void): Promise<Unsubscribe>;

  /**
   * Agent liveness, as a TTL heartbeat rather than "is the socket connected":
   * agents leave laptops open on locked screens, and socket liveness would route
   * conversations to them.
   */
  heartbeat(tenantId: string, agentId: string, ttlSeconds: number): Promise<void>;
  /**
   * Drop presence immediately.
   *
   * Called on clean disconnect, including a drain. Letting the TTL run during a
   * deploy means the router believes agents are online who are not connected,
   * so offers go to nobody and every accept window expires in turn.
   */
  clearPresence(tenantId: string, agentId: string): Promise<void>;
  onlineAgents(tenantId: string): Promise<string[]>;

  incrLoad(agentId: string): Promise<number>;
  decrLoad(agentId: string): Promise<number>;
  getLoad(agentIds: string[]): Promise<Record<string, number>>;

  enqueue(tenantId: string, conversationId: string): Promise<void>;
  dequeue(tenantId: string): Promise<string | null>;
  /** Remove a conversation that left the queue some other way. */
  unqueue(tenantId: string, conversationId: string): Promise<void>;
  /**
   * The queue in order, without taking anything.
   *
   * The router walks the whole list rather than only the head: a conversation
   * that cannot be placed right now must not block everything behind it.
   */
  listQueue(tenantId: string): Promise<string[]>;
  queueDepth(tenantId: string): Promise<number>;
  queuePosition(tenantId: string, conversationId: string): Promise<number | null>;

  /**
   * Atomic claim with a TTL. Returns false when someone else already holds it.
   *
   * This is what stops two pods offering the same conversation to two agents,
   * and two agents accepting the same conversation. Without an atomic primitive
   * the check-then-assign is a race whose symptom is two people typing replies
   * to the same customer. Maps to Redis `SET key holder NX EX ttl`.
   */
  claim(key: string, holder: string, ttlSeconds: number): Promise<boolean>;
  /** Release only if still held by `holder`, so a late release cannot steal. */
  release(key: string, holder: string): Promise<void>;
  peek(key: string): Promise<string | null>;

  /**
   * Cached conversation head sequence.
   *
   * The hot path on a reconnect storm: when a resuming client's lastSeq matches,
   * the answer is one cache read and an empty replay, instead of a query against
   * the messages table for every client at once.
   */
  setConversationSeq(conversationId: string, seq: number): Promise<void>;
  getConversationSeq(conversationId: string): Promise<number | null>;
}
