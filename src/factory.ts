//********************************************START***********************************************/
// ── Imports for factories ───────────Creating the interface for public───────────────────────────

import {
  AgentEngine,
  AgentConfig,
  AgentEngineDeps,
  AgentMessage,
} from "./core/AgentEngine";
import { ChatEngine } from "./core/ChatEngine";
import {
  ToolEngine,
  ToolParameter,
  buildToolSystemPrompt,
} from "./core/ToolEngine";
import {
  ProviderEngine,
  ProviderConfig,
  ProviderName,
} from "./core/ProviderEngine";
import { ProfileManager } from "./core/ProfileManager";
import { MemoryEngine } from "./core/MemoryEngine";
import {
  ContextEngine,
  type ContextEngine as ContextEngineType,
} from "./core/ContextEngine";
import { FileSystemContextProvider } from "./core/contextProvider/FileSystemContext";
import { MemoryContextProvider } from "./core/contextProvider/MemoryContext";
import type { ToolRegistry } from "./core/registry/ToolRegistry";
import { validateAgentOptions, validateChatOptions } from "./utils/Validation";
import { BaseProfile } from "./core/profiles/Base";
import { AgentLifecycleHooks } from "./core/hooks/AgentLifecycleHooks";
export { ValidationError } from "./utils/Validation";

// ── ProviderEntry — config for a single provider ──────────────────────────────

export type ProviderEntry = Pick<
  ProviderConfig,
  "apiKey" | "model" | "baseUrl"
>;

// ── CustomProfileDefinition ───────────────────────────────────────────────────

export interface CustomProfileDefinition {
  /** Unique profile name */
  name: string;
  description?: string;
  systemPrompt: string;
  planningPrompt: string;
  userPrompt?: string;
  allowedTools: string[];
  styleRules?: string[];
  safetyRules?: string[];
}

// ── Factory result types ──────────────────────────────────────────────────────

export interface CreateAgentResult {
  agent: AgentEngine;
  providerEngine: ProviderEngine;
  abort: () => void;
}

// ── CreateAgentOptions ────────────────────────────────────────────────────────

export interface CreateAgentOptions {
  /** Primary provider — used as default for all runs */
  provider: ProviderName;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;

  /**
   * Additional providers for pipeline steps or mid-run switching.
   *
   * Example:
   *   providers: {
   *     groq:   { apiKey: "...", model: "llama3-8b-8192", baseUrl: "https://api.groq.com/openai/v1" },
   *     openai: { apiKey: "...", model: "gpt-4o",         baseUrl: "https://api.openai.com/v1" },
   *   }
   */
  providers?: Record<string, ProviderEntry>;

  workspaceRoot: string;
  profile?: string;
  maxTurns?: number;

  /**
   * Optional custom profiles to register at creation time.
   *
   * Example:
   *   customProfiles: {
   *     securityAudit: {
   *       systemPrompt: "You are a security auditor...",
   *       planningPrompt: "Plan read-only security checks...",
   *       allowedTools: ["readFile", "listFiles"],
   *       safetyRules: ["Never modify files"]
   *     }
   *   }
   */
  customProfiles?: Record<string, Omit<CustomProfileDefinition, "name">>;

  /** Typed event stream. Use msg.type to distinguish message kinds. */
  onMessage: (msg: AgentMessage) => void;

  confirm?: (message: string) => Promise<boolean>;
  memory?: MemoryEngine;
  systemPrompt?: string;
  userPrompt?: string;
  planningPrompt?: string;

  /**
   * Optional ToolRegistry instance.
   * All custom tools from the registry are registered on the internal
   * ToolEngine and added to the active profile's allowedTools list.
   */
  toolRegistry?: ToolRegistry;

  /**
   * Optional AbortSignal for cancellation.
   * Prefer using the abort() function returned by createAgent() instead.
   * Only pass this directly for advanced use cases like AbortSignal.timeout().
   */
  signal?: AbortSignal;

