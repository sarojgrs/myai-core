/**
 * Framework-agnostic AI provider abstraction
 *
 * ProviderEngine is a thin router. It:
 *   - Manages provider configs (setProvider, setActiveProvider)
 *   - Tracks provider capabilities (nativeTools, fim, chat, metered)
 *   - Routes calls to the correct ProviderAdapter
 *   - Builds native tool schemas
 *
 * All HTTP logic lives in providers/:
 *   providers/openai.ts       → OpenAI, Cerebras, Groq, Codestral, any OpenAI-compatible
 *   providers/gemini.ts       → Google Gemini
 *   providers/ollama.ts       → Ollama (local)
 *   providers/huggingface.ts  → HuggingFace Inference API
 *
 * Adding a new provider:
 *   1. Create providers/myprovider.ts implementing ProviderAdapter
 *   2. Register capabilities: providerEngine.registerProvider("myprovider", { nativeTools: true })
 *   3. Register adapter: providerEngine.registerAdapter("myprovider", new MyProviderAdapter())
 *   4. Set config: providerEngine.setProvider("myprovider", { apiKey, model, baseUrl })
 */

import type { Message } from "./AgentEngine";
import type { ToolDefinition } from "./ToolEngine";
import type { ProviderAdapter } from "./providers/Types";
import { OpenAIAdapter } from "./providers/OpenAI";
import { GeminiAdapter } from "./providers/Gemini";
import { OllamaAdapter } from "./providers/Ollama";
import { HuggingFaceAdapter } from "./providers/HuggingFace";

export type BuiltInProvider =
  | "codestral"
  | "groq"
  | "openai"
  | "cerebras"
  | "ollama"
  | "gemini"
  | "huggingface"
  | "custom";

export type ProviderName = BuiltInProvider | (string & {});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  name: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number; // default: 4096
  temperature?: number;
}

export interface NativeTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface ToolCallResponse {
  role: "assistant";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Provider capability registry — built-in defaults (read-only reference) ───

export interface ProviderCapabilities {
  nativeTools?: boolean;
  fim?: boolean;
  chat?: boolean;
  metered?: boolean;
}

const BUILT_IN_CAPABILITIES: Record<string, ProviderCapabilities> = {
  codestral: { nativeTools: true, fim: true, chat: false, metered: false },
  groq: { nativeTools: true, fim: false, chat: true, metered: false },
  openai: { nativeTools: true, fim: false, chat: true, metered: true },
  cerebras: { nativeTools: false, fim: false, chat: true, metered: false },
  ollama: { nativeTools: false, fim: true, chat: false, metered: false },
  gemini: { nativeTools: false, fim: false, chat: false, metered: true },
  huggingface: { nativeTools: false, fim: false, chat: true, metered: false },
  custom: { nativeTools: false, fim: false, chat: true, metered: true },
};

// ── ProviderEngine class ──────────────────────────────────────────────────────

export class ProviderEngine {
  private configs: Map<string, ProviderConfig> = new Map();
  private activeProvider: string = "cerebras";
  private adapters: Map<string, ProviderAdapter> = new Map();

  // registry and built-in adapters are now instance-level, not module
  // singletons. Parallel agents each get their own copy — no cross-contamination.
  private registry: Record<string, ProviderCapabilities> = {
    ...BUILT_IN_CAPABILITIES,
  };
  private builtinAdapters: Record<string, ProviderAdapter> = {
    openai: new OpenAIAdapter(),
    codestral: new OpenAIAdapter(),
    groq: new OpenAIAdapter(),
    cerebras: new OpenAIAdapter(),
    custom: new OpenAIAdapter(),
    gemini: new GeminiAdapter(),
    ollama: new OllamaAdapter(),
    huggingface: new HuggingFaceAdapter(),
  };

  // ── Configuration ───────────────────────────────────────────────────────────

  setProviderConfig(name: string, config: Omit<ProviderConfig, "name">): void {
    this.configs.set(name, { name, ...config });
  }

  // setActiveProvider(name: string): void {
  //   this.activeProvider = name;
  // }

  setActiveProvider(name: ProviderName): void {
    this.activeProvider = name;
  }

  getActiveProvider(): string {
    return this.activeProvider;
  }

  // ── Capability registry ─────────────────────────────────────────────────────

  /**
   * Register a new provider with its capabilities.
   * Use this for providers not in the built-in registry.
   *
   * Mutates instance-level registry, not a shared module global.
   *
   * Example:
   *   providerEngine.registerProvider("mistral", { nativeTools: true, chat: true });
   */
  registerProvider(name: string, capabilities: ProviderCapabilities): void {
    this.registry[name] = capabilities;
  }

  useNativeTools(provider: string = this.activeProvider): boolean {
    // read from instance registry
    return this.registry[provider]?.nativeTools ?? false;
  }

  getCapabilities(provider: string): ProviderCapabilities {
    // read from instance registry
    return this.registry[provider] ?? {};
  }

  // ── Adapter registry ────────────────────────────────────────────────────────

