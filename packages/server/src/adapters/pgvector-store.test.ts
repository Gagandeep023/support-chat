import { describe, it } from "vitest";
import { describeVectorStore } from "../stores/vector-conformance.js";
import { PgVectorStore } from "./pgvector-store.js";

const url = process.env.SUPPORT_CHAT_TEST_DATABASE_URL;

if (url) {
  describeVectorStore("pgvector", () => {
    // A table per run, so leftovers cannot make a failure look like an adapter
    // bug, and so the dimension-change test starts from a clean column type.
    const table = `sc_chunks_${Math.random().toString(36).slice(2, 10)}`;
    const store = new PgVectorStore({ connectionString: url, table });
    return {
      store,
      dispose: async () => {
        const pool = (store as unknown as { pool: { query(t: string): Promise<unknown> } | null })
          .pool;
        await pool?.query(`DROP TABLE IF EXISTS ${table}`);
        await store.close();
      },
    };
  });
} else {
  describe("VectorStore conformance: pgvector", () => {
    it.skip("needs SUPPORT_CHAT_TEST_DATABASE_URL to run", () => undefined);
  });
}
