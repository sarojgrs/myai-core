import type { VectorDbConfig, RAGSearchResult } from "../../types";

export async function qdrantSearch(
  embedding: number[],
  limit: number,
  threshold: number,
  config: VectorDbConfig,
): Promise<RAGSearchResult[]> {
  if (!config.url) {
    throw new Error("Qdrant requires url");
  }

  const collection = config.table || "documents";

  const response = await fetch(
    `${config.url}/collections/${collection}/points/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "api-key": config.apiKey } : {}),
      },
      body: JSON.stringify({
        vector: embedding,
        limit,
        score_threshold: threshold,
        with_payload: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Qdrant search failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.result.map((r: any) => ({
    id: r.id,
    similarity: r.score,
    content: r.payload?.content,
    title: r.payload?.title,
    metadata: r.payload,
  }));
}
