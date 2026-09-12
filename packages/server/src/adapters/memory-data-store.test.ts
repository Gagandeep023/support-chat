import { describeDataStore } from "../stores/conformance.js";
import { MemoryDataStore } from "./memory-data-store.js";

describeDataStore("memory", () => {
  const store = new MemoryDataStore();
  return {
    store,
    seedTenant: (tenant) => void store.seedTenant(tenant),
    dispose: async () => store.close(),
  };
});
