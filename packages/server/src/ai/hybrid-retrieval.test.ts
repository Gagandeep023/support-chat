import { describe, expect, it } from "vitest";
import { KeywordIndex } from "./keyword-index.js";
import { Retriever } from "./retriever.js";
import { chunkDocument } from "./chunker.js";
import { MemoryVectorStore } from "../adapters/memory-vector-store.js";
import { LocalEmbeddingProvider } from "../embeddings/local-embedding-provider.js";
import type { VectorChunk } from "../stores/vector-store.js";

const enabled = process.env.SUPPORT_CHAT_TEST_LOCAL_EMBEDDINGS === "1";
const suite = enabled ? describe : describe.skip;

const DOC = `# Charging help

## When a session stops early

Error code E4021 means the cable was unplugged at the vehicle end. Plug it back in and
start a new session.

## Getting a refund

Refunds for a failed session are issued within 14 working days to the original payment
method. We cannot refund to a different card.

## Closing your account

You can close your account from the settings page at any time.
`;

// Shares no meaningful word with the refunds section: no "refund", no "14", no
// "working days". Lexical scoring has nothing to grip.
const PARAPHRASE = "how do I get my money back";

suite("hybrid retrieval with real embeddings", () => {
  async function build() {
    const keywords = new KeywordIndex();
    const vectors = new MemoryVectorStore();
    const embeddings = new LocalEmbeddingProvider();
    await vectors.init(embeddings.dimensions);

    const pieces = chunkDocument({ id: "d1", title: "Charging help", content: DOC });
    const embedded = await embeddings.embed(pieces.map((p) => p.text));
    const chunks: VectorChunk[] = pieces.map((piece, i) => ({
      id: `d1_${i}`,
      documentId: "d1",
      tenantId: "ten_1",
      ordinal: piece.ordinal,
      text: piece.text,
      headingPath: piece.headingPath,
      documentTitle: "Charging help",
      documentUrl: null,
      embedding: embedded[i] ?? [],
      embeddingModel: embeddings.model,
      tokenCount: piece.tokenCount,
    }));
    keywords.add(chunks);
    await vectors.upsert(chunks);
    return { keywords, vectors, embeddings };
  }

  it("keyword search alone cannot bridge the paraphrase", async () => {
    const { keywords } = await build();
    const hits = keywords.search("ten_1", PARAPHRASE, 3);
    expect(hits.some((h) => h.text.includes("14 working days"))).toBe(false);
  }, 120_000);

  it("hybrid retrieval finds the refunds section anyway", async () => {
    // This is the whole reason the vector half exists.
    const { keywords, vectors, embeddings } = await build();
    const retriever = new Retriever(vectors, keywords, embeddings);
    const result = await retriever.retrieve("ten_1", PARAPHRASE);

    expect(result.grounded).toBe(true);
    expect(result.chunks[0]?.text).toContain("14 working days");
  }, 120_000);

  it("still handles a pasted error code, which vectors are weak at", async () => {
    // The mirror case. Hybrid has to win both, or it is just one method with
    // extra steps.
    const { keywords, vectors, embeddings } = await build();
    const retriever = new Retriever(vectors, keywords, embeddings);
    const result = await retriever.retrieve("ten_1", "E4021");
    expect(result.chunks[0]?.text).toContain("E4021");
  }, 120_000);

  it("still reports ungrounded for a question the docs do not cover", async () => {
    // Semantic search will always return a nearest neighbour, so the threshold
    // has to keep doing its job or the grounding rule quietly stops firing.
    const { keywords, vectors, embeddings } = await build();
    const retriever = new Retriever(vectors, keywords, embeddings);
    const result = await retriever.retrieve("ten_1", "what is the capital of France");
    expect(result.grounded).toBe(false);
  }, 120_000);
});
