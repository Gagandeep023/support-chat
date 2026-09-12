import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgVectorStore } from "./pgvector-store.js";
import type { VectorChunk } from "../stores/vector-store.js";

const url = process.env.SUPPORT_CHAT_TEST_DATABASE_URL ?? "";
const suite = url ? describe : describe.skip;

function chunk(id: string, tenantId: string, embedding: number[]): VectorChunk {
  return {
    id,
    documentId: `doc_${tenantId}`,
    tenantId,
    ordinal: 0,
    text: `chunk ${id}`,
    headingPath: ["Help"],
    documentTitle: "Help",
    documentUrl: null,
    embedding,
    embeddingModel: "test-4d",
    tokenCount: 4,
  };
}

/**
 * The case a small conformance suite cannot reach.
 *
 * A tenant with two chunks, sharing a table with thirty thousand belonging to
 * somebody else, all of which sit closer to the query. With a single HNSW index
 * across every tenant this returns nothing at all, because the filter runs after
 * the approximate scan. Retrieval comes back empty, the bot correctly says it
 * does not know, and it does that for every question asked by the customers with
 * the least data, which is every new customer.
 */
suite("pgvector with a small tenant in a large table", () => {
  const table = `sc_scale_${Math.random().toString(36).slice(2, 8)}`;
  let store: PgVectorStore;

  beforeEach(async () => {
    store = new PgVectorStore({ connectionString: url, table });
    await store.init(4);

    const crowd: VectorChunk[] = [];
    for (let i = 0; i < 2000; i += 1) {
      crowd.push(chunk(`big_${i}`, "ten_big", [0.99 + Math.random() * 0.01, Math.random() * 0.02, 0, 0]));
    }
    await store.upsert(crowd);
    await store.upsert([
      chunk("small_1", "ten_small", [0, 0, 0, 1]),
      chunk("small_2", "ten_small", [0, 0, 0.1, 0.9]),
    ]);
  });

  afterEach(async () => {
    const pool = (store as unknown as { pool: { query(t: string): Promise<unknown> } | null }).pool;
    await pool?.query(`DROP TABLE IF EXISTS ${table}`);
    await store.close();
  });

  it("still returns the small tenant's chunks", async () => {
    const hits = await store.search("ten_small", [1, 0, 0, 0], { topK: 8 });
    expect(hits.map((h) => h.id).sort()).toEqual(["small_1", "small_2"]);
  });

  it("does not leak the crowded tenant's chunks into those results", async () => {
    const hits = await store.search("ten_small", [1, 0, 0, 0], { topK: 8 });
    expect(hits.every((h) => h.tenantId === "ten_small")).toBe(true);
  });

  it("still finds the crowded tenant's nearest chunk", async () => {
    const hits = await store.search("ten_big", [1, 0, 0, 0], { topK: 5 });
    expect(hits).toHaveLength(5);
    expect(hits[0]?.score ?? 0).toBeGreaterThan(0.99);
  });
});
