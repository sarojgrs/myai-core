/**
 * Framework-agnostic agent loop
 *
 * Zero vscode imports. Works in VS Code, CLI, or any other environment.
 * VS Code specific behavior is injected via AgentConfig (onMessage, workspaceRoot, confirm).
 * Memory is optional — pass a MemoryEngine instance to enable all 3 layers.
 */

import type { ErrorHandler } from "../ErrorHandler";
import type { NativeTool } from "./ProviderEngine";

import { LoopDetector } from "./agent/LoopDetector";
import { Planner } from "./agent/Planner";
import { Executor, ExecutorCheckpoint } from "./agent/Executor";
import { PipelineRunner } from "./agent/PipelineRunner";
import { CacheEngine } from "./strategies/CacheStrategy";
import { AgentLifecycleHooks } from "./hooks/AgentLifecycleHooks";
import { hashKey } from "../utils/HashKey";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal memory interface — avoids circular import with MemoryEngine */
export interface AgentMemory {
  remember(entry: {
    task: string;
    summary: string;
    filesChanged: string[];
    toolsUsed: string[];
    success: boolean;
    turnsUsed: number;
    tokensUsed?: number;
  }): void;
  trackFileTouched(filePath: string): void;
  trackToolUsed(tool: string): void;
  clearRun(): void;
}

/** Message type — strict roles only */
export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  role: MessageRole;
  content: string;
  timestamp?: number;
}

/** Agent message types for callbacks */
export type AgentMessageType =
  | "agentStart"
  | "agentPlan"
  | "agentTurn"
  | "agentTool"
  | "agentRetry"
  | "agentThink"
  | "agentDone"
  | "agentError"
  | "pipelineStart"
  | "pipelineStep"
  | "pipelineStepDone"
  | "pipelineDone"
  | "pipelineError"
  | "runOutput";

export interface AgentMessage {
  type: AgentMessageType;
  text: string;
  metadata?: Record<string, unknown>;
  turn?: number;
  step?: number;
  total?: number;
  totalSteps?: number;
  provider?: string;
  profile?: string;
  attempt?: number;
  success?: boolean;
}

export interface AgentConfig {
  provider: string;
  workspaceRoot: string;
  onMessage: (msg: AgentMessage) => void;
  profile?: string;
  maxTurns?: number;
  confirm?: (message: string) => Promise<boolean>;
  memory?: AgentMemory;
  /** Override the profile's built-in system prompt entirely. */
  systemPrompt?: string;
  /** Prepended to every user task — use for team conventions, project rules, etc. */
  userPrompt?: string;
  /** Override the profile's built-in planning instructions entirely. */
  planningPrompt?: string;
  /** Tool registry for dynamic tool registration and hot-reload support */
  toolRegistry?: import("./registry/ToolRegistry").ToolRegistry;
  /** To abort active agent/agents */
  signal?: AbortSignal;

  /**
   * Maximum total tokens the agent may spend across all turns in one run.
   * Checked after every turn via AgentLifecycleHooks.shouldContinue — wire
   * TokenBudgetHooks for rich enforcement, or the raw fallback fires automatically.
   * Has no effect if not set.
   */
  tokenBudget?: number;

  /**
   * Internal — wired by factory.ts to contextEngine.notifyToolExecuted().
   * Called by Executor after every successful tool execution.
   * ContextEngine checks all providers and invalidates those that declare
   * the tool in their invalidateOn list.
   * Not part of the public client API.
   */
  onToolExecuted?: (toolName: string) => void;
}

