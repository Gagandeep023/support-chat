import { describe, it } from "vitest";
import { describeDataStore } from "../stores/conformance.js";
import { PostgresDataStore } from "./postgres-data-store.js";

const url = process.env.SUPPORT_CHAT_TEST_DATABASE_URL;

if (url) {
  describeDataStore("postgres", async () => {
    const store = new PostgresDataStore({ connectionString: url });
    await store.init();
    // Fresh tables per run. The suite asserts on counts, so leftovers from a
    // previous run would make failures look like adapter bugs.
    for (const table of ["sc_events", "sc_messages", "sc_conversations", "sc_end_users", "sc_agents", "sc_tenants"]) {
      await (store as unknown as { handle: { query(t: string): Promise<unknown> } }).handle.query(
        `TRUNCATE ${table} CASCADE`,
      );
    }
    return {
      store,
      seedTenant: (tenant) => store.seedTenant(tenant),
      dispose: () => store.close(),
    };
  });
} else {
  describe("DataStore conformance: postgres", () => {
    it.skip("needs SUPPORT_CHAT_TEST_DATABASE_URL to run", () => undefined);
  });
}
