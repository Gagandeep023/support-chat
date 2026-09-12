import { describe, expect, it } from "vitest";
import { KeywordIndex } from "./keyword-index.js";
import { Retriever } from "./retriever.js";
import { chunkDocument } from "./chunker.js";
import type { VectorChunk } from "../stores/vector-store.js";

function toVectorChunks(
  tenantId: string,
  documentId: string,
  title: string,
  content: string,
): VectorChunk[] {
  return chunkDocument({ id: documentId, title, content }).map((piece, index) => ({
    id: `${documentId}_${index}`,
    documentId,
    tenantId,
    ordinal: piece.ordinal,
    text: piece.text,
    headingPath: piece.headingPath,
    documentTitle: title,
    documentUrl: null,
    embedding: [],
    embeddingModel: "none",
    tokenCount: piece.tokenCount,
  }));
}

const DOC = `# Charging

## Session stops early

If your session stopped before the battery was full, error code E4021 usually means the
cable was unplugged at the vehicle end.

## Refunds

Refunds are issued within 14 working days.
`;

describe("chunking", () => {
  it("prepends the heading path to the chunk text", () => {
    // "You can request one within 30 days" is unanswerable without its heading
    // path, and the path has to be in the indexed text to influence retrieval.
    const chunks = chunkDocument({ id: "d1", title: "Help", content: DOC });
    const refunds = chunks.find((c) => c.text.includes("14 working days"));
    expect(refunds?.text.startsWith("Help > Refunds")).toBe(true);
    expect(refunds?.headingPath).toEqual(["Help", "Refunds"]);
  });

  it("splits on structure rather than a fixed window", () => {
    const chunks = chunkDocument({ id: "d1", title: "Help", content: DOC });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });
});

describe("hybrid retrieval", () => {
  const index = new KeywordIndex();
  index.add(toVectorChunks("ten_1", "d1", "Help", DOC));
  const retriever = new Retriever(null, index, null);

  it("finds a pasted error code, which dense vectors handle poorly", () => {
    const hits = index.search("ten_1", "E4021", 5);
    expect(hits[0]?.text).toContain("E4021");
  });

  it("reports ungrounded when nothing clears the threshold", async () => {
    const result = await retriever.retrieve("ten_1", "what is the capital of France");
    expect(result.grounded).toBe(false);
    expect(result.chunks).toEqual([]);
  });

  it("reports grounded when something matches", async () => {
    const result = await retriever.retrieve("ten_1", "refunds working days");
    expect(result.grounded).toBe(true);
  });

  it("does not leak another tenant's documents", async () => {
    const result = await retriever.retrieve("ten_other", "refunds working days");
    expect(result.chunks).toEqual([]);
  });

  it("drops chunks when their document is removed", async () => {
    const scoped = new KeywordIndex();
    scoped.add(toVectorChunks("ten_1", "d1", "Help", DOC));
    scoped.removeByDocument("ten_1", "d1");
    // An orphaned chunk means the bot quoting a policy the customer deleted.
    expect(scoped.search("ten_1", "refunds", 5)).toEqual([]);
  });
});
