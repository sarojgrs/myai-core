// ── BaseContextProvider — optional base class with shared helpers ──────────────

import { ContextProvider } from "../ContextEngine";

export abstract class BaseContextProvider implements ContextProvider {
  abstract readonly name: string;
  abstract buildContext(task: string): Promise<string>;

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected truncate(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n... (truncated)";
  }
}
