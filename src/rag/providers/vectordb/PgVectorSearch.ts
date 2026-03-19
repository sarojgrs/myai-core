import { RAGSearchResult, VectorDbConfig } from "../../types";

export async function pgVectorSearch(
  embedding: number[],
  limit: number,
  threshold: number,
  config: VectorDbConfig,
): Promise<RAGSearchResult[]> {
  if (!config.searchFn) {
    throw new Error(
      "pgvector requires searchFn. " +
        "Pass your own DB query function:\n" +
        "searchFn: async (embedding, limit, threshold) => {\n" +
        "  return db.query(...)\n" +
        "}",
    );
  }
  return config.searchFn(embedding, limit, threshold);
}
