/**
 * Google Gemini provider adapter
 *
 * Uses Gemini's generateContent API.
 * Note: Gemini uses a different message format — roles are "user" and "model"
 * (not "assistant"), and system messages are passed separately.
 */

import type { Message } from "../AgentEngine";
import type { ProviderConfig } from "../ProviderEngine";
import type { ProviderAdapter } from "./Types";
import { fetchWithRetry } from "../../utils/ProviderUtils";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message: string; code: number };
}

export class GeminiAdapter implements ProviderAdapter {
  async call(
    messages: Message[],
    cfg: ProviderConfig,
    signal: AbortSignal,
  ): Promise<{ content: string; usage?: any }> {
    const systemMsg = messages.find((m) => m.role === "system");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body: any = {
      contents,
      generationConfig: {
        maxOutputTokens: cfg.maxTokens ?? 2048,
        temperature: cfg.temperature ?? 0.4,
      },
    };

    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const doFetch = () =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: signal,
        },
      );

    const response = await fetchWithRetry(doFetch, "gemini");

    if (!response.ok) {
      throw new Error(
        `Gemini error ${response.status}: ${await response.text()}`,
      );
    }

    const json: GeminiResponse = await response.json();

    if (json.error) {
      throw new Error(`Gemini error: ${json.error.message}`);
    }

    return {
      content: json.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      usage: undefined,
    };
  }
}
