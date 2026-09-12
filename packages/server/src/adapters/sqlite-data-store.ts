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
import { createRequire } from "node:module";
import type {
  ConversationFilter,
  DataStore,
  NewMessage,
  Page,
} from "../stores/data-store.js";
import { schemaStatements } from "./sql-schema.js";

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}

export interface SqliteOptions {
  /** File path, or ":memory:". */
  location?: string;
}

/**
 * SQLite DataStore on `node:sqlite`.
 *
 * No native module and no dependency: the driver ships with Node. That matters
 * more here than the usual driver comparison, because this adapter exists to
 * make `support-chat dev` and a small single-box deployment work with nothing
 * installed, and a package that needs a compile step at install time defeats the
 * point.
 *
 * Node prints an ExperimentalWarning for `node:sqlite` on versions before 24.
 * The API used here is the stable subset.
 */
export class SqliteDataStore implements DataStore {
  private db: SqliteDatabase | null = null;
  private readonly location: string;

  constructor(options: SqliteOptions = {}) {
    this.location = options.location ?? ":memory:";
  }

  async init(): Promise<void> {
    if (this.db) return;
    let DatabaseSync: new (path: string) => SqliteDatabase;
    try {
      // createRequire rather than a dynamic import, so a bundler cannot rewrite
      // or intercept the builtin. Several bundlers do not know `node:sqlite`
      // yet and will try to resolve it from node_modules.
      const load = createRequire(import.meta.url);
      ({ DatabaseSync } = load("node:sqlite") as {
        DatabaseSync: new (path: string) => SqliteDatabase;
      });
    } catch (error) {
      throw new Error(
        "support-chat: node:sqlite is unavailable (" +
          (error instanceof Error ? error.message : String(error)) +
          "). It requires Node 22.5 or newer; use the Postgres adapter on older runtimes.",
      );
    }
    const db = new DatabaseSync(this.location);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    for (const statement of schemaStatements({
      json: "TEXT",
      timestamp: "TEXT",
      boolean: "INTEGER",
    })) {
      db.exec(statement);
    }
    this.db = db;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private get handle(): SqliteDatabase {
    if (!this.db) throw new Error("support-chat: SqliteDataStore.init() was never awaited.");
    return this.db;
  }

  /** Direct insert, used by seeding and provisioning. */
  seedTenant(tenant: Tenant): void {
    this.handle
      .prepare(
        `INSERT INTO sc_tenants (id, name, publishable_key, settings, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      )
      .run(
        tenant.id,
        tenant.name,
        tenant.publishableKey,
        JSON.stringify(tenant.settings),
        tenant.createdAt,
      );
  }

  async getTenant(id: string): Promise<Tenant | null> {
    return toTenant(this.handle.prepare(`SELECT * FROM sc_tenants WHERE id = ?`).get(id));
  }

  async getTenantByPublishableKey(key: string): Promise<Tenant | null> {
    return toTenant(
      this.handle.prepare(`SELECT * FROM sc_tenants WHERE publishable_key = ?`).get(key),
    );
  }

  async upsertEndUser(input: {
    tenantId: string;
    externalId: string | null;
    displayName?: string | null;
    email?: string | null;
    attributes?: Record<string, unknown>;
  }): Promise<EndUser> {
    if (input.externalId !== null) {
      const existing = this.handle
        .prepare(`SELECT * FROM sc_end_users WHERE tenant_id = ? AND external_id = ?`)
        .get(input.tenantId, input.externalId);
      if (existing) return toEndUser(existing);
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
    this.handle
      .prepare(
        `INSERT INTO sc_end_users
           (id, tenant_id, external_id, is_anonymous, display_name, email, attributes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.tenantId,
        user.externalId,
        user.isAnonymous ? 1 : 0,
        user.displayName,
        user.email,
        JSON.stringify(user.attributes),
        user.createdAt,
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
    const existing = this.handle
      .prepare(`SELECT * FROM sc_agents WHERE tenant_id = ? AND external_id = ?`)
      .get(input.tenantId, input.externalId);

    if (existing) {
      const current = toAgent(existing) as AgentRecord;
      const updated: AgentRecord = {
        ...current,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? current.avatarUrl,
        skills: input.skills ?? current.skills,
        maxConcurrent: input.maxConcurrent ?? current.maxConcurrent,
        role: input.role ?? current.role,
      };
      this.handle
        .prepare(
          `UPDATE sc_agents
             SET display_name = ?, avatar_url = ?, skills = ?, max_concurrent = ?, role = ?
           WHERE id = ?`,
        )
        .run(
          updated.displayName,
          updated.avatarUrl,
          JSON.stringify(updated.skills),
          updated.maxConcurrent,
          updated.role,
          updated.id,
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
    this.handle
      .prepare(
        `INSERT INTO sc_agents
           (id, tenant_id, external_id, display_name, avatar_url, skills, max_concurrent, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.tenantId,
        agent.externalId,
        agent.displayName,
        agent.avatarUrl,
        JSON.stringify(agent.skills),
        agent.maxConcurrent,
        agent.role,
        agent.createdAt,
      );
    return agent;
  }

  async getAgent(tenantId: string, id: string): Promise<AgentRecord | null> {
    return toAgent(
      this.handle
        .prepare(`SELECT * FROM sc_agents WHERE tenant_id = ? AND id = ?`)
        .get(tenantId, id),
    );
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
    this.handle
      .prepare(
        `INSERT INTO sc_conversations
           (id, tenant_id, end_user_id, status, assigned_agent_id, channel, subject, tags,
            last_seq, last_message_at, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.tenantId,
        conversation.endUserId,
        conversation.status,
        null,
        conversation.channel,
        null,
        JSON.stringify([]),
        0,
        null,
        conversation.createdAt,
        null,
      );
    return conversation;
  }

  async getConversation(tenantId: string, id: string): Promise<Conversation | null> {
    return toConversation(
      this.handle
        .prepare(`SELECT * FROM sc_conversations WHERE tenant_id = ? AND id = ?`)
        .get(tenantId, id),
    );
  }

  async setConversationStatus(id: string, status: ConversationStatus): Promise<void> {
    this.handle
      .prepare(
        `UPDATE sc_conversations
            SET status = ?,
                resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?) ELSE resolved_at END
          WHERE id = ?`,
      )
      .run(status, status, new Date().toISOString(), id);
  }

  async assignConversation(id: string, agentId: string | null): Promise<void> {
    this.handle
      .prepare(`UPDATE sc_conversations SET assigned_agent_id = ? WHERE id = ?`)
      .run(agentId, id);
  }

  async listConversations(
    tenantId: string,
    filter: ConversationFilter,
  ): Promise<Page<Conversation>> {
    const clauses = ["tenant_id = ?"];
    const params: unknown[] = [tenantId];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.agentId) {
      clauses.push("assigned_agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.cursor) {
      clauses.push("id > ?");
      params.push(filter.cursor);
    }
    // One extra row decides whether a next page exists, without a second query.
    params.push(filter.limit + 1);

    const rows = this.handle
      .prepare(
        `SELECT * FROM sc_conversations
          WHERE ${clauses.join(" AND ")}
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(...params);

    const items = rows.slice(0, filter.limit).map((row) => toConversation(row) as Conversation);
    return {
      items,
      nextCursor: rows.length > filter.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async appendMessage(input: NewMessage): Promise<Message> {
    const db = this.handle;

    if (input.clientMessageId) {
      const existing = db
        .prepare(
          `SELECT * FROM sc_messages WHERE conversation_id = ? AND client_message_id = ?`,
        )
        .get(input.conversationId, input.clientMessageId);
      if (existing) return toMessage(existing) as Message;
    }

    const message: Message = {
      id: input.id ?? newMessageId(),
      conversationId: input.conversationId,
      tenantId: input.tenantId,
      seq: 0,
      senderType: input.senderType,
      senderId: input.senderId,
      body: input.body,
      bodyEncrypted: null,
      contentType: input.contentType ?? "text/plain",
      clientMessageId: input.clientMessageId ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };

    // Insert and advance the conversation together. This is one logical write to
    // one aggregate, so a transaction is the right tool; the unique index on
    // (conversation_id, seq) is what makes a lost update impossible rather than
    // merely unlikely.
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS head FROM sc_messages WHERE conversation_id = ?`)
        .get(input.conversationId);
      message.seq = Number(row?.head ?? 0) + 1;

      db.prepare(
        `INSERT INTO sc_messages
           (id, conversation_id, tenant_id, seq, sender_type, sender_id, body, body_encrypted,
            content_type, client_message_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        message.id,
        message.conversationId,
        message.tenantId,
        message.seq,
        message.senderType,
        message.senderId,
        message.body,
        null,
        message.contentType,
        message.clientMessageId,
        JSON.stringify(message.metadata),
        message.createdAt,
      );

      db.prepare(
        `UPDATE sc_conversations SET last_seq = ?, last_message_at = ? WHERE id = ?`,
      ).run(message.seq, message.createdAt, message.conversationId);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return message;
  }

  async listMessages(
    conversationId: string,
    options: { afterSeq?: number; limit: number },
  ): Promise<Message[]> {
    return this.handle
      .prepare(
        `SELECT * FROM sc_messages
          WHERE conversation_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(conversationId, options.afterSeq ?? 0, options.limit)
      .map((row) => toMessage(row) as Message);
  }

  async appendEvent(event: Omit<ConversationEvent, "id" | "createdAt">): Promise<void> {
    this.handle
      .prepare(
        `INSERT INTO sc_events
           (id, conversation_id, tenant_id, type, actor_type, actor_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newEventId(),
        event.conversationId,
        event.tenantId,
        event.type,
        event.actor.type,
        event.actor.id,
        JSON.stringify(event.payload),
        new Date().toISOString(),
      );
  }

  async listEvents(conversationId: string): Promise<ConversationEvent[]> {
    return this.handle
      .prepare(`SELECT * FROM sc_events WHERE conversation_id = ? ORDER BY id ASC`)
      .all(conversationId)
      .map((row) => toEvent(row));
  }
}

/* ---------- row mapping ---------- */

const str = (value: unknown): string => String(value);
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

function toTenant(row: Record<string, unknown> | undefined): Tenant | null {
  if (!row) return null;
  return {
    id: str(row.id),
    name: str(row.name),
    publishableKey: str(row.publishable_key),
    settings: parse(row.settings, {}),
    createdAt: str(row.created_at),
  };
}

function toEndUser(row: Record<string, unknown>): EndUser {
  return {
    id: str(row.id),
    tenantId: str(row.tenant_id),
    externalId: nullable(row.external_id),
    isAnonymous: Boolean(Number(row.is_anonymous)),
    displayName: nullable(row.display_name),
    email: nullable(row.email),
    attributes: parse(row.attributes, {}),
    createdAt: str(row.created_at),
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
    skills: parse<string[]>(row.skills, []),
    maxConcurrent: Number(row.max_concurrent),
    role: str(row.role) === "admin" ? "admin" : "agent",
    createdAt: str(row.created_at),
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
    tags: parse<string[]>(row.tags, []),
    lastSeq: Number(row.last_seq),
    lastMessageAt: nullable(row.last_message_at),
    createdAt: str(row.created_at),
    resolvedAt: nullable(row.resolved_at),
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
    metadata: parse(row.metadata, {}),
    createdAt: str(row.created_at),
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
    payload: parse(row.payload, {}),
    createdAt: str(row.created_at),
  };
}
