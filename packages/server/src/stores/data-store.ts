import type {
  AgentRecord,
  Conversation,
  ConversationEvent,
  ConversationStatus,
  EndUser,
  Message,
  Tenant,
} from "@gagandeep023/support-chat-core";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ConversationFilter {
  status?: ConversationStatus;
  agentId?: string;
  limit: number;
  cursor?: string;
}

export interface NewMessage {
  /**
   * Supply the id when it was already announced to clients.
   *
   * The responder streams deltas under an id before the message exists, so it
   * has to persist under that same id: otherwise the client receives deltas for
   * one id and a finished message with another, and has no way to tell they are
   * the same reply.
   */
  id?: string;
  conversationId: string;
  tenantId: string;
  senderType: Message["senderType"];
  senderId: string | null;
  body: string;
  contentType?: Message["contentType"];
  clientMessageId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Persistence.
 *
 * Deliberately narrow and domain-shaped: no query builder, no `where`, no joins.
 * A generic interface here degenerates into a bad ORM and guarantees that the
 * Postgres, SQLite, and Mongo adapters drift apart in ways integration tests do
 * not catch. Every method is a named operation the engine actually performs.
 *
 * No method spans a transaction, for the same reason. Anything needing
 * "persist, then fan out" goes through the outbox.
 */
export interface DataStore {
  /** Migrations. Each adapter owns its own. */
  init(): Promise<void>;
  close(): Promise<void>;

  getTenantByPublishableKey(key: string): Promise<Tenant | null>;
  getTenant(id: string): Promise<Tenant | null>;

  upsertEndUser(input: {
    tenantId: string;
    externalId: string | null;
    displayName?: string | null;
    email?: string | null;
    attributes?: Record<string, unknown>;
  }): Promise<EndUser>;

  upsertAgent(input: {
    tenantId: string;
    externalId: string;
    displayName: string;
    avatarUrl?: string | null;
    skills?: string[];
    maxConcurrent?: number;
    role?: AgentRecord["role"];
  }): Promise<AgentRecord>;
  getAgent(tenantId: string, id: string): Promise<AgentRecord | null>;

  createConversation(input: {
    tenantId: string;
    endUserId: string;
    channel: Conversation["channel"];
  }): Promise<Conversation>;
  getConversation(tenantId: string, id: string): Promise<Conversation | null>;
  setConversationStatus(
    id: string,
    status: ConversationStatus,
    meta?: Record<string, unknown>,
  ): Promise<void>;
  assignConversation(id: string, agentId: string | null): Promise<void>;
  listConversations(tenantId: string, filter: ConversationFilter): Promise<Page<Conversation>>;

  /**
   * Append a message and assign its sequence number.
   *
   * Must be idempotent on (conversationId, clientMessageId): a client that
   * retries a send across a reconnect gets the original message back rather than
   * a duplicate, which is what makes the resume path safe without a transaction.
   */
  appendMessage(message: NewMessage): Promise<Message>;
  listMessages(
    conversationId: string,
    options: { afterSeq?: number; limit: number },
  ): Promise<Message[]>;

  appendEvent(event: Omit<ConversationEvent, "id" | "createdAt">): Promise<void>;
  listEvents(conversationId: string): Promise<ConversationEvent[]>;
}
