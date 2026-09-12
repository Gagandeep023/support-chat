import { describeDataStore } from "../stores/conformance.js";
import { SqliteDataStore } from "./sqlite-data-store.js";

describeDataStore("sqlite", () => {
  const store = new SqliteDataStore({ location: ":memory:" });
  return {
    store,
    seedTenant: (tenant) => store.seedTenant(tenant),
    dispose: () => store.close(),
  };
});
