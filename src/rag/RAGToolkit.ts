import { ToolRegistry } from "../core/registry/ToolRegistry";
import type { RAGConfig, RAGSearchResult } from "./types";
import { ollamaEmbed } from "./providers/embedding/OllamaEmbedding";
import { openaiEmbed } from "./providers/embedding/OpenAIEmbedding";
import { cohereEmbed } from "./providers/embedding/CohereEmbedding";
import { mistralEmbed } from "./providers/embedding/MistralEmbedding";
import { pgVectorSearch } from "./providers/vectordb/PgVectorSearch";
import { pineconeSearch } from "./providers/vectordb/PineconeSearch";
import { qdrantSearch } from "./providers/vectordb/QdrantSearch";

export class RAGToolkit {
  private constructor(private config: RAGConfig) {}

  static create(config: RAGConfig): RAGToolkit {
    return new RAGToolkit(config);
  }

  get defaultProfile(): string {
    return "rag";
  }

  get registry(): ToolRegistry {
    const toolRegistry = new ToolRegistry();

    toolRegistry.registerTool(
      "vectorSearch",
      {
        description:
          "Search knowledge base using semantic similarity. " +
          "Use this to find relevant documents and information. " +
          "Always use this tool when searching stored knowledge.",
        category: "rag",
        tags: ["search", "vector", "knowledge", "rag"],
        params: {
          query: {
            type: "string",
            description: "Search query",
            required: true,
            minLength: 1,
            maxLength: 1000,
          },
          limit: {
            type: "number",
            description: "Number of results 1-20",
            required: false,
            default: 5,
          },
          threshold: {
            type: "number",
            description: "Minimum similarity score 0-1",
            required: false,
            default: 0.5,
          },
        },
      },
      async (args) => {
        try {
          const embedding = await this.embed(args.query);
          const results = await this.search(
            embedding,
            Number(args.limit) || 5,
            Number(args.threshold) || 0.5,
          );

          if (results.length === 0) {
            return {
              tool: "vectorSearch",
              success: true,
              output: "No results found.",
            };
          }

          return {
            tool: "vectorSearch",
            success: true,
            output: JSON.stringify(results, null, 2),
          };
        } catch (err: any) {
          return {
            tool: "vectorSearch",
            success: false,
            output: `Search failed: ${err.message}`,
          };
        }
      },
    );

    return toolRegistry;
  }

  // ── Embed query ──────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    const { embedding } = this.config;

    switch (embedding.provider) {
      case "ollama":
        return ollamaEmbed(text, embedding);

      case "openai":
        return openaiEmbed(text, embedding);

      case "cohere":
        return cohereEmbed(text, embedding);

      case "mistral":
        return mistralEmbed(text, embedding);

      case "custom": {
        if (!embedding.embedFn) {
          throw new Error("Custom embedding provider requires embedFn");
        }
        return embedding.embedFn(text);
      }

      default:
        throw new Error(
          `Unsupported embedding provider: ${embedding.provider}`,
        );
    }
  }

  // ── Search vector DB ─────────────────────────────────

  private async search(
    embedding: number[],
    limit: number,
    threshold: number,
  ): Promise<RAGSearchResult[]> {
    const { vectorDb } = this.config;

    switch (vectorDb.provider) {
      case "pgvector":
        return pgVectorSearch(embedding, limit, threshold, vectorDb);

      case "pinecone":
        return pineconeSearch(embedding, limit, threshold, vectorDb);

      case "qdrant":
        return qdrantSearch(embedding, limit, threshold, vectorDb);

      case "custom": {
        if (!vectorDb.searchFn) {
          throw new Error("Custom vector DB requires searchFn");
        }
        return vectorDb.searchFn(embedding, limit, threshold);
      }

      default:
        throw new Error(`Unsupported vector DB: ${vectorDb.provider}`);
    }
  }
}
