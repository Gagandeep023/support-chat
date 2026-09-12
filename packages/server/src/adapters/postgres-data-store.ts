import {
  newAgentId,
  newConversationId,
  newEndUserId,
  newEventId,
  newMessageId,
  type AgentRecord,
  type Conversation,
  type ConversationEvent,
  type ConversationStatus,
  type EndUser,
  type Message,
  type Tenant,
} from "@gagandeep023/support-chat-core";
import type {
  ConversationFilter,
  DataStore,
  NewMessage,
  Page,
} from "../stores/data-store.js";
import { schemaStatements } from "./sql-schema.js";

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface PoolClient {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  release(): void;
}
interface Pool {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export interface PostgresOptions {
  connectionString?: string;
  /** Supply an existing pool to share it with the rest of the application. */
  pool?: Pool;
  max?: number;
}

/**
 * Postgres DataStore.
 *
 * `pg` is an optional peer dependency, so installing this package does not pull
 * a Postgres driver for someone running SQLite.
 */
export class PostgresDataStore implements DataStore {
  private pool: Pool | null;
  private readonly connectionString: string | undefined;
  private readonly max: number;
  private readonly ownsPool: boolean;

  constructor(options: PostgresOptions = {}) {
    this.pool = options.pool ?? null;
    this.ownsPool = !options.pool;
    this.connectionString = options.connectionString ?? process.env.DATABASE_URL;
    this.max = options.max ?? 10;
  }

  async init(): Promise<void> {
    if (!this.pool) {
      let PoolCtor: new (config: Record<string, unknown>) => Pool;
      try {
        ({ Pool: PoolCtor } = (await import("pg")) as unknown as {
          Pool: new (config: Record<string, unknown>) => Pool;
        });
      } catch {
        throw new Error(
          "support-chat: the Postgres adapter needs the `pg` package. " +
            "Install it with `npm install pg`.",
        );
      }
      if (!this.connectionString) {
        throw new Error(
          "support-chat: PostgresDataStore needs a connectionString or DATABASE_URL.",
        );
      }
      this.pool = new PoolCtor({ connectionString: this.connectionString, max: this.max });
    }
    for (const statement of schemaStatements({
      json: "JSONB",
      timestamp: "TIMESTAMPTZ",
      boolean: "BOOLEAN",
    })) {
      await this.pool.query(statement);
    }
  }

  async close(): Promise<void> {
    // Only close a pool this adapter created. Closing one handed in from the
    // host application would take down the rest of their database access.
    if (this.ownsPool) await this.pool?.end();
    this.pool = null;
  }

  private get handle(): Pool {
    if (!this.pool) throw new Error("support-chat: PostgresDataStore.init() was never awaited.");
    return this.pool;
  }

  async seedTenant(tenant: Tenant): Promise<void> {
    await this.handle.query(
      `INSERT INTO sc_tenants (id, name, publishable_key, settings, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [
        tenant.id,
        tenant.name,
        tenant.publishableKey,
        JSON.stringify(tenant.settings),
        tenant.createdAt,
      ],
    );
  }

  async getTenant(id: string): Promise<Tenant | null> {
    const { rows } = await this.handle.query(`SELECT * FROM sc_tenants WHERE id = $1`, [id]);
    return toTenant(rows[0]);
  }

  async getTenantByPublishableKey(key: string): Promise<Tenant | null> {
    const { rows } = await this.handle.query(
      `SELECT * FROM sc_tenants WHERE publishable_key = $1`,
      [key],
    );
    return toTenant(rows[0]);
  }

  async upsertEndUser(input: {
    tenantId: string;
    externalId: string | null;
    displayName?: string | null;
    email?: string | null;
    attributes?: Record<string, unknown>;
  }): Promise<EndUser> {
    if (input.externalId !== null) {
      const { rows } = await this.handle.query(
        `SELECT * FROM sc_end_users WHERE tenant_id = $1 AND external_id = $2`,
        [input.tenantId, input.externalId],
      );
      if (rows[0]) return toEndUser(rows[0]);
    }
    const user: EndUser = {
      id: newEndUserId(),
      tenantId: input.tenantId,
      externalId: input.externalId,
      isAnonymous: input.externalId === null,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      attributes: input.attributes ?? {},
      createdAt: new Date().toISOString(),
    };
    await this.handle.query(
      `INSERT INTO sc_end_users
         (id, tenant_id, external_id, is_anonymous, display_name, email, attributes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.id,
        user.tenantId,
        user.externalId,
        user.isAnonymous,
        user.displayName,
        user.email,
        JSON.stringify(user.attributes),
        user.createdAt,
      ],
    );
    return user;
  }

