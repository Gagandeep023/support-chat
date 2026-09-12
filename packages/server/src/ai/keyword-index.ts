import type { RetrievedChunk } from "@gagandeep023/support-chat-core";
import type { VectorChunk } from "../stores/vector-store.js";

interface Posting {
  chunkId: string;
  termFrequency: number;
}

const K1 = 1.5;
const B = 0.75;

/**
 * Dropped before scoring.
 *
 * BM25's IDF is supposed to discount common words, but a knowledge base is a few
 * hundred chunks, not a web corpus, and with that few documents the discount is
 * too weak: "what is the capital of France" otherwise scores against a charging
 * manual purely on "is", "the", and "of", and the bot answers a question it has
 * nothing about. Removing them is what makes the empty-retrieval path fire when
 * it should.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "that", "this",
  "have", "has", "was", "were", "can", "will", "would", "there", "their", "what",
  "when", "where", "why", "how", "who", "which", "from", "into", "onto", "about",
  "does", "did", "doing", "been", "being", "its", "it's", "they", "them", "then",
  "than", "also", "just", "some", "any", "all", "get", "got", "out", "off", "our",
  "one", "two", "his", "her", "him", "she", "hers", "please", "thanks",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * BM25 over chunk text, with no dependency and no service.
 *
 * This exists because support users do not paraphrase, they paste: error codes,
 * SKUs, version strings, exact feature names. Dense embeddings are weak on
 * precisely those rare literal tokens and strong on paraphrase, and keyword
 * search is the mirror image. Running both is what covers the actual query
 * distribution rather than the one that demos well.
 */
export class KeywordIndex {
  private readonly postings = new Map<string, Posting[]>();
  private readonly chunks = new Map<string, VectorChunk>();
  private readonly lengths = new Map<string, number>();
  private totalLength = 0;

  add(chunks: VectorChunk[]): void {
    for (const chunk of chunks) {
      this.remove(chunk.id);
      this.chunks.set(chunk.id, chunk);
      const tokens = tokenize(chunk.text);
      this.lengths.set(chunk.id, tokens.length);
      this.totalLength += tokens.length;

      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const [term, termFrequency] of counts) {
        const list = this.postings.get(term) ?? [];
        list.push({ chunkId: chunk.id, termFrequency });
        this.postings.set(term, list);
      }
    }
  }

  remove(chunkId: string): void {
    if (!this.chunks.has(chunkId)) return;
    this.totalLength -= this.lengths.get(chunkId) ?? 0;
    this.chunks.delete(chunkId);
    this.lengths.delete(chunkId);
    for (const [term, list] of this.postings) {
      const filtered = list.filter((p) => p.chunkId !== chunkId);
      if (filtered.length === 0) this.postings.delete(term);
      else this.postings.set(term, filtered);
    }
  }

  removeByDocument(tenantId: string, documentId: string): void {
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.tenantId === tenantId && chunk.documentId === documentId) {
        this.remove(chunk.id);
      }
    }
  }

  search(tenantId: string, query: string, topK: number): RetrievedChunk[] {
    const docCount = this.chunks.size;
    if (docCount === 0) return [];
    const avgLength = this.totalLength / docCount;
    const scores = new Map<string, number>();

    for (const term of new Set(tokenize(query))) {
      const list = this.postings.get(term);
      if (!list) continue;
      const relevant = list.filter((p) => this.chunks.get(p.chunkId)?.tenantId === tenantId);
      if (relevant.length === 0) continue;
      const idf = Math.log(
        1 + (docCount - relevant.length + 0.5) / (relevant.length + 0.5),
      );
      for (const posting of relevant) {
        const length = this.lengths.get(posting.chunkId) ?? 0;
        const norm = 1 - B + (B * length) / (avgLength || 1);
        const tf = (posting.termFrequency * (K1 + 1)) / (posting.termFrequency + K1 * norm);
        scores.set(posting.chunkId, (scores.get(posting.chunkId) ?? 0) + idf * tf);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .flatMap(([chunkId, score]) => {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) return [];
        return [
          {
            id: chunk.id,
            documentId: chunk.documentId,
            tenantId: chunk.tenantId,
            ordinal: chunk.ordinal,
            text: chunk.text,
            headingPath: chunk.headingPath,
            embeddingModel: chunk.embeddingModel,
            tokenCount: chunk.tokenCount,
            score,
            documentTitle: chunk.documentTitle,
            documentUrl: chunk.documentUrl,
          } satisfies RetrievedChunk,
        ];
      });
  }
}
