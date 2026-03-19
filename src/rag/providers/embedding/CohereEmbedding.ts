import { EmbeddingConfig } from "../../types";

export async function cohereEmbed(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  if (!config.apiKey) {
    throw new Error("Cohere embedding requires apiKey");
  }

  const response = await fetch("https://api.cohere.ai/v1/embed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      texts: [text],
      input_type: "search_query",
    }),
  });

  if (!response.ok) {
    throw new Error(`Cohere embedding failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.embeddings[0];
}
