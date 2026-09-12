import type { RetrievedChunk } from "@gagandeep023/support-chat-core";
import type { VectorChunk, VectorStore } from "../stores/vector-store.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Brute-force cosine search.
 *
 * Linear in the number of chunks, which sounds bad and is not: a documentation
 * site is a few thousand chunks, and a few thousand dot products is well under a
 * millisecond. It covers the majority of real deployments and makes
 * `support-chat dev` work with no vector service at all.
 */
export class MemoryVectorStore implements VectorStore {
  private readonly chunks = new Map<string, VectorChunk>();
  private dimensions: number | null = null;

  async init(dimensions: number): Promise<void> {
    if (this.dimensions !== null && this.dimensions !== dimensions) {
      throw new Error(
        `support-chat: this index was built with ${this.dimensions}-dimension vectors ` +
          `but the configured embedding model produces ${dimensions}. Vectors from ` +
          `different models are not comparable; reindex instead of switching in place.`,
      );
    }
    this.dimensions = dimensions;
  }

  async upsert(chunks: VectorChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk);
  }

  async search(
    tenantId: string,
    embedding: number[],
    options: { topK: number },
  ): Promise<RetrievedChunk[]> {
    const scored: RetrievedChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.tenantId !== tenantId) continue;
      scored.push({
        id: chunk.id,
        documentId: chunk.documentId,
        tenantId: chunk.tenantId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        headingPath: chunk.headingPath,
        embeddingModel: chunk.embeddingModel,
        tokenCount: chunk.tokenCount,
        score: cosine(embedding, chunk.embedding),
        documentTitle: chunk.documentTitle,
        documentUrl: chunk.documentUrl,
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, options.topK);
  }

  async deleteByDocument(tenantId: string, documentId: string): Promise<void> {
    // Cascading deletes matter more here than anywhere else in the system: an
    // orphaned vector means the bot confidently quotes a policy the customer
    // deleted last month.
    for (const [id, chunk] of this.chunks) {
      if (chunk.tenantId === tenantId && chunk.documentId === documentId) {
        this.chunks.delete(id);
      }
    }
  }

  async close(): Promise<void> {
    this.chunks.clear();
  }
}
