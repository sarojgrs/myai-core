import type { VectorDbConfig, RAGSearchResult } from "../../types";

export async function pineconeSearch(
  embedding: number[],
  limit: number,
  threshold: number,
  config: VectorDbConfig,
): Promise<RAGSearchResult[]> {
  if (!config.apiKey || !config.url) {
    throw new Error("Pinecone requires apiKey and url");
  }

  const response = await fetch(`https://${config.url}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": config.apiKey,
    },
    body: JSON.stringify({
      vector: embedding,
      topK: limit,
      includeMetadata: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Pinecone search failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.matches
    .filter((m: any) => m.score >= threshold)
    .map((m: any) => ({
      id: m.id,
      similarity: m.score,
      metadata: m.metadata,
      content: m.metadata?.content,
      title: m.metadata?.title,
    }));
}