  /**
   * Lifecycle hooks — observe and customize agent execution.
   * Use built-ins directly, or compose multiple together:
   *
   *   import { LoggingHooks, TokenBudgetHooks, composeHooks } from "@saroj/myai-core"
   *
   *   hooks: composeHooks(
   *     new LoggingHooks(),
   *     new TokenBudgetHooks({ maxTokens: 80_000 }),
   *   )
   *
   * Or pass a plain object implementing AgentLifecycleHooks for custom behaviour:
   *
   *   hooks: {
   *     beforeTurn: async (state) => { ... },
   *     onComplete:  async (result) => { ... },
   *   }
   *
   * All methods are optional. Can also be set after creation via agent.setHooks().
   */
  hooks?: AgentLifecycleHooks;

  /**
   * Additional context providers injected into the agent's ContextEngine.
   * Each provider runs on every turn and contributes to the system prompt.
   * Provider declares its own cache and invalidation rules via invalidateOn.
   *
   * Example:
   *   contextProviders: [
   *     { provider: new MyDBProvider(), cache: true, ttl: 30_000 }
   *   ]
   */
  contextProviders?: Array<{
    provider: import("./core/ContextEngine").ContextProvider;
    cache?: boolean;
    ttl?: number;
  }>;
}

// ── AgentInternals ────────────────────────────────────────────────────────────

interface AgentInternals {
  agentConfig: AgentConfig;
  deps: AgentEngineDeps;
  toolEngine: ToolEngine;
  profileManager: ProfileManager;
  providerEngine: ProviderEngine;
}

function buildProviders(options: CreateAgentOptions): ProviderEngine {
  const providerEngine = new ProviderEngine();
  providerEngine.setProviderConfig(options.provider, {
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });
  providerEngine.setActiveProvider(options.provider);

  if (options.providers) {
    for (const [name, cfg] of Object.entries(options.providers)) {
      providerEngine.setProviderConfig(name, cfg);
    }
  }

  return providerEngine;
}

function buildProfileManager(options: CreateAgentOptions): ProfileManager {
  const profileManager = new ProfileManager();

  if (options.customProfiles) {
    profileManager.registerCustomProfilesAndSwitch(
      options.customProfiles,
      options.profile ?? "code",
      (name, def) => createDynamicProfile(name, { name, ...def }),
    );
  } else {
    profileManager.switch(options.profile ?? "code");
  }

  return profileManager;
}

function buildContextEngine(options: CreateAgentOptions): ContextEngine {
  const fsProvider = new FileSystemContextProvider(options.workspaceRoot);
  const memProvider = options.memory
    ? new MemoryContextProvider(options.memory)
    : null;

  const contextEngine = new ContextEngine().use(fsProvider, {
    cache: true,
    ttl: 0,
  });

  if (memProvider) {
    contextEngine.use(memProvider, { cache: true, ttl: 60_000 });
  }

  // Client custom providers — fully pluggable
  // Each provider declares its own invalidateOn rules
  if (options.contextProviders) {
    for (const { provider, cache, ttl } of options.contextProviders) {
      contextEngine.use(provider, { cache: cache ?? false, ttl: ttl ?? 0 });
    }
  }

  return contextEngine;
}