export interface CallAIResult {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface AgentResult {
  success: boolean;
  summary: string;
  toolsUsed: string[];
  turnsUsed: number;
  filesChanged: string[];
  tokensUsed?: number;
  error?: string;
  /**
   * Opaque run identifier returned by every agent.run() call.
   * Pass to agent.getCheckpoint(task, runId) to retrieve the last
   * saved checkpoint for this run — useful for resuming after an
   * abort, timeout, or maxTurns cap within the same process lifetime.
   */
  runId?: string;
}

export interface CallAIWithToolsResult {
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

// ── Planner / Executor extension points ───────────────────────────────────────

export interface PlannerContext {
  task: string;
  projectContext: string;
  config: AgentConfig;
  overrides?: Partial<AgentConfig>;
}

export interface ExecutorContext {
  task: string;
  plan: string;
  provider: string;
  projectContext: string;
  toolsUsed: string[];
  config: AgentConfig;
  nativeTools: boolean;
  /** Lifecycle hooks — single source of truth is AgentLifecycleHooks.ts */
  hooks?: AgentLifecycleHooks;
  /** Token budget ceiling from AgentConfig.tokenBudget. Passed explicitly so Executor never reads AgentConfig directly. */
  tokenBudget?: number;
}

// ── Pipeline types ────────────────────────────────────────────────────────────

export interface PipelineStep {
  task: string;
  provider?: string;
  profile?: string;
  systemPrompt?: string;
  userPrompt?: string;
  planningPrompt?: string;
}

export interface PipelineStepResult {
  step: number;
  task: string;
  provider: string;
  profile: string;
  result: AgentResult;
}

export interface PipelineResult {
  success: boolean;
  steps: PipelineStepResult[];
  summary: string;
  totalTurnsUsed: number;
  totalFilesChanged: string[];
  totalToolsUsed: string[];
  failedAtStep: number;
}

// ── Required dependencies (must be provided at construction time) ─────────────

export interface AgentEngineDeps {
  /** Call the AI with plain messages (prompt-injection mode). Required. */
  callAI: (messages: Message[], provider: string) => Promise<CallAIResult>;

  /** Execute a tool by name and return its output. Required. */
  executeTool: (
    tool: string,
    args: Record<string, string>,
    onMessage: (msg: any) => void,
    config: AgentConfig,
  ) => Promise<{ tool: string; success: boolean; output: string }>;

  /** Call the AI with native tool schemas (native tool-call mode). Optional. */
  callAIWithTools?: (
    messages: Message[],
    tools: NativeTool[],
    provider: string,
  ) => Promise<CallAIWithToolsResult>;

  /** Return JSON schemas for all tools for the given provider. Optional. */
  buildToolSchemas?: (provider: string) => any[];

  /** Return the prompt-injection tool description block. Optional. */
  buildToolPrompt?: () => string;

  /** Gather project context from the workspace root. Optional. */
  gatherContext?: (workspaceRoot: string, task?: string) => Promise<string>;

  /** Return true if the provider supports native tool calling. Optional. */
  useNativeTools?: (provider: string) => boolean;

  /** Return the active profile's system prompt. Optional. */
  profileSystemPrompt?: () => string;

  /** Return the active profile's planning prompt. Optional. */
  profilePlanningPrompt?: () => string;

  /** Return true if the task is a git task (blocks file edits). Optional. */
  profileBlocksFileEditsOnGit?: (task: string) => boolean;

  /** Switch the active profile by name. Optional. */
  switchProfile?: (name: string) => void;

  getActiveProvider: () => string;
}

// ── AgentEngine class ─────────────────────────────────────────────────────────

export class AgentEngine {
  private config: AgentConfig;
  private profile: string;
  private maxTurns: number;
  private totalTokens: number = 0;

  private loopDetector = new LoopDetector();
  private planner: Planner;
  private executor: Executor;
  private pipelineRunner?: PipelineRunner;

  // Resolved deps — kept as fields so optional hooks (plannerFn/executorFn)
  // can still reference them if needed, and for pipeline profile switching.
  private readonly deps: AgentEngineDeps;

  // Optional pluggable planner / executor overrides
  private plannerFn?: (ctx: PlannerContext) => Promise<string>;
  private executorFn?: (ctx: ExecutorContext) => Promise<AgentResult>;

  // Post-construction override for gatherContext — used by adapters (VSCode,
  // CLI) that need richer context (editor state, task capturing, etc.) than
  // what was wired in deps at construction time.
  private gatherContextOverride?: (
    workspaceRoot: string,
    task?: string,
  ) => Promise<string>;

