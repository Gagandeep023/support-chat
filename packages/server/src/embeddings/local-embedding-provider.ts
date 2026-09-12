import type { EmbeddingProvider } from "@gagandeep023/support-chat-core";

export interface LocalEmbeddingOptions {
  /** Any sentence-transformers model published with ONNX weights. */
  model?: string;
  dimensions?: number;
  batchSize?: number;
  /** Where model files are cached. Mount this in a container to avoid re-downloading. */
  cacheDir?: string;
  /** Quantised weights: a fraction of the size, with a small quality cost. */
  quantized?: boolean;
}

interface FeatureExtractionPipeline {
  (
    texts: string[],
    options: { pooling: "mean" | "cls"; normalize: boolean },
  ): Promise<{ dims: number[]; data: Float32Array | number[] }>;
}

const DEFAULTS = {
  model: "Xenova/all-MiniLM-L6-v2",
  dimensions: 384,
};

/**
 * Sentence embeddings computed in-process with ONNX, no API key and no per-token
 * cost.
 *
 * Worth being honest about the price: this needs `@huggingface/transformers`,
 * which pulls `onnxruntime-node` at roughly 300MB unpacked, and downloads model
 * weights on first use. It is therefore an optional peer dependency and not a
 * default. "Plug and play" and "300MB of native runtime" do not belong in the
 * same sentence, so nobody should get this by accident.
 *
 * Where it does win: ingestion and reindexing become free. A customer with five
 * hundred documents who re-ingests weekly otherwise pays for the same embeddings
 * over and over, and that recurring cost is what this removes.
 *
 * For semantic retrieval without the install, point
 * `OpenAICompatibleEmbeddingProvider` at a local Ollama or TEI container
 * instead: same benefit, one more service, nothing extra in this package.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = "local-onnx";
  readonly model: string;
  readonly dimensions: number;
  private readonly batchSize: number;
  private readonly options: LocalEmbeddingOptions;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(options: LocalEmbeddingOptions = {}) {
    this.model = options.model ?? DEFAULTS.model;
    this.dimensions = options.dimensions ?? DEFAULTS.dimensions;
    this.batchSize = options.batchSize ?? 32;
    this.options = options;
  }

  /** Load the model once, and only when something is actually embedded. */
  private async pipeline(): Promise<FeatureExtractionPipeline> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      let transformers: {
        pipeline: (task: string, model: string, options?: unknown) => Promise<unknown>;
        env: Record<string, unknown>;
      };
      try {
        transformers = (await import("@huggingface/transformers")) as unknown as typeof transformers;
      } catch {
        throw new Error(
          "support-chat: local embeddings need `@huggingface/transformers`. " +
            "Install it with `npm install @huggingface/transformers`, or point " +
            "OpenAICompatibleEmbeddingProvider at a local embedding server instead.",
        );
      }
      if (this.options.cacheDir) transformers.env.cacheDir = this.options.cacheDir;
      return (await transformers.pipeline("feature-extraction", this.model, {
        ...(this.options.quantized === undefined ? {} : { quantized: this.options.quantized }),
      })) as FeatureExtractionPipeline;
    })();
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.pipeline();
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      // An empty string tokenises to nothing and can produce a NaN vector, which
      // then poisons every cosine comparison against that chunk with no error.
      const safe = batch.map((text) => (text.trim().length === 0 ? " " : text));
      const result = await extract(safe, { pooling: "mean", normalize: true });
      out.push(...unpack(result, batch.length, this.dimensions));
    }
    return out;
  }
}

/** transformers.js returns one flat tensor for the whole batch. */
function unpack(
  result: { dims: number[]; data: Float32Array | number[] },
  count: number,
  dimensions: number,
): number[][] {
  const width = result.dims.at(-1) ?? dimensions;
  if (width !== dimensions) {
    throw new Error(
      `support-chat: this model produces ${width}-dimension vectors but the provider `
        + `was configured for ${dimensions}. Set the dimensions option to match, and reindex.`,
    );
  }
  const flat = Array.from(result.data as ArrayLike<number>);
  const vectors: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    vectors.push(flat.slice(i * width, (i + 1) * width));
  }
  return vectors;
}