function buildAgentInternals(options: CreateAgentOptions): AgentInternals {
  validateAgentOptions(options);
  const {
    workspaceRoot,
    profile = "code",
    maxTurns = 10,
    onMessage,
    confirm,
    memory,
    systemPrompt,
    userPrompt,
    planningPrompt,
    toolRegistry,
  } = options;

  const providerEngine = buildProviders(options);
  const toolEngine = new ToolEngine();
  const profileManager = buildProfileManager(options);
  const contextEngine = buildContextEngine(options);

  if (toolRegistry) {
    attachRegistryTools(toolEngine, profileManager, toolRegistry);
  }

  const agentConfig: AgentConfig = {
    provider: options.provider,
    workspaceRoot,
    onMessage,
    profile,
    maxTurns,
    confirm,
    memory,
    systemPrompt,
    userPrompt,
    planningPrompt,
    toolRegistry,
    signal: options.signal,
    onToolExecuted: (toolName) => contextEngine.notifyToolExecuted(toolName),
  };

  const deps: AgentEngineDeps = {
    // Forward prov so Planner, Executor, and PipelineRunner
    // provider overrides actually reach the adapter. Fall back to active provider
    // when no override is supplied (e.g. normal single-provider runs).
    callAI: (messages, prov) =>
      providerEngine.callAI(
        messages,
        prov ?? providerEngine.getActiveProvider(),
        agentConfig.signal,
      ),

    callAIWithTools: (messages, tools, prov) =>
      providerEngine.callAIWithTools(
        messages,
        tools,
        prov ?? providerEngine.getActiveProvider(),
        agentConfig.signal,
      ),

    executeTool: async (tool, args, msgFn, cfg) => {
      if (!profileManager.isToolAllowed(tool) && tool !== "done") {
        return Promise.resolve({
          tool,
          success: false,
          output: `Tool "${tool}" not allowed in profile "${profileManager.getActiveName()}". Allowed: ${profileManager.getAllowedTools().join(", ")}`,
        });
      }
      const result = await toolEngine.execute(tool, args, msgFn, cfg);
      return result;
    },

    /**
     * Builds native tool schemas for providers that support structured tool calling
     * (e.g. Codestral, Groq, OpenAI).
     *
     * Called by Executor._runNative() and executeFromCheckpoint() before each
     * API call. The schemas are passed as the `tools` parameter to the provider
     * API — the model never sees them as text, the API enforces structure.
     *
     * Includes: built-in tools + custom tools + toolRegistry tools,
     * filtered by the active profile's allowedTools list.
     *
     * @param _provider - Reserved for future per-provider schema filtering.
     *                    Prefixed with _ until filterToolsForProvider() is implemented.
     */
    buildToolSchemas: (_provider: string) =>
      providerEngine.buildNativeSchemas(
        profileManager.getAllowedTools(toolEngine.getAllDefinitions()), // toolDefs = built-in + custom + userRegisteredTools found!
      ),

    /**
     * Builds a plain-text tool description block for providers that do NOT
     * support native tool calling (e.g. Cerebras, Gemini, Ollama).
     *
     * Called by Executor._runPrompt() and executeFromCheckpointPrompt() once
     * at message setup. The block is injected into the system prompt so the
     * model reads it as instructions and responds with JSON tool calls.
     *
     * Includes: built-in tools + custom tools + toolRegistry tools,
     * filtered by the active profile's allowedTools list.
     *
     * Output format:
     *   Available tools:
     *   toolName(param1, param2?)
     *     Description of what the tool does
     *   Respond with: [{"tool":"name","args":{...}}]
     */
    buildToolPrompt: () =>
      buildToolSystemPrompt(
        profileManager.getAllowedTools(toolEngine.getAllDefinitions()), // toolDefs = built-in + custom + userRegisteredTools found!
      ),

    profileSystemPrompt: () => profileManager.buildSystemPrompt(),
    profilePlanningPrompt: () => profileManager.getPlanningPrompt(),
    profileBlocksFileEditsOnGit: (task) =>
      profileManager.blocksFileEditsOnGit(task),

    switchProfile: (name) => profileManager.switch(name),

    useNativeTools: (prov) => providerEngine.useNativeTools(prov),

    gatherContext: async (_root: string, task?: string): Promise<string> => {
      return contextEngine.buildContext(task ?? "");
    },

    getActiveProvider: () => providerEngine.getActiveProvider(),
  };

  return { agentConfig, deps, toolEngine, profileManager, providerEngine };
}

// ── createAgent() ─────────────────────────────────────────────────────────────

export interface CreateAgentResult {
  agent: AgentEngine;
  abort: () => void;
  providerEngine: ProviderEngine;
  profileManager: ProfileManager;
  toolEngine: ToolEngine;
}

