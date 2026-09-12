import { describeVectorStore } from "../stores/vector-conformance.js";
import { MemoryVectorStore } from "./memory-vector-store.js";

describeVectorStore("memory", () => {
  const store = new MemoryVectorStore();
  return { store, dispose: () => store.close() };
});
