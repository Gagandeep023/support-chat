import { describe, expect, it } from "vitest";
import { SupportChatError } from "@gagandeep023/support-chat-core";
import { describeEmbeddingProvider } from "../stores/embedding-conformance.js";
import { OpenAICompatibleEmbeddingProvider } from "./openai-compatible-embedding-provider.js";

const DIMENSIONS = 8;

/** Deterministic stand-in for an embeddings endpoint, so the wire handling is
 *  exercised without a network or a key. */
function fakeFetch(
  handler?: (body: { input: string[] }) => unknown,
): { impl: typeof fetch; calls: { input: string[] }[] } {
  const calls: { input: string[] }[] = [];
  const impl = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { input: string[] };
    calls.push(body);
    const payload = handler
      ? handler(body)
      : {
          data: body.input.map((text, index) => ({
            index,
            embedding: Array.from({ length: DIMENSIONS }, (_, d) =>
              Math.sin((text.length + 1) * (d + 1)),
            ),
          })),
        };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describeEmbeddingProvider("openai-compatible", () => {
  const { impl } = fakeFetch((body) => ({
    // Word-overlap vectors, enough to satisfy the contract's similarity checks.
    data: body.input.map((text, index) => {
      const vector = new Array<number>(DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let h = 0;
        for (let i = 0; i < word.length; i += 1) h = (h * 31 + word.charCodeAt(i)) >>> 0;
        vector[h % DIMENSIONS] = (vector[h % DIMENSIONS] ?? 0) + 1;
      }
      return { index, embedding: vector };
    }),
  }));
  return {
    provider: new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://example.invalid/v1",
      model: "test-embed",
      dimensions: DIMENSIONS,
      fetchImpl: impl,
    }),
  };
});

describe("openai-compatible embeddings, wire handling", () => {
  const build = (impl: typeof fetch, batchSize?: number) =>
    new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://example.invalid/v1",
      model: "test-embed",
      dimensions: DIMENSIONS,
      fetchImpl: impl,
      ...(batchSize ? { batchSize } : {}),
    });

  it("splits a large input into batches", async () => {
    const { impl, calls } = fakeFetch();
    await build(impl, 3).embed(Array.from({ length: 7 }, (_, i) => `text ${i}`));
    expect(calls.map((c) => c.input.length)).toEqual([3, 3, 1]);
  });

  it("reorders a response that comes back out of order", async () => {
    // The API documents that results may arrive unordered, and vectors are
    // zipped onto chunks by position, so an unsorted response silently attaches
    // every embedding to the wrong text.
    const { impl } = fakeFetch((body) => ({
      data: body.input
        .map((_, index) => ({
          index,
          embedding: new Array<number>(DIMENSIONS).fill(index),
        }))
        .reverse(),
    }));
    const vectors = await build(impl).embed(["first", "second", "third"]);
    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
  });

  it("rejects a vector of the wrong length instead of indexing it", async () => {
    const { impl } = fakeFetch((body) => ({
      data: body.input.map((_, index) => ({ index, embedding: [1, 2, 3] })),
    }));
    await expect(build(impl).embed(["x"])).rejects.toThrow(/dimension|reindex/i);
  });

  it("rejects a short response rather than misaligning the rest", async () => {
    const { impl } = fakeFetch(() => ({ data: [] }));
    await expect(build(impl).embed(["a", "b"])).rejects.toThrow(SupportChatError);
  });

  it("substitutes a space for an empty string", async () => {
    // Some endpoints reject an empty input outright, and chunking can produce one
    // from a heading with no body underneath it.
    const { impl, calls } = fakeFetch();
    await build(impl).embed([""]);
    expect(calls[0]?.input).toEqual([" "]);
  });

  it("marks a 429 retryable and a 400 not", async () => {
    const status = (code: number) =>
      (async () => ({ ok: false, status: code, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(build(status(429)).embed(["x"])).rejects.toMatchObject({ retryable: true });
    await expect(build(status(400)).embed(["x"])).rejects.toMatchObject({ retryable: false });
  });
});
