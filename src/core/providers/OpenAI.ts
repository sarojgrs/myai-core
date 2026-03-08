/**
 * OpenAI-compatible provider adapter
 *
 * Handles all OpenAI-compatible APIs:
 *   - OpenAI
 *   - Cerebras
 *   - Groq
 *   - Codestral (Mistral)
 *   - Any other OpenAI-compatible endpoint
 */

import type { Message } from "../AgentEngine";
import type {
  NativeTool,
  ToolCallResponse,
  ProviderConfig,
} from "../ProviderEngine";
import { fetchWithRetry } from "../../utils/ProviderUtils";
import type { ProviderAdapter } from "./Types";

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: { message: string; code: string };
}

export class OpenAIAdapter implements ProviderAdapter {
  async call(
    messages: Message[],
    cfg: ProviderConfig,
    signal: AbortSignal,
  ): Promise<{ content: string; usage?: any }> {
    const doFetch = () =>
      fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: false,
          max_tokens: cfg.maxTokens ?? 4096,
          temperature: cfg.temperature ?? 0.2,
        }),
        signal: signal,
      });

    const response = await fetchWithRetry(doFetch, cfg.name);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${cfg.name} API error ${response.status}: ${errText}`);
    }

    const json: OpenAIResponse = await response.json();
    this._logTokens(json.usage);

    return {
      content: json.choices?.[0]?.message?.content ?? "",
      usage: json.usage,
    };
  }

  async callWithTools(
    messages: any[],
    tools: NativeTool[],
    cfg: ProviderConfig,
    signal: AbortSignal,
  ): Promise<ToolCallResponse> {
    const doFetch = () =>
      fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          tools,
          tool_choice: "auto",
          max_tokens: cfg.maxTokens ?? 4096,
          temperature: cfg.temperature ?? 0.2,
        }),
        signal: signal,
      });

    const response = await fetchWithRetry(doFetch, cfg.name);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${cfg.name} API error ${response.status}: ${errText}`);
    }

    const json: OpenAIResponse = await response.json();
    this._logTokens(json.usage);

    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error(`${cfg.name}: no message in response`);

    return {
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
      usage: json.usage,
    };
  }

  async callStream(
    messages: Message[],
    cfg: ProviderConfig,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    const doFetch = () =>
      fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: true,
          max_tokens: cfg.maxTokens ?? 4096,
          temperature: cfg.temperature ?? 0.2,
        }),
      });

    const response = await fetchWithRetry(doFetch, cfg.name);

    if (!response.ok) {
      throw new Error(
        `${cfg.name} stream error ${response.status}: ${await response.text()}`,
      );
    }

    let full = "";
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder
        .decode(value)
        .split("\n")
        .filter((l) => l.startsWith("data: "));
      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data)?.choices?.[0]?.delta?.content ?? "";
          if (chunk) {
            full += chunk;
            onChunk(chunk);
          }
        } catch {
          /* skip malformed SSE line */
        }
      }
    }
    return full;
  }

  private _logTokens(usage?: OpenAIResponse["usage"]): void {
    if (usage) {
      console.log(
        `[ProviderEngine/Tokens] prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`,
      );
    }
  }
}
