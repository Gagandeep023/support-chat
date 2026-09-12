import { describeEmbeddingProvider } from "../stores/embedding-conformance.js";
import { HashedEmbeddingProvider } from "./hashed-embedding-provider.js";

describeEmbeddingProvider("hashed", () => ({
  provider: new HashedEmbeddingProvider(),
}));
