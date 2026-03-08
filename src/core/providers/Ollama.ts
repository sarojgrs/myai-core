/**
 * Ollama local model provider adapter
 *
 * Ollama runs models 100% locally — no API key required.
 * Default endpoint: http://localhost:11434
 * Default model: codellama
 *
 * Setup: install Ollama from https://ollama.ai, then run `ollama pull <model>`
 */

import type { Message } from "../AgentEngine";
import type { ProviderConfig } from "../ProviderEngine";
import type { ProviderAdapter } from "./Types";

interface OllamaResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaAdapter implements ProviderAdapter {
  async call(
    messages: Message[],
    cfg: ProviderConfig,
    signal: AbortSignal,
  ): Promise<{ content: string; usage?: any }> {
    const baseUrl = cfg.baseUrl || "http://localhost:11434";
    const model = cfg.model || "codellama";

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: signal,
    });

    if (!response.ok) {
      throw new Error(
        `Ollama error ${response.status}: ${await response.text()}`,
      );
    }

    const json: OllamaResponse = await response.json();

    if (json.error) {
      throw new Error(`Ollama error: ${json.error}`);
    }

    return {
      content: json.message?.content ?? "",
      usage: undefined, // Ollama does not provide token usage
    };
  }

  // Ollama does not support native tool calling in this adapter.
  // callWithTools() not implemented.

  // Ollama does not support streaming in this adapter yet.
  // callStream() not implemented — ProviderEngine falls back to call().
}
