import type { EmbeddingProvider } from "@gagandeep023/support-chat-core";
import { tokenize } from "../ai/keyword-index.js";

export interface HashedEmbeddingOptions {
  dimensions?: number;
  /** Include word pairs, so short phrases are not reduced to a bag of words. */
  bigrams?: boolean;
}

/**
 * Hashed bag-of-words embeddings, computed locally with no model and no network.
 *
 * Be precise about what this is. It is a random projection of the words in a
 * text, so it measures lexical overlap, not meaning: "refund" and "money back"
 * land nowhere near each other. It is not a substitute for a real embedding
 * model and the documentation should never imply otherwise.
 *
 * It earns its place for two jobs. It makes the vector path exercisable with no
 * download, no key, and no service, which is what `support-chat dev` needs. And
 * it is a fair floor to measure a real model against: if a hosted embedding
 * model cannot beat hashed bag-of-words on a customer's own eval set, that is
 * worth knowing before paying for it.
 *
 * The keyword index already does lexical matching better than this. Anyone
 * wanting semantic retrieval should use the local ONNX or OpenAI-compatible
 * provider instead.
 */
export class HashedEmbeddingProvider implements EmbeddingProvider {
  readonly id = "hashed";
  readonly model: string;
  readonly dimensions: number;
  private readonly bigrams: boolean;

  constructor(options: HashedEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 256;
    this.bigrams = options.bigrams ?? true;
    this.model = `hashed-bow-${this.dimensions}${this.bigrams ? "-bigram" : ""}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.project(text));
  }

  private project(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);

    const features = [...tokens];
    if (this.bigrams) {
      for (let i = 0; i + 1 < tokens.length; i += 1) {
        features.push(`${tokens[i]}_${tokens[i + 1]}`);
      }
    }

    for (const feature of features) {
      const h = hash(feature);
      const index = h % this.dimensions;
      // A sign drawn from a second hash bit, so unrelated features that collide
      // cancel on average instead of always reinforcing each other.
      vector[index] = (vector[index] ?? 0) + ((h >>> 31) & 1 ? -1 : 1);
    }

    // L2 normalise, so cosine similarity behaves and an empty text yields a
    // finite zero vector rather than NaN.
    let norm = 0;
    for (const value of vector) norm += value * value;
    if (norm === 0) return vector;
    const scale = 1 / Math.sqrt(norm);
    return vector.map((value) => value * scale);
  }
}

/** FNV-1a, 32-bit. Stable across processes and runtimes, which matters because
 *  a chunk embedded today must still match a query embedded next month. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
