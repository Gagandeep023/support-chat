import type { RetrievedChunk } from "@gagandeep023/support-chat-core";

export interface VectorChunk {
  id: string;
  documentId: string;
  tenantId: string;
  ordinal: number;
  text: string;
  headingPath: string[];
  documentTitle: string;
  documentUrl: string | null;
  embedding: number[];
  embeddingModel: string;
  tokenCount: number;
}

/**
 * Kept separate from DataStore on purpose.
 *
 * This is what makes the pluggable-database decision affordable: a Postgres
 * install gets pgvector and stays a single-service deployment, while a Mongo or
 * MySQL install brings its own vector service, and neither choice leaks into the
 * relational interface.
 */
export interface VectorStore {
  init(dimensions: number): Promise<void>;
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(
    tenantId: string,
    embedding: number[],
    options: { topK: number },
  ): Promise<RetrievedChunk[]>;
  deleteByDocument(tenantId: string, documentId: string): Promise<void>;
  close(): Promise<void>;
}
