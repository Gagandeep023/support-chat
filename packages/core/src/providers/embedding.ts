export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  /**
   * Index dimensionality. The VectorStore needs this at creation time, and a
   * mismatch against an existing index is a hard error rather than a silent
   * quality collapse.
   */
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
