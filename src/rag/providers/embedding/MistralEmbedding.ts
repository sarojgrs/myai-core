import { EmbeddingConfig } from "../../types";

export async function mistralEmbed(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  if (!config.apiKey) {
    throw new Error("Mistral embedding requires apiKey");
  }

  const response = await fetch("https://api.mistral.ai/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: [text],
    }),
  });

  if (!response.ok) {
    throw new Error(`Mistral embedding failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}
