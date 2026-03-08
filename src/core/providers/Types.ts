/**
 * Shared types for all provider adapters
 */

import type { Message } from "../AgentEngine";
import type {
  NativeTool,
  ToolCallResponse,
  ProviderConfig,
} from "../ProviderEngine";

// ── ProviderAdapter interface — implement this for any provider ───────────────

/**
 * Every provider adapter implements this interface.
 * ProviderEngine routes calls to the correct adapter based on provider name.
 *
 * Minimum required: call()
 * Optional: callWithTools(), callStream()
 */
export interface ProviderAdapter {
  /**
   * Send messages and return the assistant reply.
   */
  call(
    messages: Message[],
    cfg: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<{ content: string; usage?: any }>;

  /**
   * Send messages with native tool schemas.
   * Only implement for providers that support native tool calling.
   */
  callWithTools?(
    messages: any[],
    tools: NativeTool[],
    cfg: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<ToolCallResponse>;

  /**
   * Stream response chunks as they arrive.
   * Falls back to call() if not implemented.
   */
  callStream?(
    messages: Message[],
    cfg: ProviderConfig,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<string>;
}
