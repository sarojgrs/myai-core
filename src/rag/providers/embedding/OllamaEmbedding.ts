import { EmbeddingConfig } from "../../types";

export async function ollamaEmbed(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  if (!config.url) {
    throw new Error("Ollama embedding requires url");
  }

  const response = await fetch(`${config.url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: [text],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.embeddings[0];
}
