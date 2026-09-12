import { describeCacheStore } from "../stores/cache-conformance.js";
import { MemoryCacheStore } from "./memory-cache-store.js";

describeCacheStore("memory", () => {
  const store = new MemoryCacheStore();
  return { store, dispose: () => store.close() };
});
