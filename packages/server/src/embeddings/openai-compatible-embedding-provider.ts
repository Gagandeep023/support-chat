import { SupportChatError, type EmbeddingProvider } from "@gagandeep023/support-chat-core";

export interface OpenAICompatibleEmbeddingOptions {
  baseUrl: string;
  model: string;
  /** Declared by the model, so the vector index can be created at the right size. */
  dimensions: number;
  apiKey?: string;
  /** Requests are split to this size. Most endpoints cap a batch. */
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Any OpenAI-compatible `/embeddings` endpoint.
 *
 * Covers OpenAI, Voyage, Jina, Together, and a locally run text-embeddings
 * server such as Ollama or TEI, in one implementation using fetch and no SDK.
 * That last case is the interesting one: it gives semantic retrieval with no API
 * bill and no 300MB dependency in this package, at the cost of running one more
 * container.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.batchSize = options.batchSize ?? 96;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      // Some endpoints reject an empty string outright, so it is sent as a
      // single space. A chunk can be empty when a heading has no body under it.
      body: JSON.stringify({
        model: this.model,
        input: texts.map((text) => (text.length === 0 ? " " : text)),
      }),
    });

    if (!response.ok) {
      throw new SupportChatError(
        "provider_unavailable",
        `Embedding provider returned ${response.status}.`,
        response.status >= 500 || response.status === 429,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: unknown; index?: number }>;
    };
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new SupportChatError(
        "provider_unavailable",
        `Embedding provider returned ${data?.length ?? 0} vectors for ${texts.length} inputs.`,
      );
    }

    // Sorted by `index` before use. The API documents that responses may come
    // back out of order, and vectors are zipped onto chunks by position, so an
    // unsorted response attaches every embedding to the wrong text with nothing
    // to indicate it happened.
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    return sorted.map((entry, position) => {
      const embedding = entry.embedding;
      if (!Array.isArray(embedding)) {
        throw new SupportChatError(
          "provider_unavailable",
          `Embedding provider returned no vector at position ${position}.`,
        );
      }
      if (embedding.length !== this.dimensions) {
        throw new SupportChatError(
          "provider_incapable",
          `Model ${this.model} returned ${embedding.length}-dimension vectors but was ` +
            `configured for ${this.dimensions}. Fix the configuration and reindex.`,
        );
      }
      return embedding as number[];
    });
  }
}