export function createAgent(options: CreateAgentOptions): CreateAgentResult {
  const controller = new AbortController();

  const resolvedOptions = { ...options };

  // Auto-select "rag" profile if:
  // 1. toolRegistry is passed
  // 2. no profile specified
  // Regardless of which tools are registered!
  if (options.toolRegistry && !options.profile) {
    resolvedOptions.profile = "rag"; // any toolRegistry!
  }

  const { agentConfig, deps, providerEngine, profileManager, toolEngine } =
    buildAgentInternals({
      ...resolvedOptions,
      signal: controller.signal,
    });

  const agent = new AgentEngine(agentConfig, deps);

  if (options.hooks) {
    agent.setHooks(options.hooks);
  }

  return {
    agent,
    abort: () => controller.abort(),
    providerEngine,
    profileManager,
    toolEngine,
  };
}

// ── createDynamicProfile() ────────────────────────────────────────────────────

function createDynamicProfile(
  name: string,
  def: CustomProfileDefinition,
): BaseProfile {
  return Object.assign(Object.create(BaseProfile.prototype), {
    name,
    description: def.description ?? name,
    systemPrompt: def.systemPrompt,
    planningPrompt: def.planningPrompt,
    allowedTools: [...def.allowedTools],
    styleRules: def.styleRules ?? [],
    safetyRules: def.safetyRules ?? [],
    userPrompt: def.userPrompt,
  });
}

// ── attachRegistryTools() ─────────────────────────────────────────────────────

function attachRegistryTools(
  toolEngine: ToolEngine,
  profileManager: ProfileManager,
  registry: ToolRegistry,
): void {
  const customDefs = registry.getCustomTools();

  for (const def of customDefs) {
    toolEngine.register(
      def.name,
      {
        name: def.name,
        description: def.description,
        params: def.params as Record<string, string | ToolParameter>, //   pass params as-is!
        // ToolEngine now supports ToolParameter
      },
      async (args, cfg) => {
        registry.validateArguments(def.name, args);
        const handler = registry.getHandler(def.name);
        if (!handler) {
          return {
            tool: def.name,
            success: false,
            output: `No handler for "${def.name}"`,
          };
        }
        return handler(args, cfg);
      },
    );
  }

  profileManager.addAllowedTools(customDefs.map((d) => d.name));
}

// ── createChat() ──────────────────────────────────────────────────────────────

export interface CreateChatOptions {
  workspaceRoot: string;

  /**
   * Explicit provider for chat. If omitted, ChatEngine falls back to the
   * agent's active provider via setGetActiveProvider().
   * All four fields must be provided together.
   */
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;

  profile?: string; // default: "support"
  systemPrompt?: string;
  userPrompt?: string;
  maxHistory?: number; // default: 20
  memory?: MemoryEngine;
  contextEngine?: ContextEngineType;
}

export interface CreateChatResult {
  chat: ChatEngine;
  profileManager: ProfileManager;
  providerEngine: ProviderEngine;
}

export function createChat(options: CreateChatOptions): CreateChatResult {
  validateChatOptions(options);
  const {
    workspaceRoot,
    provider,
    apiKey,
    model,
    baseUrl,
    profile,
    systemPrompt,
    userPrompt,
    maxHistory,
    memory,
    contextEngine,
  } = options;

  const providerEngine = new ProviderEngine();

  if (provider && apiKey && model && baseUrl) {
    providerEngine.setProviderConfig(provider, { apiKey, model, baseUrl });
    providerEngine.setActiveProvider(provider);
  }

  const profileManager = new ProfileManager();
  profileManager.switch(profile ?? "support");

  const chat = new ChatEngine({
    workspaceRoot,
    provider,
    profile,
    systemPrompt,
    userPrompt,
    maxHistory,
    memory,
    contextEngine,
  });

  if (provider && apiKey && model && baseUrl) {
    chat.setCallAI((msgs, prov) => providerEngine.callAI(msgs, prov));
    chat.setCallAIStream((msgs, prov, onChunk) =>
      providerEngine.callAIStream(msgs, prov, onChunk),
    );
  }

  chat.setProfileSystemPrompt(() => profileManager.buildSystemPrompt());
  chat.setSwitchProfile((name) => profileManager.switch(name));

  return { chat, profileManager, providerEngine };
}