  // Optional error handler for custom error recovery strategies
  private errorHandler?: ErrorHandler;

  // Lifecycle hooks.
  // All hook types, built-ins (LoggingHooks, TokenBudgetHooks etc.), and
  // composeHooks() live in AgentLifecycleHooks.ts and are re-exported from here.
  private hooks?: AgentLifecycleHooks;

  // short-lived context cache so sequential run() calls (pipelines,
  // multi-step workflows) don't rebuild filesystem + memory context from scratch
  // on every step. Backed by CacheEngine — the same TTL store ContextEngine uses —
  // so there is no hand-rolled Map+expiresAt duplication anywhere in the codebase.
  // TTL is intentionally short (5 s) so interactive use always sees fresh context.
  private _contextCache = new CacheEngine<string>({
    logPrefix: "AgentEngine.contextCache",
  });
  private readonly _contextCacheTtlMs = 5_000; // 5 seconds

  constructor(config: AgentConfig, deps: AgentEngineDeps) {
    // Validate required deps eagerly so callers get a clear error immediately.
    if (typeof deps.callAI !== "function") {
      throw new Error(
        "AgentEngine: deps.callAI is required and must be a function.",
      );
    }
    if (typeof deps.executeTool !== "function") {
      throw new Error(
        "AgentEngine: deps.executeTool is required and must be a function.",
      );
    }

    this.config = config;
    this.deps = deps;
    this.profile = config.profile ?? "code";
    this.maxTurns = config.maxTurns ?? 10;

    // Wire Planner
    this.planner = new Planner();
    // Wrap provider calls with retry/fallback logic driven by ErrorHandler
    this.planner.setCallAI(this._callAIResilient.bind(this));
    if (deps.profileSystemPrompt) {
      this.planner.setProfileSystemPrompt(deps.profileSystemPrompt);
    }
    if (deps.profilePlanningPrompt) {
      this.planner.setProfilePlanningPrompt(deps.profilePlanningPrompt);
    }

    // Wire Executor — all deps injected here, never scattered across setters
    this.executor = new Executor(this.maxTurns, this.loopDetector);
    this.executor.setCallAI(this._callAIResilient.bind(this));
    this.executor.setExecuteTool(deps.executeTool);
    if (deps.callAIWithTools) {
      this.executor.setCallAIWithTools(
        this._callAIWithToolsResilient.bind(this),
      );
    }
    if (deps.buildToolSchemas) {
      this.executor.setBuildToolSchemas(deps.buildToolSchemas);
    }
    if (deps.buildToolPrompt) {
      this.executor.setBuildToolPrompt(deps.buildToolPrompt);
    }
  }

  // ── Profile switching (runtime only, does not affect wired deps) ──────────

  setProfile(name: string): void {
    this.profile = name;
  }

  // ── Context override ──────────────────────────────────────────────────────
  //
  // Adapters (VSCodeAdapter, CLIAdapter) call this after createAgent() to
  // supply richer context (editor state, task-aware memory recall, etc.).
  // Takes precedence over deps.gatherContext set at construction time.
  setGatherContext(
    fn: (workspaceRoot: string, task?: string) => Promise<string>,
  ): void {
    this.gatherContextOverride = fn;
  }

  // ── Optional custom planner / executor hooks ──────────────────────────────

  /**
   * Override the default planning behavior.
   * If set, run() calls this instead of the built-in planning turn.
   */
  setPlanner(fn: (ctx: PlannerContext) => Promise<string>): void {
    this.plannerFn = fn;
  }

  /**
   * Override the default execution behavior.
   * If set, run() calls this instead of the built-in executor.
   * Memory integration still happens in run().
   */
  setExecutor(fn: (ctx: ExecutorContext) => Promise<AgentResult>): void {
    this.executorFn = fn;
  }

  /**
   * Set a custom error handler for handling failures during execution.
   * The error handler can decide to retry, fallback, skip, continue, or abort.
   */
  setErrorHandler(handler: ErrorHandler): void {
    this.errorHandler = handler;
    // Also pass error handler to executor
    if (this.executor) {
      this.executor.setErrorHandler(handler);
    }
  }

