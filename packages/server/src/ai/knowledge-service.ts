import {
  newChunkId,
  newDocumentId,
  type EmbeddingProvider,
} from "@gagandeep023/support-chat-core";
import { createHash } from "node:crypto";
import type { VectorChunk, VectorStore } from "../stores/vector-store.js";
import { chunkDocument, type ChunkOptions, type SourceDocument } from "./chunker.js";
import type { KeywordIndex } from "./keyword-index.js";

export interface IngestResult {
  documentId: string;
  chunks: number;
  skipped: boolean;
}

/**
 * Turns customer content into retrievable chunks.
 *
 * The knowledge lives in this index and is dropped into the request at question
 * time, never trained into weights. That is what keeps a customer's content
 * portable across whichever model they point this at, and what makes a docs edit
 * take effect on the next question instead of the next training run.
 */
export class KnowledgeService {
  private readonly hashes = new Map<string, string>();

  constructor(
    private readonly deps: {
      vectors: VectorStore | null;
      keywords: KeywordIndex;
      embeddings: EmbeddingProvider | null;
    },
    private readonly options: ChunkOptions = {},
  ) {}

  async ingest(tenantId: string, document: SourceDocument): Promise<IngestResult> {
    const documentId = document.id || newDocumentId();
    const hash = createHash("sha256").update(document.content).digest("hex");
    const key = `${tenantId}:${documentId}`;

    if (this.hashes.get(key) === hash) {
      return { documentId, chunks: 0, skipped: true };
    }

    // Replace rather than merge. A stale chunk left behind after an edit means
    // the bot quotes a policy the customer already changed.
    await this.remove(tenantId, documentId);

    const pieces = chunkDocument(document, this.options);
    const embeddings = this.deps.embeddings
      ? await this.deps.embeddings.embed(pieces.map((p) => p.text))
      : null;

    const chunks: VectorChunk[] = pieces.map((piece, index) => ({
      id: newChunkId(),
      documentId,
      tenantId,
      ordinal: piece.ordinal,
      text: piece.text,
      headingPath: piece.headingPath,
      documentTitle: document.title,
      documentUrl: document.url ?? null,
      embedding: embeddings?.[index] ?? [],
      embeddingModel: this.deps.embeddings?.model ?? "none",
      tokenCount: piece.tokenCount,
    }));

    this.deps.keywords.add(chunks);
    if (this.deps.vectors && embeddings) await this.deps.vectors.upsert(chunks);
    this.hashes.set(key, hash);

    return { documentId, chunks: chunks.length, skipped: false };
  }

  async remove(tenantId: string, documentId: string): Promise<void> {
    this.deps.keywords.removeByDocument(tenantId, documentId);
    await this.deps.vectors?.deleteByDocument(tenantId, documentId);
    this.hashes.delete(`${tenantId}:${documentId}`);
  }
}
