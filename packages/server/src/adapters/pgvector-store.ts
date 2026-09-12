import type { RetrievedChunk } from "@gagandeep023/support-chat-core";
import type { VectorChunk, VectorStore } from "../stores/vector-store.js";

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface Pool {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

export interface PgVectorOptions {
  connectionString?: string;
  /** Share the application's existing pool rather than opening another. */
  pool?: Pool;
  table?: string;
  /**
   * How vector search is indexed. Defaults to `exact`.
   *
   * `exact`       no vector index; every search scans this tenant's rows.
   * `per-tenant`  a partial HNSW index per tenant, created on first write.
   *
   * There is deliberately no option for a single HNSW index across all tenants,
   * because it is silently wrong here. See the note on `index` below.
   */
  index?: "exact" | "per-tenant";
}

/**
 * pgvector VectorStore.
 *
 * The reason the vector interface is separate from the DataStore: a customer
 * already on Postgres gets retrieval with no new service to run, while a Mongo
 * or MySQL install brings Qdrant, and neither choice leaks into the relational
 * interface.
 */
export class PgVectorStore implements VectorStore {
  private pool: Pool | null;
  private readonly ownsPool: boolean;
  private readonly connectionString: string | undefined;
  private readonly table: string;
  private readonly index: "exact" | "per-tenant";
  private readonly indexedTenants = new Set<string>();
  private dimensions: number | null = null;

  constructor(options: PgVectorOptions = {}) {
    this.pool = options.pool ?? null;
    this.ownsPool = !options.pool;
    this.connectionString = options.connectionString ?? process.env.DATABASE_URL;
    this.table = options.table ?? "sc_chunks";
    this.index = options.index ?? "exact";
  }

  private get handle(): Pool {
    if (!this.pool) throw new Error("support-chat: PgVectorStore.init() was never awaited.");
    return this.pool;
  }

  async init(dimensions: number): Promise<void> {
    if (!this.pool) {
      let PoolCtor: new (config: Record<string, unknown>) => Pool;
      try {
        ({ Pool: PoolCtor } = (await import("pg")) as unknown as {
          Pool: new (config: Record<string, unknown>) => Pool;
        });
      } catch {
        throw new Error("support-chat: the pgvector store needs the `pg` package.");
      }
      if (!this.connectionString) {
        throw new Error("support-chat: PgVectorStore needs a connectionString or DATABASE_URL.");
      }
      this.pool = new PoolCtor({ connectionString: this.connectionString });
    }

    try {
      await this.handle.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    } catch (error) {
      throw new Error(
        "support-chat: the pgvector extension is not installed on this server. " +
          "Install it and run `CREATE EXTENSION vector` as a superuser. " +
          (error instanceof Error ? error.message : ""),
      );
    }

    // The dimension is part of the column type, so an existing table already
    // decides it. Compare before touching anything: vectors from different
    // embedding models are not comparable and usually differ in length, so
    // accepting a change here turns retrieval into noise with nothing in the
    // logs to explain it.
    const existing = await this.currentDimensions();
    if (existing !== null && existing !== dimensions) {
      throw new Error(
        `support-chat: this index stores ${existing}-dimension vectors but the configured ` +
          `embedding model produces ${dimensions}. Vectors from different models are not ` +
          `comparable; reindex your documents instead of switching in place.`,
      );
    }

    await this.handle.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id              TEXT PRIMARY KEY,
         document_id     TEXT NOT NULL,
         tenant_id       TEXT NOT NULL,
         ordinal         INTEGER NOT NULL,
         text            TEXT NOT NULL,
         heading_path    JSONB NOT NULL,
         document_title  TEXT NOT NULL,
         document_url    TEXT,
         embedding_model TEXT NOT NULL,
         token_count     INTEGER NOT NULL,
         embedding       vector(${dimensions}) NOT NULL
       )`,
    );
    await this.handle.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_document
         ON ${this.table} (tenant_id, document_id)`,
    );

    this.dimensions = dimensions;
  }

  private async currentDimensions(): Promise<number | null> {
    const { rows } = await this.handle.query(
      `SELECT a.atttypmod AS dimensions
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = $1 AND a.attname = 'embedding' AND a.attnum > 0`,
      [this.table],
    );
    const value = rows[0]?.dimensions;
    return value === undefined || value === null || Number(value) < 0 ? null : Number(value);
  }

  /**
   * Why there is no single HNSW index across tenants.
   *
   * `WHERE tenant_id = $1` is applied *after* the approximate scan, not during
   * it. The index returns its nearest candidates across every tenant, the filter
   * then removes the ones that belong to somebody else, and a tenant whose
   * chunks happen to sit away from the query direction gets nothing back at all.
   * Measured on a 30k-row table with a two-chunk tenant: a global HNSW index
   * returned zero rows, a per-tenant partial index returned both, and so did an
   * exact scan. `hnsw.iterative_scan` did not rescue it.
   *
   * The failure mode is the worst shape available: retrieval comes back empty,
   * the grounding rule correctly makes the bot say it does not know, and it does
   * that for every question, for exactly the customers with the least data,
   * which is every new customer.
   *
   * So the default is an exact scan. A knowledge base is hundreds to low
   * thousands of chunks per tenant; exact search over that is sub-millisecond,
   * and the approximation buys nothing worth a correctness cliff. `per-tenant`
   * exists for anyone who genuinely outgrows that.
   */
  private async ensureTenantIndex(tenantId: string): Promise<void> {
    if (this.index !== "per-tenant" || this.indexedTenants.has(tenantId)) return;
    // HNSW rather than IVFFlat: no training step, so it works on an index that
    // starts empty and grows, which is what a documentation site does. The ops
    // class must match the operator used at query time or the index is ignored.
    const safe = tenantId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
    await this.handle.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_hnsw_${safe}
         ON ${this.table} USING hnsw (embedding vector_cosine_ops)
       WHERE tenant_id = '${tenantId.replace(/'/g, "''")}'`,
    );
    this.indexedTenants.add(tenantId);
  }

  async upsert(chunks: VectorChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    for (const tenantId of new Set(chunks.map((c) => c.tenantId))) {
      await this.ensureTenantIndex(tenantId);
    }
    for (const chunk of chunks) {
      if (this.dimensions !== null && chunk.embedding.length !== this.dimensions) {
        throw new Error(
          `support-chat: chunk ${chunk.id} has ${chunk.embedding.length} dimensions, ` +
            `but this index stores ${this.dimensions}.`,
        );
      }
      await this.handle.query(
        `INSERT INTO ${this.table}
           (id, document_id, tenant_id, ordinal, text, heading_path, document_title,
            document_url, embedding_model, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
         ON CONFLICT (id) DO UPDATE SET
           document_id = EXCLUDED.document_id,
           tenant_id = EXCLUDED.tenant_id,
           ordinal = EXCLUDED.ordinal,
           text = EXCLUDED.text,
           heading_path = EXCLUDED.heading_path,
           document_title = EXCLUDED.document_title,
           document_url = EXCLUDED.document_url,
           embedding_model = EXCLUDED.embedding_model,
           token_count = EXCLUDED.token_count,
           embedding = EXCLUDED.embedding`,
        [
          chunk.id,
          chunk.documentId,
          chunk.tenantId,
          chunk.ordinal,
          chunk.text,
          JSON.stringify(chunk.headingPath),
          chunk.documentTitle,
          chunk.documentUrl,
          chunk.embeddingModel,
          chunk.tokenCount,
          toVectorLiteral(chunk.embedding),
        ],
      );
    }
  }

  async search(
    tenantId: string,
    embedding: number[],
    options: { topK: number },
  ): Promise<RetrievedChunk[]> {
    const { rows } = await this.handle.query(
      // ORDER BY the distance operator, not by the computed score: a vector index
      // is only used for the operator form, and ordering by an alias falls back
      // to a sequential scan.
      //
      // The score itself is 1 minus cosine distance, so it is a similarity on
      // the same scale as every other store. Returning the raw distance would
      // invert every threshold in the retriever.
      `SELECT id, document_id, tenant_id, ordinal, text, heading_path, document_title,
              document_url, embedding_model, token_count,
              1 - (embedding <=> $1::vector) AS score
         FROM ${this.table}
        WHERE tenant_id = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [toVectorLiteral(embedding), tenantId, options.topK],
    );
    return rows.map(toRetrievedChunk);
  }

  async deleteByDocument(tenantId: string, documentId: string): Promise<void> {
    await this.handle.query(
      `DELETE FROM ${this.table} WHERE tenant_id = $1 AND document_id = $2`,
      [tenantId, documentId],
    );
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool?.end();
    this.pool = null;
  }
}

/** pgvector's text input format: `[1,2,3]`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function toRetrievedChunk(row: Record<string, unknown>): RetrievedChunk {
  const headingPath = row.heading_path;
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    tenantId: String(row.tenant_id),
    ordinal: Number(row.ordinal),
    text: String(row.text),
    headingPath: Array.isArray(headingPath)
      ? (headingPath as string[])
      : typeof headingPath === "string"
        ? (JSON.parse(headingPath) as string[])
        : [],
    embeddingModel: String(row.embedding_model),
    tokenCount: Number(row.token_count),
    score: Number(row.score),
    documentTitle: String(row.document_title),
    documentUrl: row.document_url === null ? null : String(row.document_url),
  };
}