  getErrorHandler(): ErrorHandler | undefined {
    return this.errorHandler;
  }

  /**
   * Wire lifecycle hooks
   * use composeHooks() to combine multiple hook sets.
   * Safe to call multiple times — later call replaces earlier.
   */
  setHooks(hooks: AgentLifecycleHooks): void {
    this.hooks = hooks;
  }

  /**
   * Release owned resources.
   * Call this when the agent instance is no longer needed — especially in
   * multi-agent or pipeline scenarios where many engines are created.
   * Safe to call multiple times.
   */
  dispose(): void {
    this._contextCache.invalidateAll();
    this.loopDetector.reset();
    // hooks and overrides are plain references — just drop them
    this.hooks = undefined;
    this.plannerFn = undefined;
    this.executorFn = undefined;
    this.gatherContextOverride = undefined;
  }

  // ── Resilient provider calls (retry + fallback) ─────────────────────────--

  private async _callAIResilient(
    messages: Message[],
    provider: string,
  ): Promise<CallAIResult> {
    const invoke = (prov: string) => this.deps.callAI(messages, prov);
    return this._withRetryAndFallback(invoke, provider, false, messages);
  }

  private async _callAIWithToolsResilient(
    messages: any[],
    tools: any[],
    provider: string,
  ): Promise<CallAIWithToolsResult> {
    if (!this.deps.callAIWithTools) {
      throw new Error("AgentEngine: deps.callAIWithTools not provided");
    }
    const invoke = (prov: string) =>
      this.deps.callAIWithTools!(messages, tools, prov);
    return this._withRetryAndFallback(invoke, provider, true, messages);
  }

