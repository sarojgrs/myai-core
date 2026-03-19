export interface EmbeddingConfig {
  provider: "ollama" | "openai" | "cohere" | "mistral" | "custom";
  model: string;
  url?: string;
  apiKey?: string;
  embedFn?: (text: string) => Promise<number[]>;
}

export interface VectorDbConfig {
  provider: "pgvector" | "pinecone" | "qdrant" | "custom";
  connectionString?: string;
  apiKey?: string;
  url?: string;
  table?: string;
  index?: string;
  searchFn?: (
    embedding: number[],
    limit: number,
    threshold: number,
  ) => Promise<any[]>;
}

export interface RAGConfig {
  embedding: EmbeddingConfig;
  vectorDb: VectorDbConfig;
}

export interface RAGSearchResult {
  id: string | number;
  content?: string;
  title?: string;
  similarity: number;
  metadata?: Record<string, any>;
}