  /**
   * Register a custom adapter for a provider.
   * Use this when adding a provider with a non-OpenAI-compatible API.
   *
   * Example:
   *   providerEngine.registerAdapter("mistral", new MistralAdapter());
   */
  registerAdapter(name: string, adapter: ProviderAdapter): void {
    this.adapters.set(name, adapter);
  }

  /**
   * Atomic helper — registers capabilities, adapter, and config in
   * one call with validation. Prevents the silent failure modes where a dev
   * calls registerProvider() but forgets registerAdapter() (falls back to
   * OpenAIAdapter silently) or vice versa.
   *
   * Example:
   *   providerEngine.registerCustomProvider("mistral",
   *     { nativeTools: true, chat: true },
   *     new MistralAdapter(),
   *     { apiKey: "...", model: "mistral-large", baseUrl: "https://api.mistral.ai/v1" }
   *   );
   */
  registerCustomProvider(
    name: string,
    capabilities: ProviderCapabilities,
    adapter: ProviderAdapter,
    config?: Omit<ProviderConfig, "name">,
  ): void {
    if (!name?.trim())
      throw new Error("registerCustomProvider: name is required");
    this.registry[name] = capabilities;
    this.adapters.set(name, adapter);
    if (config) this.setProviderConfig(name, config);
  }

  // ── Main chat call ──────────────────────────────────────────────────────────

  async callAI(
    messages: Message[],
    providerOverride?: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; usage?: any }> {
    const providerName = providerOverride ?? this.activeProvider;
    const cfg = this._getConfig(providerName);
    const adapter = this._getAdapter(providerName);

    console.log(
      `[ProviderEngine] callAI provider=${providerName} model=${cfg.model}`,
    );

    return adapter.call(messages, cfg, signal);
  }

  // ── Native tool calling ─────────────────────────────────────────────────────

  // signal is now forwarded to adapter.callWithTools so that
  // abort() during a native-tool-mode call actually cancels the HTTP request.
  async callAIWithTools(
    messages: any[],
    tools: NativeTool[],
    providerOverride?: string,
    signal?: AbortSignal,
  ): Promise<ToolCallResponse> {
    const providerName = providerOverride ?? this.activeProvider;

    if (!this.useNativeTools(providerName)) {
      throw new Error(
        `callAIWithTools: "${providerName}" does not support native tool calling.`,
      );
    }

    const cfg = this._getConfig(providerName);
    const adapter = this._getAdapter(providerName);

    if (!adapter.callWithTools) {
      throw new Error(
        `callAIWithTools: adapter for "${providerName}" does not implement callWithTools().`,
      );
    }

    // pass signal so abort propagates to the HTTP layer
    return adapter.callWithTools(messages, tools, cfg, signal);
  }

  // ── Streamed chat response ──────────────────────────────────────────────────

  // signal is now accepted and forwarded to adapter.callStream so
  // that abort() during streaming actually cancels the fetch request.
  async callAIStream(
    messages: Message[],
    providerOverride: string | undefined,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const providerName = providerOverride ?? this.activeProvider;
    const cfg = this._getConfig(providerName);
    const adapter = this._getAdapter(providerName);

    // Fall back to call() if adapter doesn't support streaming
    if (!adapter.callStream) {
      const result = await adapter.call(messages, cfg, signal);
      onChunk(result.content);
      return result.content;
    }

    // forward signal so streaming can be aborted
    return adapter.callStream(messages, cfg, onChunk, signal);
  }

  // ── Build native schemas from tool definitions ──────────────────────────────

  buildNativeSchemas(tools: ToolDefinition[]): NativeTool[] {
    return tools.map((t) => {
      const properties: Record<
        string,
        {
          type: string;
          description: string;
          enum?: string[];
        }
      > = {};
      const required: string[] = [];

      for (const [key, desc] of Object.entries(t.params)) {
        // Old format → string description
        if (typeof desc === "string") {
          const optional = desc.includes("optional");
          properties[key] = {
            type: "string",
            description: desc,
          };
          if (!optional) required.push(key);

          // New format → ToolParameter object
        } else {
          properties[key] = {
            type: desc.type || "string",
            description: desc.description,
            ...(desc.enum ? { enum: desc.enum } : {}),
          };
          if (desc.required) required.push(key);
        }
      }

      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: "object",
            properties,
            required,
          },
        },
      };
    });
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private _getConfig(providerName: string): ProviderConfig {
    const cfg = this.configs.get(providerName);
    if (!cfg) {
      throw new Error(
        `ProviderEngine: No config found for provider "${providerName}". Call setProvider() first.`,
      );
    }
    return cfg;
  }

  private _getAdapter(providerName: string): ProviderAdapter {
    // Check runtime-registered adapters first (user-provided override)
    const custom = this.adapters.get(providerName);
    if (custom) return custom;

    // Fall back to instance-level built-in adapters (not module singleton)
    const builtin = this.builtinAdapters[providerName];
    if (builtin) return builtin;

    // Unknown provider — default to OpenAI-compatible
    // Most new providers are OpenAI-compatible
    return new OpenAIAdapter();
  }
}
