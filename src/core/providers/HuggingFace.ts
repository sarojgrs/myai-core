/**
 * HuggingFace Inference API provider adapter
 *
 * Supports HuggingFace hosted models via the Inference API.
 * Quality varies by model — Llama-2-7b is a reasonable baseline.
 *
 * Note: HuggingFace inference can be slow for large models.
 * For production use, consider hosting the model yourself or using
 * a faster inference provider like Together.ai or Replicate.
 */

import type { Message } from "../AgentEngine";
import type { ProviderConfig } from "../ProviderEngine";
import type { ProviderAdapter } from "./Types";

interface HuggingFaceResponse {
  generated_text?: string;
  error?: string;
}

export class HuggingFaceAdapter implements ProviderAdapter {
  async call(
    messages: Message[],
    cfg: ProviderConfig,
    signal: AbortSignal,
  ): Promise<{ content: string; usage?: any }> {
    // Convert messages to a single prompt string
    // HuggingFace text generation doesn't natively support chat format
    const prompt =
      messages
        .map((m) => {
          if (m.role === "system") return `System: ${m.content}`;
          if (m.role === "user") return `User: ${m.content}`;
          return `Assistant: ${m.content}`;
        })
        .join("\n") + "\nAssistant:";

    const response = await fetch(`${cfg.baseUrl}/models/${cfg.model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 1024,
          temperature: 0.2,
          return_full_text: false,
        },
      }),
      signal: signal,
    });

    if (!response.ok) {
      throw new Error(
        `HuggingFace error ${response.status}: ${await response.text()}`,
      );
    }

    const json: HuggingFaceResponse | HuggingFaceResponse[] =
      await response.json();

    if (!Array.isArray(json) && json.error) {
      throw new Error(`HuggingFace error: ${json.error}`);
    }

    const result = Array.isArray(json) ? json[0] : json;

    return {
      content: result.generated_text ?? "",
      usage: undefined, // HuggingFace does not provide token usage in this API
    };
  }

  // HuggingFace does not support native tool calling in this adapter.
  // callWithTools() not implemented.

  // HuggingFace does not support streaming in this adapter yet.
  // callStream() not implemented — ProviderEngine falls back to call().
}
