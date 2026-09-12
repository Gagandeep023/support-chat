import type { EmbeddingProvider, RetrievedChunk } from "@gagandeep023/support-chat-core";
import type { VectorStore } from "../stores/vector-store.js";
import type { KeywordIndex } from "./keyword-index.js";

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /**
   * True when nothing cleared the threshold.
   *
   * A first-class outcome, not an empty string. With no grounding the model is
   * told to say it does not know and offer a human, and the turn counts toward
   * escalation. A bot that invents an answer when retrieval comes back empty is
   * worse than no bot, because users trust it and the customer's brand absorbs
   * the error.
   */
  grounded: boolean;
}

export interface RetrieverOptions {
  topK?: number;
  /** Cosine floor. Chunks below this are noise dressed as evidence. */
  minVectorScore?: number;
  minKeywordScore?: number;
}

/**
 * Hybrid retrieval: dense vectors for paraphrase, BM25 for literals, fused by
 * reciprocal rank.
 *
 * Reciprocal rank fusion rather than score addition, because cosine similarity
 * and BM25 are on unrelated scales and summing them silently lets whichever
 * scorer happens to produce bigger numbers decide every ranking.
 */
export class Retriever {
  private readonly topK: number;
  private readonly minVectorScore: number;
  private readonly minKeywordScore: number;

  constructor(
    private readonly vectors: VectorStore | null,
    private readonly keywords: KeywordIndex,
    private readonly embeddings: EmbeddingProvider | null,
    options: RetrieverOptions = {},
  ) {
    this.topK = options.topK ?? 8;
    this.minVectorScore = options.minVectorScore ?? 0.25;
    this.minKeywordScore = options.minKeywordScore ?? 0.1;
  }

  async retrieve(tenantId: string, query: string): Promise<RetrievalResult> {
    const keywordHits = this.keywords
      .search(tenantId, query, this.topK)
      .filter((chunk) => chunk.score >= this.minKeywordScore);

    let vectorHits: RetrievedChunk[] = [];
    if (this.vectors && this.embeddings) {
      const [embedding] = await this.embeddings.embed([query]);
      if (embedding) {
        vectorHits = (
          await this.vectors.search(tenantId, embedding, { topK: this.topK })
        ).filter((chunk) => chunk.score >= this.minVectorScore);
      }
    }

    const fused = fuse([vectorHits, keywordHits], this.topK);
    return { chunks: fused, grounded: fused.length > 0 };
  }
}

const RRF_K = 60;

function fuse(rankings: RetrievedChunk[][], topK: number): RetrievedChunk[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, RetrievedChunk>();

  for (const ranking of rankings) {
    ranking.forEach((chunk, index) => {
      byId.set(chunk.id, chunk);
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .flatMap(([id, score]) => {
      const chunk = byId.get(id);
      return chunk ? [{ ...chunk, score }] : [];
    });
}