  async upsertAgent(input: {
    tenantId: string;
    externalId: string;
    displayName: string;
    avatarUrl?: string | null;
    skills?: string[];
    maxConcurrent?: number;
    role?: AgentRecord["role"];
  }): Promise<AgentRecord> {
    const { rows } = await this.handle.query(
      `SELECT * FROM sc_agents WHERE tenant_id = $1 AND external_id = $2`,
      [input.tenantId, input.externalId],
    );
    const current = toAgent(rows[0]);

    if (current) {
      const updated: AgentRecord = {
        ...current,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? current.avatarUrl,
        skills: input.skills ?? current.skills,
        maxConcurrent: input.maxConcurrent ?? current.maxConcurrent,
        role: input.role ?? current.role,
      };
      await this.handle.query(
        `UPDATE sc_agents
            SET display_name = $2, avatar_url = $3, skills = $4, max_concurrent = $5, role = $6
          WHERE id = $1`,
        [
          updated.id,
          updated.displayName,
          updated.avatarUrl,
          JSON.stringify(updated.skills),
          updated.maxConcurrent,
          updated.role,
        ],
      );
      return updated;
    }

    const agent: AgentRecord = {
      id: newAgentId(),
      tenantId: input.tenantId,
      externalId: input.externalId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl ?? null,
      skills: input.skills ?? [],
      maxConcurrent: input.maxConcurrent ?? 3,
      role: input.role ?? "agent",
      createdAt: new Date().toISOString(),
    };
    await this.handle.query(
      `INSERT INTO sc_agents
         (id, tenant_id, external_id, display_name, avatar_url, skills, max_concurrent, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        agent.id,
        agent.tenantId,
        agent.externalId,
        agent.displayName,
        agent.avatarUrl,
        JSON.stringify(agent.skills),
        agent.maxConcurrent,
        agent.role,
        agent.createdAt,
      ],
    );
    return agent;
  }

  async getAgent(tenantId: string, id: string): Promise<AgentRecord | null> {
    const { rows } = await this.handle.query(
      `SELECT * FROM sc_agents WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return toAgent(rows[0]);
  }

  async createConversation(input: {
    tenantId: string;
    endUserId: string;
    channel: Conversation["channel"];
  }): Promise<Conversation> {
    const conversation: Conversation = {
      id: newConversationId(),
      tenantId: input.tenantId,
      endUserId: input.endUserId,
      status: "ai",
      assignedAgentId: null,
      channel: input.channel,
      subject: null,
      tags: [],
      lastSeq: 0,
      lastMessageAt: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    await this.handle.query(
      `INSERT INTO sc_conversations
         (id, tenant_id, end_user_id, status, assigned_agent_id, channel, subject, tags,
          last_seq, last_message_at, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, 0, NULL, $7, NULL)`,
      [
        conversation.id,
        conversation.tenantId,
        conversation.endUserId,
        conversation.status,
        conversation.channel,
        JSON.stringify([]),
        conversation.createdAt,
      ],
    );
    return conversation;
  }

  async getConversation(tenantId: string, id: string): Promise<Conversation | null> {
    const { rows } = await this.handle.query(
      `SELECT * FROM sc_conversations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return toConversation(rows[0]);
  }

  async setConversationStatus(id: string, status: ConversationStatus): Promise<void> {
    await this.handle.query(
      `UPDATE sc_conversations
          SET status = $2,
              resolved_at = CASE WHEN $2 = 'resolved' THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END
        WHERE id = $1`,
      [id, status],
    );
  }

  async assignConversation(id: string, agentId: string | null): Promise<void> {
    await this.handle.query(
      `UPDATE sc_conversations SET assigned_agent_id = $2 WHERE id = $1`,
      [id, agentId],
    );
  }

  async listConversations(
    tenantId: string,
    filter: ConversationFilter,
  ): Promise<Page<Conversation>> {
    const clauses = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    const next = () => `$${params.length + 1}`;

    if (filter.status) {
      clauses.push(`status = ${next()}`);
      params.push(filter.status);
    }
    if (filter.agentId) {
      clauses.push(`assigned_agent_id = ${next()}`);
      params.push(filter.agentId);
    }
    if (filter.cursor) {
      clauses.push(`id > ${next()}`);
      params.push(filter.cursor);
    }
    const limitPlaceholder = next();
    params.push(filter.limit + 1);

    const { rows } = await this.handle.query(
      `SELECT * FROM sc_conversations
        WHERE ${clauses.join(" AND ")}
        ORDER BY id ASC
        LIMIT ${limitPlaceholder}`,
      params,
    );

    const items = rows.slice(0, filter.limit).map((row) => toConversation(row) as Conversation);
    return {
      items,
      nextCursor: rows.length > filter.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async appendMessage(input: NewMessage): Promise<Message> {
    if (input.clientMessageId) {
      const { rows } = await this.handle.query(
        `SELECT * FROM sc_messages WHERE conversation_id = $1 AND client_message_id = $2`,
        [input.conversationId, input.clientMessageId],
      );
      if (rows[0]) return toMessage(rows[0]) as Message;
    }

    // A checked-out client, not the pool. Issuing BEGIN through the pool is the
    // classic Postgres bug: each statement can land on a different connection,
    // so the transaction silently covers nothing.
    const client = await this.handle.connect();
    try {
      await client.query("BEGIN");

      // Row lock on the conversation serialises appends to this conversation
      // only. Without it two writers read the same head sequence and one insert
      // is rejected by the unique index, or worse, both claim the same number.
      await client.query(`SELECT id FROM sc_conversations WHERE id = $1 FOR UPDATE`, [
        input.conversationId,
      ]);

      if (input.clientMessageId) {
        const { rows } = await client.query(
          `SELECT * FROM sc_messages WHERE conversation_id = $1 AND client_message_id = $2`,
          [input.conversationId, input.clientMessageId],
        );
        if (rows[0]) {
          await client.query("COMMIT");
          return toMessage(rows[0]) as Message;
        }
      }

      const head = await client.query(
        `SELECT COALESCE(MAX(seq), 0) AS head FROM sc_messages WHERE conversation_id = $1`,
        [input.conversationId],
      );
      const seq = Number(head.rows[0]?.head ?? 0) + 1;

      const message: Message = {
        id: input.id ?? newMessageId(),
        conversationId: input.conversationId,
        tenantId: input.tenantId,
        seq,
        senderType: input.senderType,
        senderId: input.senderId,
        body: input.body,
        bodyEncrypted: null,
        contentType: input.contentType ?? "text/plain",
        clientMessageId: input.clientMessageId ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
      };

      await client.query(
        `INSERT INTO sc_messages
           (id, conversation_id, tenant_id, seq, sender_type, sender_id, body, body_encrypted,
            content_type, client_message_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
        [
          message.id,
          message.conversationId,
          message.tenantId,
          message.seq,
          message.senderType,
          message.senderId,
          message.body,
          message.contentType,
          message.clientMessageId,
          JSON.stringify(message.metadata),
          message.createdAt,
        ],
      );
      await client.query(
        `UPDATE sc_conversations SET last_seq = $2, last_message_at = $3 WHERE id = $1`,
        [message.conversationId, message.seq, message.createdAt],
      );
      await client.query("COMMIT");
      return message;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listMessages(
    conversationId: string,
    options: { afterSeq?: number; limit: number },
  ): Promise<Message[]> {
    const { rows } = await this.handle.query(
      `SELECT * FROM sc_messages
        WHERE conversation_id = $1 AND seq > $2
        ORDER BY seq ASC
        LIMIT $3`,
      [conversationId, options.afterSeq ?? 0, options.limit],
    );
    return rows.map((row) => toMessage(row) as Message);
  }

  async appendEvent(event: Omit<ConversationEvent, "id" | "createdAt">): Promise<void> {
    await this.handle.query(
      `INSERT INTO sc_events
         (id, conversation_id, tenant_id, type, actor_type, actor_id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newEventId(),
        event.conversationId,
        event.tenantId,
        event.type,
        event.actor.type,
        event.actor.id,
        JSON.stringify(event.payload),
        new Date().toISOString(),
      ],
    );
  }

  async listEvents(conversationId: string): Promise<ConversationEvent[]> {
    const { rows } = await this.handle.query(
      `SELECT * FROM sc_events WHERE conversation_id = $1 ORDER BY id ASC`,
      [conversationId],
    );
    return rows.map(toEvent);
  }
}

/* ---------- row mapping ---------- */

const str = (value: unknown): string => String(value);
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Timestamps are TIMESTAMPTZ in Postgres and come back as Date objects, while
 * the rest of the system passes ISO strings. Normalising here keeps every
 * adapter returning the same shape, which is what the conformance suite checks.
 */
const stamp = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

/** JSONB comes back parsed; TEXT would not. Accept both. */
const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
};

function toTenant(row: Record<string, unknown> | undefined): Tenant | null {
  if (!row) return null;
  return {
    id: str(row.id),
    name: str(row.name),
    publishableKey: str(row.publishable_key),
    settings: json(row.settings, {}),
    createdAt: stamp(row.created_at) ?? new Date(0).toISOString(),
  };
}

function toEndUser(row: Record<string, unknown>): EndUser {
  return {
    id: str(row.id),
    tenantId: str(row.tenant_id),
    externalId: nullable(row.external_id),
    isAnonymous: Boolean(row.is_anonymous),
    displayName: nullable(row.display_name),
    email: nullable(row.email),
    attributes: json(row.attributes, {}),
    createdAt: stamp(row.created_at) ?? new Date(0).toISOString(),
  };
}

function toAgent(row: Record<string, unknown> | undefined): AgentRecord | null {
  if (!row) return null;
  return {
    id: str(row.id),
    tenantId: str(row.tenant_id),
    externalId: str(row.external_id),
    displayName: str(row.display_name),
    avatarUrl: nullable(row.avatar_url),
    skills: json<string[]>(row.skills, []),
    maxConcurrent: Number(row.max_concurrent),
    role: str(row.role) === "admin" ? "admin" : "agent",
    createdAt: stamp(row.created_at) ?? new Date(0).toISOString(),
  };
}

function toConversation(row: Record<string, unknown> | undefined): Conversation | null {
  if (!row) return null;
  return {
    id: str(row.id),
    tenantId: str(row.tenant_id),
    endUserId: str(row.end_user_id),
    status: str(row.status) as ConversationStatus,
    assignedAgentId: nullable(row.assigned_agent_id),
    channel: str(row.channel) as Conversation["channel"],
    subject: nullable(row.subject),
    tags: json<string[]>(row.tags, []),
    lastSeq: Number(row.last_seq),
    lastMessageAt: stamp(row.last_message_at),
    createdAt: stamp(row.created_at) ?? new Date(0).toISOString(),
    resolvedAt: stamp(row.resolved_at),
  };
}

function toMessage(row: Record<string, unknown> | undefined): Message | null {
  if (!row) return null;
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    tenantId: str(row.tenant_id),
    seq: Number(row.seq),
    senderType: str(row.sender_type) as Message["senderType"],
    senderId: nullable(row.sender_id),
    body: nullable(row.body),
    bodyEncrypted: nullable(row.body_encrypted),
    contentType: str(row.content_type) as Message["contentType"],
    clientMessageId: nullable(row.client_message_id),
    metadata: json(row.metadata, {}),
    createdAt: stamp(row.created_at) ?? new Date(0).toISOString(),
  };
}

function toEvent(row: Record<string, unknown>): ConversationEvent {
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    tenantId: str(row.tenant_id),
    type: str(row.type) as ConversationEvent["type"],
    actor: {
      type: str(row.actor_type) as ConversationEvent["actor"]["type"],
      id: nullable(row.actor_id),
    },
    payload: json(row.payload, {}),
    createdAt: stamp(row.created_at) ?? new Date(0).toISOString(),
  };
}
