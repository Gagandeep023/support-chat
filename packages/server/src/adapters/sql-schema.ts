/**
 * Shared table shape for the SQL adapters.
 *
 * Kept in one place so SQLite and Postgres cannot drift structurally; only the
 * type names and placeholder syntax differ between them, and those are the two
 * things each adapter substitutes.
 */
export interface SqlDialect {
  /** Text used for JSON columns: `TEXT` on SQLite, `JSONB` on Postgres. */
  json: string;
  /** Timestamps are stored as ISO strings so both adapters round-trip identically. */
  timestamp: string;
  boolean: string;
}

export function schemaStatements(dialect: SqlDialect): string[] {
  const { json, timestamp, boolean } = dialect;
  return [
    `CREATE TABLE IF NOT EXISTS sc_tenants (
       id               TEXT PRIMARY KEY,
       name             TEXT NOT NULL,
       publishable_key  TEXT NOT NULL UNIQUE,
       settings         ${json} NOT NULL,
       created_at       ${timestamp} NOT NULL
     )`,

    `CREATE TABLE IF NOT EXISTS sc_end_users (
       id            TEXT PRIMARY KEY,
       tenant_id     TEXT NOT NULL,
       external_id   TEXT,
       is_anonymous  ${boolean} NOT NULL,
       display_name  TEXT,
       email         TEXT,
       attributes    ${json} NOT NULL,
       created_at    ${timestamp} NOT NULL
     )`,
    // Partial, so every anonymous visitor still gets their own row. A plain
    // unique index would collapse them and show strangers each other's chats.
    `CREATE UNIQUE INDEX IF NOT EXISTS sc_end_users_external
       ON sc_end_users (tenant_id, external_id) WHERE external_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS sc_agents (
       id             TEXT PRIMARY KEY,
       tenant_id      TEXT NOT NULL,
       external_id    TEXT NOT NULL,
       display_name   TEXT NOT NULL,
       avatar_url     TEXT,
       skills         ${json} NOT NULL,
       max_concurrent INTEGER NOT NULL,
       role           TEXT NOT NULL,
       created_at     ${timestamp} NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sc_agents_external
       ON sc_agents (tenant_id, external_id)`,

    `CREATE TABLE IF NOT EXISTS sc_conversations (
       id                TEXT PRIMARY KEY,
       tenant_id         TEXT NOT NULL,
       end_user_id       TEXT NOT NULL,
       status            TEXT NOT NULL,
       assigned_agent_id TEXT,
       channel           TEXT NOT NULL,
       subject           TEXT,
       tags              ${json} NOT NULL,
       last_seq          INTEGER NOT NULL DEFAULT 0,
       last_message_at   ${timestamp},
       created_at        ${timestamp} NOT NULL,
       resolved_at       ${timestamp}
     )`,
    `CREATE INDEX IF NOT EXISTS sc_conversations_tenant
       ON sc_conversations (tenant_id, id)`,
    `CREATE INDEX IF NOT EXISTS sc_conversations_status
       ON sc_conversations (tenant_id, status, id)`,

    `CREATE TABLE IF NOT EXISTS sc_messages (
       id                TEXT PRIMARY KEY,
       conversation_id   TEXT NOT NULL,
       tenant_id         TEXT NOT NULL,
       seq               INTEGER NOT NULL,
       sender_type       TEXT NOT NULL,
       sender_id         TEXT,
       body              TEXT,
       body_encrypted    TEXT,
       content_type      TEXT NOT NULL,
       client_message_id TEXT,
       metadata          ${json} NOT NULL,
       created_at        ${timestamp} NOT NULL
     )`,
    // The constraint that makes sequence assignment correct under concurrency:
    // two writers that read the same lastSeq cannot both commit.
    `CREATE UNIQUE INDEX IF NOT EXISTS sc_messages_seq
       ON sc_messages (conversation_id, seq)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sc_messages_client_id
       ON sc_messages (conversation_id, client_message_id)
       WHERE client_message_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS sc_events (
       id              TEXT PRIMARY KEY,
       conversation_id TEXT NOT NULL,
       tenant_id       TEXT NOT NULL,
       type            TEXT NOT NULL,
       actor_type      TEXT NOT NULL,
       actor_id        TEXT,
       payload         ${json} NOT NULL,
       created_at      ${timestamp} NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS sc_events_conversation
       ON sc_events (conversation_id, id)`,
  ];
}
