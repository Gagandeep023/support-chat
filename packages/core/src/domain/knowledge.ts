import { z } from "zod";

export const documentSourceSchema = z.enum([
  "push",
  "file",
  "crawl",
  "conversation",
]);
export type DocumentSource = z.infer<typeof documentSourceSchema>;

export const documentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  source: documentSourceSchema,
  /** Skips re-embedding when the content has not changed. */
  contentHash: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Document = z.infer<typeof documentSchema>;

export const chunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  tenantId: z.string(),
  ordinal: z.number().int().nonnegative(),
  /**
   * The chunk text with its heading path prepended, e.g.
   * "Billing > Refunds > Eligibility\n\nYou can request one within 30 days".
   * Without the path a chunk like that is unanswerable, so the prefix is part of
   * the indexed text rather than metadata.
   */
  text: z.string(),
  headingPath: z.array(z.string()),
  /**
   * The embedding model that produced this chunk's vector. A mismatch against
   * the configured provider is a hard startup error, not a silent degradation:
   * vectors from different models are not comparable.
   */
  embeddingModel: z.string(),
  tokenCount: z.number().int().nonnegative(),
});
export type Chunk = z.infer<typeof chunkSchema>;

/** A chunk returned by retrieval, with its score and enough context to cite it. */
export const retrievedChunkSchema = chunkSchema.extend({
  score: z.number(),
  documentTitle: z.string(),
  documentUrl: z.string().nullable(),
});
export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>;
