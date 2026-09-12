import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VectorChunk, VectorStore } from "./vector-store.js";

export interface VectorConformanceHarness {
  store: VectorStore;
  dispose(): Promise<void>;
}

const DIMENSIONS = 4;

/** Unit vectors, so expected cosine similarities are obvious by inspection. */
const VECTORS = {
  north: [1, 0, 0, 0],
  northish: [0.9, 0.1, 0, 0],
  east: [0, 1, 0, 0],
  south: [-1, 0, 0, 0],
} as const;

function chunk(overrides: Partial<VectorChunk> & { id: string; embedding: number[] }): VectorChunk {
  return {
    documentId: "doc_1",
    tenantId: "ten_1",
    ordinal: 0,
    text: "Billing > Refunds\n\nRefunds take 14 working days.",
    headingPath: ["Billing", "Refunds"],
    documentTitle: "Billing",
    documentUrl: "https://docs.example.com/billing",
    embeddingModel: "test-4d",
    tokenCount: 12,
    ...overrides,
  };
}

/**
 * One suite, run against every VectorStore.
 *
 * The score scale is the thing most likely to diverge and the easiest to get
 * wrong silently: the retriever applies a similarity threshold, so an adapter
 * that returns a distance instead of a similarity inverts the meaning of every
 * cutoff and quietly retrieves the least relevant chunks.
 */
export function describeVectorStore(
  name: string,
  createHarness: () => Promise<VectorConformanceHarness> | VectorConformanceHarness,
): void {
  describe(`VectorStore conformance: ${name}`, () => {
    let harness: VectorConformanceHarness;
    let store: VectorStore;

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
      await store.init(DIMENSIONS);
    });

    afterEach(async () => {
      await harness.dispose();
    });

    it("returns nothing from an empty index", async () => {
      expect(await store.search("ten_1", [...VECTORS.north], { topK: 5 })).toEqual([]);
    });

    it("orders by similarity, nearest first", async () => {
      await store.upsert([
        chunk({ id: "chk_east", embedding: [...VECTORS.east] }),
        chunk({ id: "chk_near", embedding: [...VECTORS.northish] }),
        chunk({ id: "chk_exact", embedding: [...VECTORS.north] }),
      ]);
      const hits = await store.search("ten_1", [...VECTORS.north], { topK: 3 });
      expect(hits.map((h) => h.id)).toEqual(["chk_exact", "chk_near", "chk_east"]);
    });

    it("scores similarity, not distance", async () => {
      // 1 for identical, 0 for orthogonal. An adapter returning distance would
      // invert every threshold in the retriever without failing anything else.
      await store.upsert([
        chunk({ id: "chk_exact", embedding: [...VECTORS.north] }),
        chunk({ id: "chk_orthogonal", embedding: [...VECTORS.east] }),
        chunk({ id: "chk_opposite", embedding: [...VECTORS.south] }),
      ]);
      const hits = await store.search("ten_1", [...VECTORS.north], { topK: 3 });
      const byId = Object.fromEntries(hits.map((h) => [h.id, h.score]));
      expect(byId.chk_exact).toBeCloseTo(1, 4);
      expect(byId.chk_orthogonal).toBeCloseTo(0, 4);
      expect(byId.chk_opposite).toBeCloseTo(-1, 4);
    });

    it("honours topK", async () => {
      await store.upsert([
        chunk({ id: "chk_1", embedding: [...VECTORS.north] }),
        chunk({ id: "chk_2", embedding: [...VECTORS.northish] }),
        chunk({ id: "chk_3", embedding: [...VECTORS.east] }),
      ]);
      expect(await store.search("ten_1", [...VECTORS.north], { topK: 2 })).toHaveLength(2);
    });

    it("never returns another tenant's chunks", async () => {
      await store.upsert([
        chunk({ id: "chk_mine", embedding: [...VECTORS.north] }),
        chunk({ id: "chk_theirs", tenantId: "ten_2", embedding: [...VECTORS.north] }),
      ]);
      const hits = await store.search("ten_1", [...VECTORS.north], { topK: 10 });
      expect(hits.map((h) => h.id)).toEqual(["chk_mine"]);
    });

    it("round-trips everything needed to cite the source", async () => {
      await store.upsert([chunk({ id: "chk_1", embedding: [...VECTORS.north] })]);
      const hit = (await store.search("ten_1", [...VECTORS.north], { topK: 1 }))[0];
      expect(hit).toMatchObject({
        id: "chk_1",
        documentId: "doc_1",
        documentTitle: "Billing",
        documentUrl: "https://docs.example.com/billing",
        headingPath: ["Billing", "Refunds"],
        embeddingModel: "test-4d",
        tokenCount: 12,
      });
      expect(hit?.text).toContain("14 working days");
    });

    it("replaces a chunk re-upserted under the same id", async () => {
      await store.upsert([chunk({ id: "chk_1", embedding: [...VECTORS.north], text: "old" })]);
      await store.upsert([chunk({ id: "chk_1", embedding: [...VECTORS.north], text: "new" })]);
      const hits = await store.search("ten_1", [...VECTORS.north], { topK: 10 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toBe("new");
    });

    it("deletes every chunk of a document and nothing else", async () => {
      // An orphaned chunk is the bot confidently quoting a policy the customer
      // deleted last month, which is among the worst failures this product has.
      await store.upsert([
        chunk({ id: "chk_a1", documentId: "doc_a", embedding: [...VECTORS.north] }),
        chunk({ id: "chk_a2", documentId: "doc_a", embedding: [...VECTORS.northish] }),
        chunk({ id: "chk_b1", documentId: "doc_b", embedding: [...VECTORS.north] }),
      ]);
      await store.deleteByDocument("ten_1", "doc_a");
      const hits = await store.search("ten_1", [...VECTORS.north], { topK: 10 });
      expect(hits.map((h) => h.id)).toEqual(["chk_b1"]);
    });

    it("does not delete another tenant's document of the same id", async () => {
      await store.upsert([
        chunk({ id: "chk_mine", documentId: "doc_a", embedding: [...VECTORS.north] }),
        chunk({ id: "chk_theirs", tenantId: "ten_2", documentId: "doc_a", embedding: [...VECTORS.north] }),
      ]);
      await store.deleteByDocument("ten_1", "doc_a");
      expect(await store.search("ten_2", [...VECTORS.north], { topK: 10 })).toHaveLength(1);
    });

    it("refuses a dimension change instead of degrading silently", async () => {
      // Vectors from different embedding models are not comparable, and usually
      // differ in length. Accepting the change would turn retrieval into noise
      // with nothing in the logs to explain it.
      await store.upsert([chunk({ id: "chk_1", embedding: [...VECTORS.north] })]);
      await expect(store.init(DIMENSIONS + 4)).rejects.toThrow(/dimension|reindex/i);
    });

    it("tolerates re-initialising at the same dimension", async () => {
      await expect(store.init(DIMENSIONS)).resolves.toBeUndefined();
    });
  });
}