  private async _withRetryAndFallback<T>(
    invoke: (prov: string) => Promise<T>,
    provider: string,
    nativeToolsRequired: boolean,
    lastMessages?: Message[],
  ): Promise<T> {
    // If no error handler is set, perform a single attempt
    if (!this.errorHandler) {
      return invoke(provider);
    }

    const onMessage = this.config.onMessage;

    let attempt = 0;
    let lastError: any;

    // First, retry on the same provider
    while (true) {
      try {
        return await invoke(provider);
      } catch (err: any) {
        lastError = err;
        attempt++;
        const action = this.errorHandler.handleError({
          turn: 0,
          provider,
          error: err instanceof Error ? err : new Error(String(err)),
          lastMessages,
          currentTask: undefined,
        });
        const maxRetries = action.maxRetries ?? 0;
        const baseDelay = action.delay ?? 0;

        if (attempt <= maxRetries) {
          // exponential backoff with ±30% jitter so multiple concurrent
          // agents that all fail at the same time do NOT retry in lockstep.
          // Without jitter they all hammer the provider again at the same instant,
          // making rate-limit recovery much worse (thundering herd).
          const expDelay = baseDelay * Math.pow(2, attempt - 1);
          const jitter = (Math.random() * 0.6 - 0.3) * expDelay; // ±30%
          const finalDelay = Math.max(0, expDelay + jitter);

          onMessage?.({
            type: "agentRetry",
            text: `Provider ${provider} failed: ${err?.message || err}. Retrying (${attempt}/${maxRetries})...`,
            attempt,
          });
          if (finalDelay > 0)
            await new Promise((r) => setTimeout(r, finalDelay));
          continue;
        }

        // Retries exhausted; consider fallback if configured
        const fallbackProv = action.provider;
        if (!fallbackProv) break; // no fallback configured

        if (
          nativeToolsRequired &&
          this.deps.useNativeTools &&
          !this.deps.useNativeTools(fallbackProv)
        ) {
          onMessage?.({
            type: "agentTool",
            text: `Fallback provider ${fallbackProv} does not support native tools. Aborting failover.`,
          });
          break;
        }

        onMessage?.({
          type: "agentTool",
          text: `Switching provider: ${provider} → ${fallbackProv}`,
        });

        // Try fallback with its own retry loop (also with jitter)
        let fbAttempt = 0;
        while (true) {
          try {
            return await invoke(fallbackProv);
          } catch (err2: any) {
            lastError = err2;
            fbAttempt++;
            const fbAction = this.errorHandler.handleError({
              turn: 0,
              provider: fallbackProv,
              error: err2 instanceof Error ? err2 : new Error(String(err2)),
              lastMessages,
              currentTask: undefined,
            });
            const fbMax = fbAction.maxRetries ?? 0;
            const fbBaseDelay = fbAction.delay ?? 0;
            if (fbAttempt <= fbMax) {
              // same jitter treatment for the fallback retry loop
              const fbExpDelay = fbBaseDelay * Math.pow(2, fbAttempt - 1);
              const fbJitter = (Math.random() * 0.6 - 0.3) * fbExpDelay; // ±30%
              const fbFinalDelay = Math.max(0, fbExpDelay + fbJitter);

              onMessage?.({
                type: "agentRetry",
                text: `Fallback provider ${fallbackProv} failed: ${err2?.message || err2}. Retrying (${fbAttempt}/${fbMax})...`,
                attempt: fbAttempt,
              });
              if (fbFinalDelay > 0)
                await new Promise((r) => setTimeout(r, fbFinalDelay));
              continue;
            }
            break; // fallback exhausted
          }
        }
        break; // give up after fallback exhaustion
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // ── System prompt resolution ──────────────────────────────────────────────

  private _resolveSystemPrompt(
    projectContext: string,
    overrides?: Partial<AgentConfig>,
  ): string {
    const cfg = overrides ? { ...this.config, ...overrides } : this.config;
    const persona =
      cfg.systemPrompt ??
      (this.deps.profileSystemPrompt ? this.deps.profileSystemPrompt() : null);
    return persona ? `${persona}\n\n${projectContext}` : projectContext;
  }

  /**
   * nvalidate the context cache for a specific workspace+task,
   * or clear all entries if called with no arguments.
   *
   * Call this after a tool that modifies the workspace (e.g. a large refactor)
   * completes if you want the next run() to gather fresh context rather than
   * serving the cached version within the TTL window.
   */
  invalidateContextCache(workspaceRoot?: string, task?: string): void {
    if (workspaceRoot !== undefined && task !== undefined) {
      // CacheEngine.invalidate() — same contract as before, now using the shared engine
      this._contextCache.invalidate(hashKey(workspaceRoot, task));
    } else {
      this._contextCache.invalidateAll();
    }
  }

  // ── Checkpoint resume ─────────────────────────────────────────────────────
  //
  // The Executor saves a checkpoint after every turn automatically.
  // Call resumeFromCheckpoint() instead of run() to continue an interrupted run.
  //
  // Checkpoints survive: abort signals, maxTurns cap, token budget exceeded,
  // hook-driven stops, and AI call errors — within the same process lifetime.
  // They do NOT survive process restarts (stored in-memory, expire after 30 min).
  //
  // Typical usage:
  //
  //   const task = "refactor auth module";
  //
  //   // On first run, save runId so you can resume if interrupted
  //   const result = await agent.run(task);
  //   if (!result.success && result.runId) {
  //     const cp = agent.getCheckpoint(task);
  //     if (cp) {
  //       // Checkpoint found — pick up from turn cp.turn
  //       const resumed = await agent.resumeFromCheckpoint(cp);
  //     }
  //   }
  //
  // Or use the run-and-resume helper for the common case:
  //
  //   const result = await agent.runWithResume(task);

  /**
   * Retrieve the most recent non-expired checkpoint for a task.
   * Returns undefined if no checkpoint exists or it has expired (>30 min).
   * The client only needs the task string — runId is internal.
   */
  async getCheckpoint(task: string): Promise<ExecutorCheckpoint | undefined> {
    return this.executor.loadLatestCheckpoint(task);
  }

  /**
   * Manually clear the checkpoint for a task.
   * Normally you don't need this — checkpoints are cleared automatically
   * on successful completion of resumeFromCheckpoint().
   */
  async clearCheckpoint(task: string): Promise<void> {
    const cp = this.executor.loadLatestCheckpoint(task);
    if (cp) {
      this.executor.clearCheckpoint(cp.task, cp.runId);
    }
  }

  async resumeFromCheckpoint(
    cp: import("./agent/Executor").ExecutorCheckpoint,
    overrides?: Partial<AgentConfig>,
  ): Promise<AgentResult> {
    const cfg = overrides ? { ...this.config, ...overrides } : this.config;
    const { onMessage, memory } = cfg;

    memory?.clearRun();
    this.totalTokens = 0;
    this.loopDetector.reset();

    const activeProvider = overrides?.provider
      ? cfg.provider
      : this.deps.getActiveProvider
        ? this.deps.getActiveProvider()
        : cfg.provider;

    const nativeTools = this.deps.useNativeTools
      ? this.deps.useNativeTools(activeProvider)
      : false;

    // Re-resolve system prompt so resumed runs get the same persona.
    // We pass cp.plan as the context placeholder since original projectContext
    // is not stored in the checkpoint — the system message is already baked
    // into cp.messages[0], but _resolveSystemPrompt is kept consistent.
    const resolvedSystemPrompt = this._resolveSystemPrompt(
      `Resuming task: ${cp.task}`,
      overrides,
    );

    onMessage({ type: "agentStart", text: `↩ Resuming: ${cp.task}` });

    // Build the same ExecutorContext that the original run used, so all
    // hooks, tokenBudget, and provider flow through correctly on resume.
    const execCtx: ExecutorContext = {
      task: cp.task,
      plan: cp.plan,
      provider: activeProvider,
      projectContext: resolvedSystemPrompt,
      toolsUsed: [...cp.toolsUsed],
      config: cfg,
      nativeTools,
      hooks: this.hooks,
      tokenBudget: cfg.tokenBudget,
    };

    let result: AgentResult;
    if (nativeTools) {
      result = await this.executor.executeFromCheckpoint(cp, execCtx);
    } else {
      result = await this.executor.executeFromCheckpointPrompt(cp, execCtx);
    }

    if (memory) {
      const cleanSummary = result.summary.replace(/\*\*/g, "").trim();
      memory.remember({
        task: cp.task,
        summary: cleanSummary.slice(0, 300),
        filesChanged: result.filesChanged,
        toolsUsed: result.toolsUsed,
        success: result.success,
        turnsUsed: result.turnsUsed,
        tokensUsed: (result.tokensUsed ?? 0) + this.totalTokens,
      });
    }

    const finalResult: AgentResult = {
      ...result,
      tokensUsed: (result.tokensUsed ?? 0) + this.totalTokens,
    };

    if (this.hooks?.onComplete) {
      try {
        await this.hooks.onComplete(finalResult);
      } catch (err: any) {
        console.error(
          "[AgentEngine] onComplete hook threw on resume:",
          err?.message ?? err,
        );
      }
    }

    // Clear checkpoint only on clean success — leave it intact on failure
    // so the caller can inspect or retry again.
    if (finalResult.success) {
      this.executor.clearCheckpoint(cp.task, cp.runId);
    }

    return finalResult;
  }

  /**
   * Run a task, automatically resuming from a checkpoint if one exists.
   *
   * This is the recommended entry point for most use cases. It handles the
   * full check-then-run-or-resume pattern in one call:
   *
   *   // Instead of this:
   *   const cp = agent.getCheckpoint(task);
   *   const result = cp
   *     ? await agent.resumeFromCheckpoint(cp)
   *     : await agent.run(task);
   *
   *   // Just do this:
   *   const result = await agent.runWithResume(task);
   *
   * @param task   The task string — same value you'd pass to run()
   * @param overrides  Optional AgentConfig overrides, same as run()
   */
  async runWithResume(
    task: string,
    overrides?: Partial<AgentConfig>,
  ): Promise<AgentResult> {
    const cp = await this.getCheckpoint(task);
    if (cp) {
      console.log(
        `[AgentEngine] Found checkpoint at turn ${cp.turn} for task "${task}" — resuming`,
      );
      return this.resumeFromCheckpoint(cp, overrides);
    }
    return this.run(task, overrides);
  }

  // ── run() ─────────────────────────────────────────────────────────────────

  async run(
    task: string,
    overrides?: Partial<AgentConfig>,
  ): Promise<AgentResult> {
    const cfg = overrides ? { ...this.config, ...overrides } : this.config;
    // do NOT destructure `provider` from cfg here — cfg.provider is
    // the original config value and may not reflect a runtime setActiveProvider()
    // call or a pipeline step override. Resolve activeProvider first, then use
    // it as the single source of truth for the entire run.
    const { onMessage, workspaceRoot, memory } = cfg;
    const toolsUsed: string[] = [];

    memory?.clearRun();
    this.totalTokens = 0;
    this.loopDetector.reset();

    // activeProvider is now resolved before anything else and is the
    // definitive provider for this run — used for logging, execCtx, and nativeTools.
    // Explicit override wins, then runtime getActiveProvider(), then config default.
    const activeProvider = overrides?.provider
      ? cfg.provider // explicit override wins
      : this.deps.getActiveProvider
        ? this.deps.getActiveProvider() // runtime switch
        : cfg.provider; // original default

    // use activeProvider (not the old destructured `provider`)
    // so execCtx.provider, nativeTools, and logs all reference the same value.
    const provider = activeProvider;

    const nativeTools = this.deps.useNativeTools
      ? this.deps.useNativeTools(activeProvider)
      : false;

    console.log(
      `[AgentEngine] provider=${activeProvider} nativeTools=${nativeTools} maxTurns=${this.maxTurns} profile=${this.profile}`,
    );

    // ── Gather context ────────────────────────────────────────────────────
    // Override (set by adapters) takes precedence over deps.gatherContext
    let projectContext = `You are an autonomous agent working in: ${workspaceRoot}`;
    const gatherFn = this.gatherContextOverride ?? this.deps.gatherContext;
    if (gatherFn) {
      try {
        // cache the gathered context using CacheEngine (the same TTL
        // store ContextEngine uses) so there is no hand-rolled expiry logic here.
        // Pipeline steps and rapid sequential run() calls skip the gatherFn when
        // a valid cached value exists within the 5 s TTL.
        const cacheKey = hashKey(workspaceRoot, task);
        const cached = this._contextCache.get(cacheKey); // CacheEngine handles expiry
        if (cached !== undefined) {
          projectContext = cached;
        } else {
          projectContext = await gatherFn(workspaceRoot, task);
          if (typeof projectContext !== "string") {
            throw new Error("gatherContext must return a string");
          }
          // CacheEngine.set(key, value, ttl) — ttl in ms, same contract as ContextEngine
          this._contextCache.set(
            cacheKey,
            projectContext,
            this._contextCacheTtlMs,
          );
        }
      } catch (err: any) {
        onMessage({
          type: "agentError",
          text: `Failed to gather context: ${err.message}`,
        });
      }
    }

    // keep `projectContext` as raw workspace context only.
    // Previously it was immediately overwritten with _resolveSystemPrompt()
    // (persona + context combined), then passed to Planner whose own
    // _resolveSystemPrompt() prepended the persona AGAIN, sending a doubled
    // persona to the planning AI. Now:
    //   • projectContext  → raw context, passed to Planner as-is
    //   • resolvedSystemPrompt → persona + context, used only by Executor
    //     (Executor._resolveSystemPrompt already receives it and does not
    //     add the persona a second time)
    const resolvedSystemPrompt = this._resolveSystemPrompt(
      projectContext,
      overrides,
    );

    onMessage({ type: "agentStart", text: task });

    // ── Turn 0: Planning ──────────────────────────────────────────────────
    let plan = "";
    if (this.plannerFn) {
      try {
        // pass raw projectContext to custom planner — it does its own
        // system prompt resolution and must not receive an already-doubled persona.
        plan = await this.plannerFn({
          task,
          projectContext,
          config: cfg,
          overrides,
        });
        if (plan.trim()) {
          onMessage({ type: "agentPlan", text: plan.trim() });
        }
      } catch (err: any) {
        onMessage({
          type: "agentTool",
          text: `Custom planner failed: ${err.message ?? "unknown error"}`,
        });
      }
    } else {
      try {
        onMessage({ type: "agentTurn", text: "⟳ Planning..." });
        // pass raw projectContext so Planner._resolveSystemPrompt()
        // adds the persona exactly once.
        const result = await this.planner.plan({
          task,
          projectContext,
          config: cfg,
          overrides,
        });
        plan = result.plan;
        this.totalTokens += result.tokensUsed;
        onMessage({ type: "agentPlan", text: plan.trim() });
      } catch (err: any) {
        onMessage({
          type: "agentTool",
          text: `Planning step failed – proceeding without plan (${err.message || err})`,
        });
      }
    }

    // ── afterPlan hook (AgentLifecycleHooks) ──────────────────────────────
    // Single source of truth: AgentLifecycleHooks.afterPlan(plan, task).
    // Can return a modified plan string or void/undefined to keep as-is.
    // Errors are caught — a bad hook never kills the run.
    if (this.hooks?.afterPlan && plan.trim()) {
      try {
        const mutated = await this.hooks.afterPlan(plan, task);
        if (typeof mutated === "string" && mutated.trim()) {
          plan = mutated;
        }
      } catch (err: any) {
        onMessage({
          type: "agentTool",
          text: `afterPlan hook threw: ${err.message ?? err}`,
        });
      }
    }

    // ── Execution ─────────────────────────────────────────────────────────
    let result: AgentResult;
    const execCtx: ExecutorContext = {
      task,
      plan,
      // use `provider` which is now derived from `activeProvider`,
      // not the stale destructured cfg.provider from before activeProvider resolution.
      provider,
      // Executor receives the fully resolved system prompt (persona +
      // raw context combined). Executor._resolveSystemPrompt() passes it through
      // as-is when it is already a resolved string — no double-prepend.
      projectContext: resolvedSystemPrompt,
      toolsUsed,
      config: cfg,
      nativeTools,
      // Single source of truth: AgentLifecycleHooks.ts — Executor uses the same type
      hooks: this.hooks,
      // Token budget — passed explicitly so Executor never reads AgentConfig directly
      tokenBudget: cfg.tokenBudget,
    };

    if (this.executorFn) {
      result = await this.executorFn(execCtx);
    } else {
      result = await this.executor.execute(execCtx);
    }

    // ── Store to memory ───────────────────────────────────────────────────
    if (memory) {
      const cleanSummary = result.summary.replace(/\*\*/g, "").trim();
      memory.remember({
        task,
        summary: cleanSummary.slice(0, 300),
        filesChanged: result.filesChanged,
        toolsUsed: result.toolsUsed,
        success: result.success,
        turnsUsed: result.turnsUsed,
        tokensUsed: (result.tokensUsed ?? 0) + this.totalTokens,
      });
    }

    const finalResult: AgentResult = {
      ...result,
      tokensUsed: (result.tokensUsed ?? 0) + this.totalTokens,
    };

    // ── onComplete hook (AgentLifecycleHooks) ─────────────────────────────
    // Called on both success and failure. Errors are swallowed — the hook
    // must never affect the returned result (per AgentLifecycleHooks contract).
    if (this.hooks?.onComplete) {
      try {
        await this.hooks.onComplete(finalResult);
      } catch (err: any) {
        console.error(
          "[AgentEngine] onComplete hook threw:",
          err?.message ?? err,
        );
      }
    }

    return finalResult;
  }

  // ── runPipeline() ─────────────────────────────────────────────────────────

  async runPipeline(steps: PipelineStep[]): Promise<PipelineResult> {
    if (!this.pipelineRunner) {
      this.pipelineRunner = new PipelineRunner(
        this.config,
        this.profile,
        this.run.bind(this),
      );
      if (this.deps.switchProfile) {
        this.pipelineRunner.setSwitchProfile(this.deps.switchProfile);
      }
    }
    return this.pipelineRunner.runPipeline(steps);
  }
}
