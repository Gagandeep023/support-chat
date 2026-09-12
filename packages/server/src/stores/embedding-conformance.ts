import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "@gagandeep023/support-chat-core";

export interface EmbeddingConformanceHarness {
  provider: EmbeddingProvider;
  dispose?(): Promise<void>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Contract every EmbeddingProvider must satisfy.
 *
 * Deliberately about the contract, not about quality. Semantic ability is a
 * property of the model and belongs in an eval against real documents; what a
 * shared suite can enforce is that a provider returns the right number of
 * vectors, of the declared length, in the order it was given them. Every one of
 * those, broken, produces retrieval that is silently wrong rather than loud.
 */
export function describeEmbeddingProvider(
  name: string,
  createHarness: () => Promise<EmbeddingConformanceHarness> | EmbeddingConformanceHarness,
  // A local model loads weights from disk, and downloads them on a cold start,
  // which is far beyond any sensible default for a unit test.
  options: { timeoutMs?: number } = {},
): void {
  const timeout = options.timeoutMs ?? 5_000;
  describe(`EmbeddingProvider conformance: ${name}`, () => {
    const withProvider = async (
      body: (provider: EmbeddingProvider) => Promise<void>,
    ): Promise<void> => {
      const harness = await createHarness();
      try {
        await body(harness.provider);
      } finally {
        await harness.dispose?.();
      }
    };

    it("declares a positive dimension count", async () => {
      await withProvider(async (provider) => {
        expect(provider.dimensions).toBeGreaterThan(0);
        expect(Number.isInteger(provider.dimensions)).toBe(true);
      });
    }, timeout);

    it("names the model it used, for the reindex check", async () => {
      // Recorded on every chunk. A mismatch against the configured provider has
      // to be a hard error, which is only possible if the name is stable.
      await withProvider(async (provider) => {
        expect(provider.model.length).toBeGreaterThan(0);
      });
    }, timeout);

    it("returns one vector per input, of the declared length", async () => {
      await withProvider(async (provider) => {
        const vectors = await provider.embed(["refunds take 14 days", "charging stopped"]);
        expect(vectors).toHaveLength(2);
        for (const vector of vectors) expect(vector).toHaveLength(provider.dimensions);
      });
    }, timeout);

    it("keeps input order", async () => {
      // Vectors are zipped back onto chunks by position. Reordering here silently
      // attaches every embedding to the wrong text.
      await withProvider(async (provider) => {
        const [a, b] = await provider.embed(["alpha alpha alpha", "zulu zulu zulu"]);
        const [justA] = await provider.embed(["alpha alpha alpha"]);
        expect(cosine(a as number[], justA as number[])).toBeCloseTo(1, 3);
        expect(cosine(b as number[], justA as number[])).toBeLessThan(0.99);
      });
    }, timeout);

    it("is deterministic", async () => {
      // Re-ingesting unchanged content must not churn the index.
      await withProvider(async (provider) => {
        const [first] = await provider.embed(["refunds take 14 working days"]);
        const [second] = await provider.embed(["refunds take 14 working days"]);
        expect(cosine(first as number[], second as number[])).toBeCloseTo(1, 5);
      });
    }, timeout);

    it("separates unrelated texts", async () => {
      await withProvider(async (provider) => {
        const [a, b] = await provider.embed([
          "refunds are issued within 14 working days",
          "error E4021 means the cable was unplugged",
        ]);
        expect(cosine(a as number[], b as number[])).toBeLessThan(0.95);
      });
    }, timeout);

    it("handles an empty batch without calling out", async () => {
      await withProvider(async (provider) => {
        expect(await provider.embed([])).toEqual([]);
      });
    }, timeout);

    it("handles an empty string without throwing", async () => {
      // Chunking can produce one from a heading with no body underneath.
      await withProvider(async (provider) => {
        const [vector] = await provider.embed([""]);
        expect(vector).toHaveLength(provider.dimensions);
      });
    }, timeout);

    it("handles a batch larger than any internal chunking", async () => {
      await withProvider(async (provider) => {
        const texts = Array.from({ length: 40 }, (_, i) => `chunk number ${i}`);
        const vectors = await provider.embed(texts);
        expect(vectors).toHaveLength(40);
        expect(vectors.every((v) => v.length === provider.dimensions)).toBe(true);
      });
    }, timeout);

    it("returns finite numbers", async () => {
      // A NaN propagates into cosine similarity and poisons every comparison
      // against that chunk, forever, with no error anywhere.
      await withProvider(async (provider) => {
        const [vector] = await provider.embed(["a normal sentence about billing"]);
        expect((vector as number[]).every(Number.isFinite)).toBe(true);
      });
      });
    }, timeout);
}
