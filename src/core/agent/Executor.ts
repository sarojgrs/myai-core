/**
 * Execution logic for agent tasks
 */

/**
 * Execution logic for agent tasks
 *
 * Architecture:
 *   execute()                    → entry point, validates deps, routes to native or prompt
 *   _runNative(ctx)              → fresh native run:  builds messages, calls _runLoop("native")
 *   _runPrompt(ctx)              → fresh prompt run:  builds messages, calls _runLoop("prompt")
 *   executeFromCheckpoint()      → resumed native run: restores state,  calls _runLoop("native")
 *   executeFromCheckpointPrompt()→ resumed prompt run: restores state,  calls _runLoop("prompt")
 *
 *   _runLoop()                   → shared turn loop — the single source of truth for all
 *                                  execution logic: hooks, tool dispatch, checkpointing, pruning.
 *                                  The only difference between native and prompt is how the AI
 *                                  is called and how tool calls are parsed — everything else
 *                                  is identical and lives here exactly once.
 */

import {
  AgentConfig,
  AgentResult,
  CallAIWithToolsResult,
  Message,
  CallAIResult,
} from "../AgentEngine";

import {
  AgentLifecycleHooks,
  AgentTurnState,
  ToolExecutionContext,
} from "../hooks/AgentLifecycleHooks";

import { LoopDetector } from "./LoopDetector";

export interface ExecutorContext {
  task: string;
  plan: string;
  provider: string;
  projectContext: string;
  toolsUsed: string[];
  config: AgentConfig;
  nativeTools: boolean;
  /** AgentLifecycleHooks */
  hooks?: AgentLifecycleHooks;
  /** Token budget ceiling — checked via shouldContinue after every turn */
  tokenBudget?: number;
}

interface ParsedToolCall {
  tool: string;
  args: Record<string, string>;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
export interface ExecutorCheckpoint {
  task: string;
  plan: string;
  turn: number;
  messages: any[];
  filesChanged: string[];
  toolsUsed: string[];
  tokensUsed: number;
  lastInputTokens: number;
  timestamp: number;
  // store the actual fixedHeader computed at run start so
  // executeFromCheckpoint() doesn't use a wrong hardcoded value of 4.
  fixedHeader: number;
  // persist expiryMap so message pruning works correctly on resume.
  // Map serialises as Array<[number, number]> for JSON round-trip.
  expiryMap: Array<[number, number]>;
  // unique runId prevents same-task concurrent runs from
  // overwriting each other's checkpoints.
  runId: string;
}

// ── Internal context passed to _runLoop ───────────────────────────────────────

interface RunLoopContext {
  /** "native" uses callAIWithToolsFn + tool_calls array.
   *  "prompt" uses callAIFn + _parseAllToolCalls on content string. */
  mode: "native" | "prompt";
  /** Pre-built message array — system + user + optional plan messages. */
  agentMessages: any[];
  /** Turn to start from. Fresh runs start at 1, resumes start at cp.turn+1. */
  startTurn: number;
  /** Run identifier — fresh runs generate a new one, resumes use cp.runId. */
  runId: string;
  /** Index of the last immutable header message (system + user + plan). */
  fixedHeader: number;
  /** TTL map restored from checkpoint on resume, empty for fresh runs. */
  expiryMap: Map<number, number>;
  /** Native tool schemas — only used when mode="native". */
  schemas?: any[];
  /** Cumulative tokens at loop start — 0 for fresh, cp.tokensUsed for resume. */
  initialTokens: number;
  /** Last prompt token count for delta tracking — 0 for fresh or prompt mode. */
  initialLastInputTokens: number;
  /** Full executor context (task, plan, provider, hooks, cfg, etc.). */
  ctx: ExecutorContext;
}

export class Executor {
  private callAIWithToolsFn?: (
    messages: any[],
    tools: any[],
    provider: string,
  ) => Promise<CallAIWithToolsResult>;
  private callAIFn?: (
    messages: Message[],
    provider: string,
  ) => Promise<CallAIResult>;
  private executeToolFn?: (
    tool: string,
    args: Record<string, string>,
    onMessage: (msg: any) => void,
    config: AgentConfig,
  ) => Promise<{ tool: string; success: boolean; output: string }>;
  private buildToolSchemasForProvider?: (provider: string) => any[];
  private buildToolPromptFn?: () => string;
  private maxTurns: number;
  private loopDetector: LoopDetector;
  private errorHandler?: any; // Optional error handler for custom recovery

  constructor(maxTurns: number, loopDetector: LoopDetector) {
    this.maxTurns = maxTurns;
    this.loopDetector = loopDetector;
  }

  setCallAIWithTools(
    fn: (
      messages: any[],
      tools: any[],
      provider: string,
    ) => Promise<CallAIWithToolsResult>,
  ) {
    this.callAIWithToolsFn = fn;
  }

  setCallAI(
    fn: (messages: Message[], provider: string) => Promise<CallAIResult>,
  ) {
    this.callAIFn = fn;
  }

  setExecuteTool(
    fn: (
      tool: string,
      args: Record<string, string>,
      onMessage: (msg: any) => void,
      config: AgentConfig,
    ) => Promise<{ tool: string; success: boolean; output: string }>,
  ) {
    this.executeToolFn = fn;
  }

  setBuildToolSchemas(fn: (provider: string) => any[]) {
    this.buildToolSchemasForProvider = fn;
  }

  setBuildToolPrompt(fn: () => string) {
    this.buildToolPromptFn = fn;
  }

  setErrorHandler(handler: any) {
    this.errorHandler = handler;
  }

  // ── Checkpoint store ──────────────────────────────────────────────────────

  private checkpointStore: Map<string, ExecutorCheckpoint> = new Map();

  saveCheckpoint(cp: ExecutorCheckpoint): void {
    // key by task+runId — parallel runs of the same task no longer
    // overwrite each other's checkpoints.
    this.checkpointStore.set(`${cp.task}:${cp.runId}`, cp);
    console.log(
      `[Executor] Checkpoint saved at turn ${cp.turn} (runId=${cp.runId})`,
    );
  }

  loadCheckpoint(task: string, runId: string): ExecutorCheckpoint | undefined {
    const cp = this.checkpointStore.get(`${task}:${runId}`);
    if (!cp) return undefined;

    // Stale checkpoint — older than 30 minutes, ignore it
    const thirtyMinutes = 30 * 60 * 1000;
    if (Date.now() - cp.timestamp > thirtyMinutes) {
      this.checkpointStore.delete(`${task}:${runId}`);
      console.log(`[Executor] Checkpoint expired, starting fresh`);
      return undefined;
    }

    return cp;
  }

  /**
   * Look up the most recent checkpoint for a task without knowing the runId.
   * Returns the checkpoint with the highest turn number that has not expired.
   * This is the primary lookup used by AgentEngine.getCheckpoint(task) —
   * the client only ever needs the task string they already have.
   */
  loadLatestCheckpoint(task: string): ExecutorCheckpoint | undefined {
    const thirtyMinutes = 30 * 60 * 1000;
    let latest: ExecutorCheckpoint | undefined;

    for (const [key, cp] of this.checkpointStore.entries()) {
      if (cp.task !== task) continue;

      // Evict expired entries while we're scanning
      if (Date.now() - cp.timestamp > thirtyMinutes) {
        this.checkpointStore.delete(key);
        console.log(
          `[Executor] Checkpoint expired during scan, evicted (runId=${cp.runId})`,
        );
        continue;
      }

      // Keep the checkpoint with the highest turn — most progress
      if (!latest || cp.turn > latest.turn) {
        latest = cp;
      }
    }

    return latest;
  }

  clearCheckpoint(task: string, runId: string): void {
    this.checkpointStore.delete(`${task}:${runId}`);
  }

  // ── execute() — entry point ───────────────────────────────────────────────

  async execute(ctx: ExecutorContext): Promise<AgentResult> {
    const { nativeTools } = ctx;

    // Fail-fast: validate required functions are wired before execution begins
    if (nativeTools) {
      if (!this.callAIWithToolsFn) {
        throw new Error(
          "Executor: callAIWithToolsFn is not set. Pass deps.callAIWithTools to AgentEngine.",
        );
      }
      if (!this.buildToolSchemasForProvider) {
        throw new Error(
          "Executor: buildToolSchemasForProvider is not set. Pass deps.buildToolSchemas to AgentEngine.",
        );
      }
    } else {
      if (!this.callAIFn) {
        throw new Error(
          "Executor: callAIFn is not set. Pass deps.callAI to AgentEngine.",
        );
      }
    }

    if (!this.executeToolFn) {
      throw new Error(
        "Executor: executeToolFn is not set. Pass deps.executeTool to AgentEngine.",
      );
    }

    if (nativeTools) {
      return this._runNative(ctx);
    } else {
      return this._runPrompt(ctx);
    }
  }

  // ── _runNative() — fresh native run ──────────────────────────────────────

  private async _runNative(ctx: ExecutorContext): Promise<AgentResult> {
    const {
      task,
      plan,
      provider,
      projectContext,
      toolsUsed,
      config: cfg,
    } = ctx;

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const schemas = this.buildToolSchemasForProvider!(provider);

    const agentMessages: any[] = [
      {
        role: "system",
        content: this._resolveSystemPrompt(projectContext, cfg),
      },
      {
        role: "user",
        content: `${cfg.userPrompt ? cfg.userPrompt + "\n\n" : ""}Task: ${task}`,
      },
    ];

    if (plan.trim()) {
      agentMessages.push({
        role: "assistant",
        content: `Here is my plan:\n${plan.trim()}`,
      });
      agentMessages.push({
        role: "user",
        content: "Good. Now execute the plan step by step using your tools.",
      });
    }

    return this._runLoop({
      mode: "native",
      agentMessages,
      startTurn: 1,
      runId,
      fixedHeader: agentMessages.length,
      expiryMap: new Map(),
      schemas,
      initialTokens: 0,
      initialLastInputTokens: 0,
      ctx,
    });
  }

  // ── _runPrompt() — fresh prompt run ──────────────────────────────────────

  private async _runPrompt(ctx: ExecutorContext): Promise<AgentResult> {
    const { task, plan, projectContext, toolsUsed, config: cfg } = ctx;

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;

    const agentMessages: Message[] = [
      {
        role: "system",
        content:
          this._resolveSystemPrompt(projectContext, cfg) +
          "\n\n" +
          (this.buildToolPromptFn ? this.buildToolPromptFn() : ""),
      },
      {
        role: "user",
        content: `${cfg.userPrompt ? cfg.userPrompt + "\n\n" : ""}Task: ${task}`,
      },
    ];

    if (plan.trim()) {
      agentMessages.push({
        role: "assistant",
        content: `Here is my plan:\n${plan.trim()}`,
      });
      agentMessages.push({
        role: "user",
        content: "Good. Now execute the plan step by step using your tools.",
      });
    }

    return this._runLoop({
      mode: "prompt",
      agentMessages,
      startTurn: 1,
      runId,
      fixedHeader: agentMessages.length,
      expiryMap: new Map(),
      initialTokens: 0,
      initialLastInputTokens: 0,
      ctx,
    });
  }

  // ── executeFromCheckpoint() — resume native run ───────────────────────────

  async executeFromCheckpoint(
    cp: ExecutorCheckpoint,
    // Accept full ExecutorContext so hooks, tokenBudget, and provider
    // override all flow in exactly as they do for a fresh _runNative run.
    ctx: ExecutorContext,
  ): Promise<AgentResult> {
    const { provider } = ctx;
    const schemas = this.buildToolSchemasForProvider!(provider);

    return this._runLoop({
      mode: "native",
      agentMessages: [...cp.messages],
      startTurn: cp.turn + 1,
      runId: cp.runId,
      // restore the real fixedHeader saved at run start instead of
      // using a hardcoded guess of 4. An incorrect fixedHeader causes
      // _pruneMessages to discard system/user messages.
      fixedHeader: cp.fixedHeader,
      // restore expiryMap from checkpoint so _pruneMessages correctly
      // expires old tool results.
      expiryMap: new Map(cp.expiryMap),
      schemas,
      initialTokens: cp.tokensUsed,
      initialLastInputTokens: cp.lastInputTokens,
      ctx,
    });
  }

  // ── executeFromCheckpointPrompt() — resume prompt run ─────────────────────

  async executeFromCheckpointPrompt(
    cp: ExecutorCheckpoint,
    // Accept full ExecutorContext so hooks, tokenBudget, and provider
    // override all flow in exactly as they do for a fresh _runPrompt run.
    ctx: ExecutorContext,
  ): Promise<AgentResult> {
    return this._runLoop({
      mode: "prompt",
      agentMessages: [...cp.messages],
      startTurn: cp.turn + 1,
      runId: cp.runId,
      fixedHeader: cp.fixedHeader,
      expiryMap: new Map(cp.expiryMap),
      initialTokens: cp.tokensUsed,
      initialLastInputTokens: 0, // prompt mode doesn't track input tokens separately
      ctx,
    });
  }

  // ── _runLoop() — shared turn loop ────────────────────────────────────────
  //
  // Single source of truth for all execution logic.
  // Called by all 4 public paths with mode + pre-built state.
  // The only difference between "native" and "prompt":
  //   native → callAIWithToolsFn + response.tool_calls
  //   prompt → callAIFn          + _parseAllToolCalls(response.content)

  private async _runLoop(loopCtx: RunLoopContext): Promise<AgentResult> {
    const {
      mode,
      agentMessages,
      startTurn,
      runId,
      fixedHeader,
      expiryMap,
      schemas,
      ctx,
    } = loopCtx;

    const {
      task,
      plan,
      provider,
      toolsUsed,
      config: cfg,
      hooks,
      tokenBudget,
    } = ctx;

    const { onMessage, memory } = cfg;

    let totalTokens = loopCtx.initialTokens;
    let lastInputTokens = loopCtx.initialLastInputTokens;
    const filesChanged: string[] = [];

    for (let turn = startTurn; turn <= this.maxTurns; turn++) {
      // ── Abort check ──────────────────────────────────────────────────────
      if (cfg.signal?.aborted) {
        onMessage({ type: "agentDone", text: "Task aborted." });
        return {
          success: false,
          summary: `Task aborted after ${turn - 1} turn(s).`,
          toolsUsed,
          turnsUsed: turn - 1,
          filesChanged,
          tokensUsed: totalTokens,
          error: "AbortError",
          runId,
        };
      }

      // ── beforeTurn hook ──────────────────────────────────────────────────
      // Can return Partial<AgentTurnState> to mutate messages/totalTokens,
      // or void/undefined to continue unchanged.
      if (hooks?.beforeTurn) {
        try {
          const state: AgentTurnState = {
            turn,
            messages: agentMessages,
            currentTask: task,
            toolsUsedSoFar: [...toolsUsed],
            totalTokens,
            filesChanged: [...filesChanged],
          };
          const mutation = await hooks.beforeTurn(state);
          totalTokens = this._applyBeforeTurnMutation(
            mutation,
            agentMessages,
            totalTokens,
          );
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `beforeTurn hook threw: ${err.message ?? err}`,
          });
        }
      }

      onMessage({ type: "agentTurn", text: `⟳ Turn ${turn}/${this.maxTurns}` });

      // ── Call AI — the only difference between native and prompt ──────────
      let parsedToolCalls: ParsedToolCall[] = [];
      let nativeToolCalls: CallAIWithToolsResult["tool_calls"] = undefined;
      let responseContent: string | null = null;

      try {
        console.log(`[Executor] Turn ${turn} (${mode}) - About to call API`);

        if (mode === "native") {
          // Native: structured tool_calls from provider API
          const response = await this.callAIWithToolsFn!(
            agentMessages,
            schemas!,
            provider,
          );

          const currentInputTokens = response.usage?.prompt_tokens ?? 0;
          const newInputTokens = currentInputTokens - lastInputTokens;
          const newOutputTokens = response.usage?.completion_tokens ?? 0;
          const thisTurnTokens = Math.max(0, newInputTokens) + newOutputTokens;
          totalTokens += thisTurnTokens;
          lastInputTokens = currentInputTokens;

          console.log(
            `[Executor] Turn ${turn} - ` +
              `input=${currentInputTokens} (+${Math.max(0, newInputTokens)} new) ` +
              `output=${newOutputTokens} ` +
              `turn_cost=${thisTurnTokens} ` +
              `running_total=${totalTokens}`,
          );

          nativeToolCalls = response.tool_calls;
          responseContent = response.content ?? null;
        } else {
          // Prompt: parse JSON tool calls from plain text response
          const response = await this.callAIFn!(agentMessages, provider);
          totalTokens += response.usage?.total_tokens ?? 0;
          responseContent = response.content;
          parsedToolCalls = this._parseAllToolCalls(response.content);
        }
      } catch (err: any) {
        // ── onError hook ────────────────────────────────────────────────────
        if (hooks?.onError) {
          try {
            await hooks.onError(
              err instanceof Error ? err : new Error(String(err)),
              { turn, task },
            );
          } catch {}
        }
        return {
          success: false,
          summary: `Agent stopped — AI call failed on turn ${turn}: ${err.message}`,
          toolsUsed,
          turnsUsed: turn,
          filesChanged,
          tokensUsed: totalTokens,
          error: err.message,
          runId,
        };
      }

      // ── shouldContinue hook ──────────────────────────────────────────────
      if (hooks?.shouldContinue) {
        try {
          const cont = await hooks.shouldContinue(
            turn,
            agentMessages,
            this.maxTurns - turn,
          );
          if (!cont) {
            onMessage({
              type: "agentDone",
              text: "Run stopped by shouldContinue hook.",
            });
            return {
              success: false,
              summary: `Run stopped by hook after turn ${turn}.`,
              toolsUsed,
              turnsUsed: turn,
              filesChanged,
              tokensUsed: totalTokens,
              error: "HookAbort",
              runId,
            };
          }
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `shouldContinue hook threw: ${err.message ?? err}`,
          });
        }
      }

      // ── Raw token budget fallback — only fires if no hooks are wired ─────
      if (
        !hooks?.shouldContinue &&
        tokenBudget !== undefined &&
        totalTokens > tokenBudget
      ) {
        onMessage({
          type: "agentDone",
          text: `Token budget exceeded (${totalTokens}/${tokenBudget}).`,
        });
        return {
          success: false,
          summary: `Run stopped — token budget of ${tokenBudget} exceeded at turn ${turn} (used ${totalTokens}).`,
          toolsUsed,
          turnsUsed: turn,
          filesChanged,
          tokensUsed: totalTokens,
          error: "TokenBudgetExceeded",
          runId,
        };
      }

      // ── Termination check ────────────────────────────────────────────────
      // Native: no tool_calls = model finished naturally
      // Prompt: no parsed tool calls = model returned plain text final answer
      if (mode === "native") {
        if (!nativeToolCalls || nativeToolCalls.length === 0) {
          const text = responseContent ?? "";
          onMessage({ type: "agentDone", text: text || "Task complete." });
          return {
            success: true,
            summary: this._buildSummary(
              task,
              text || "Task complete.",
              toolsUsed,
              turn,
            ),
            toolsUsed,
            turnsUsed: turn,
            filesChanged,
            tokensUsed: totalTokens,
            runId,
          };
        }
      } else {
        // Prompt: all-done shortcut — if every parsed call is "done"
        if (
          parsedToolCalls.length > 0 &&
          parsedToolCalls.every((tc) => tc.tool === "done")
        ) {
          return this._handleDone(
            parsedToolCalls[0].args,
            agentMessages,
            task,
            toolsUsed,
            turn,
            filesChanged,
            totalTokens,
            runId,
            onMessage,
          );
        }

        if (parsedToolCalls.length === 0) {
          const clean = this._cleanDoneMessage(responseContent ?? "");
          onMessage({ type: "agentDone", text: clean });
          return {
            success: true,
            summary: this._buildSummary(task, clean, toolsUsed, turn),
            toolsUsed,
            turnsUsed: turn,
            filesChanged,
            tokensUsed: totalTokens,
            runId,
          };
        }
      }

      // ── Push assistant message ───────────────────────────────────────────
      if (mode === "native") {
        agentMessages.push({
          role: "assistant",
          content: responseContent,
          tool_calls: nativeToolCalls,
        });
      } else {
        agentMessages.push({ role: "assistant", content: responseContent });
      }

      // ── Tool execution loop ──────────────────────────────────────────────
      // Resolve tool calls — native uses tool_calls array, prompt uses parsed list
      const toolCallsToExecute =
        mode === "native"
          ? nativeToolCalls!.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || "{}"),
            }))
          : parsedToolCalls.map((tc) => ({
              id: undefined as string | undefined,
              name: tc.tool,
              args: tc.args,
            }));

      for (const toolCall of toolCallsToExecute) {
        const toolName = toolCall.name;
        const toolArgs = toolCall.args;

        /**
         * Intercept "done" before it reaches executeToolFn.
         * Some models (e.g. Cerebras) emit "done" as a native tool call
         * instead of stopping naturally. Treating it as a termination signal
         * here saves a round-trip and surfaces the last tool result as the
         * final summary.
         */
        if (toolName === "done") {
          return this._handleDone(
            toolArgs,
            agentMessages,
            task,
            toolsUsed,
            turn,
            filesChanged,
            totalTokens,
            runId,
            onMessage,
          );
        }

        // ── Loop detection ─────────────────────────────────────────────────
        if (this.loopDetector.detectToolLoop(toolName, toolArgs)) {
          onMessage({
            type: "agentTool",
            text: `🔄 Loop detected: ${toolName} called repeatedly. Stopping.`,
          });
          return {
            success: false,
            summary: `Agent stopped — detected tool loop on ${toolName}`,
            toolsUsed,
            turnsUsed: turn,
            filesChanged,
            tokensUsed: totalTokens,
            error: "Tool loop detected",
            runId,
          };
        }

        onMessage({
          type: "agentTool",
          text: `${toolName}(${Object.keys(toolArgs).join(", ")})`,
        });

        // ── Execute tool ───────────────────────────────────────────────────
        let toolResult: { tool: string; success: boolean; output: string };
        try {
          toolResult = await this.executeToolFn!(
            toolName,
            toolArgs,
            onMessage,
            cfg,
          );
        } catch (err: any) {
          toolResult = {
            tool: toolName,
            success: false,
            output: `Error: ${err.message}`,
          };
        }

        toolsUsed.push(toolName);
        memory?.trackToolUsed(toolName);

        if (toolResult.success) {
          if (
            toolName === "editFile" ||
            toolName === "createFile" ||
            toolName === "runTerminal"
          ) {
            const changedPath =
              toolArgs.path || toolArgs.filePath || "terminal";
            filesChanged.push(changedPath);
            memory?.trackFileTouched(changedPath);
            // notify once on file mutations — avoids double cache invalidation
            cfg.onToolExecuted?.(toolName);
          }
        }

        // ── afterToolExecution hook ────────────────────────────────────────
        // Can mutate or nullify the result.
        // null return = skip adding this result to messages (AI never sees it).
        if (hooks?.afterToolExecution) {
          try {
            const toolCtx: ToolExecutionContext = {
              tool: toolName,
              args: toolArgs,
              turn,
              taskContext: task,
            };
            const mutated = await hooks.afterToolExecution(
              toolName,
              toolResult,
              toolCtx,
            );
            if (mutated === null) {
              continue; // hook nullified this result — skip pushing to messages
            }
            toolResult = mutated;
          } catch (err: any) {
            onMessage({
              type: "agentTool",
              text: `afterToolExecution hook threw: ${err.message ?? err}`,
            });
          }
        }

        // ── Push tool result to messages ───────────────────────────────────
        // native: role="tool" with tool_call_id (OpenAI protocol)
        // prompt: role="user" with text prefix (prompt injection protocol)
        if (mode === "native") {
          const compactContent = toolResult.success
            ? this._compactToolResult(toolName, toolResult.output)
            : `Error: ${toolResult.output}\n\nTry a different approach.`;

          agentMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: compactContent,
          });
        } else {
          const compactOutput = toolResult.success
            ? this._compactToolResult(toolName, toolResult.output)
            : toolResult.output;

          agentMessages.push({
            role: "user",
            content: toolResult.success
              ? `Tool result [${toolName}]:\n${compactOutput}`
              : `Tool error [${toolName}]:\n${compactOutput}\n\nTry a different approach.`,
          });
        }

        const ttl = this._getTTL(toolName);
        expiryMap.set(agentMessages.length - 1, turn + ttl);
      }

      this._pruneMessages(agentMessages, expiryMap, turn, fixedHeader);

      // ── Save checkpoint after every turn ──────────────────────────────────
      this.saveCheckpoint({
        task,
        plan,
        turn,
        messages: [...agentMessages],
        filesChanged: [...filesChanged],
        toolsUsed: [...toolsUsed],
        tokensUsed: totalTokens,
        // native tracks lastInputTokens for delta; prompt mode always 0
        lastInputTokens: mode === "native" ? lastInputTokens : 0,
        timestamp: Date.now(),
        fixedHeader,
        expiryMap: Array.from(expiryMap.entries()),
        runId,
      });
    }

    console.log(`[Executor] Returning result with tokensUsed: ${totalTokens}`);
    return {
      success: false,
      summary: this._buildCapSummary(task, toolsUsed, this.maxTurns),
      toolsUsed,
      turnsUsed: this.maxTurns,
      filesChanged,
      tokensUsed: totalTokens,
      runId,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _resolveSystemPrompt(
    projectContext: string,
    cfg: AgentConfig,
  ): string {
    return projectContext;
  }

  /**
   * Shared termination handler for both native and prompt paths.
   * Called when the model emits a "done" tool call in any execution path.
   *
   * Extracts a human-readable summary from the tool args if present,
   * otherwise falls back to the last tool result in agentMessages.
   * Emits agentDone and returns a successful AgentResult immediately,
   * bypassing executeToolFn entirely.
   */
  private _handleDone(
    toolArgs: Record<string, any>,
    agentMessages: any[],
    task: string,
    toolsUsed: string[],
    turn: number,
    filesChanged: string[],
    totalTokens: number,
    runId: string,
    onMessage: (msg: any) => void,
  ): AgentResult {
    const summary =
      toolArgs.summary ??
      toolArgs.message ??
      toolArgs.result ??
      toolArgs.text ??
      toolArgs.output ??
      "";
    const clean = summary
      ? this._cleanDoneMessage(String(summary))
      : this._cleanDoneMessage(
          (() => {
            for (let i = agentMessages.length - 1; i >= 0; i--) {
              const m = agentMessages[i];
              // native path: role === "tool"
              // prompt path: role === "user" with "Tool result [" prefix
              if (
                m?.role === "tool" ||
                (m?.role === "user" &&
                  typeof m?.content === "string" &&
                  m.content.startsWith("Tool result ["))
              ) {
                return m.content;
              }
            }
            return "Task complete.";
          })(),
        );
    onMessage({ type: "agentDone", text: clean });
    return {
      success: true,
      summary: this._buildSummary(task, clean, toolsUsed, turn),
      toolsUsed,
      turnsUsed: turn,
      filesChanged,
      tokensUsed: totalTokens,
      runId,
    };
  }

  /**
   * Applies Partial<AgentTurnState> mutations returned by beforeTurn hook.
   * Only messages and totalTokens affect execution — other fields are
   * read-only snapshots passed for observation only.
   */
  private _applyBeforeTurnMutation(
    mutation: Partial<AgentTurnState> | void,
    agentMessages: any[],
    totalTokens: number,
  ): number {
    if (!mutation || typeof mutation !== "object") return totalTokens;

    if (Array.isArray(mutation.messages)) {
      agentMessages.splice(0, agentMessages.length, ...mutation.messages);
    }

    return typeof mutation.totalTokens === "number"
      ? mutation.totalTokens
      : totalTokens;
  }

  // ── _cleanDoneMessage ────────────────────────────────────────────────────

  private _cleanDoneMessage(raw: string): string {
    const sentences = raw.split(/(?<=[.!?])\s+/);
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const sentence of sentences) {
      const key = sentence.trim().toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);
      clean.push(sentence.trim());
    }
    const deduped = clean.join(" ").trim();
    return deduped.length > 300
      ? deduped.slice(0, 300).trimEnd() + "..."
      : deduped;
  }

  private _buildSummary(
    task: string,
    agentSummary: string,
    toolsUsed: string[],
    turnsUsed: number,
  ): string {
    const toolChain =
      toolsUsed.length > 0
        ? `\n\n**Steps taken:** ${toolsUsed.join(" → ")}`
        : "";
    return `**Agent complete**\n\n${agentSummary}${toolChain}\n**Turns used:** ${turnsUsed}/${this.maxTurns}`;
  }

  private _buildCapSummary(
    task: string,
    toolsUsed: string[],
    maxTurns: number,
  ): string {
    const toolChain =
      toolsUsed.length > 0
        ? `\n\n**Progress made:** ${toolsUsed.join(" → ")}`
        : "\n\nNo tools were executed.";
    return `**Agent hit ${maxTurns}-turn limit**\n\nTask: "${task}"${toolChain}\n\nTry breaking the task into smaller steps.`;
  }

  // ── TTL — how many turns a tool result stays in context ──────────────────

  private _getTTL(toolName: string): number {
    const TTL: Record<string, number> = {
      editFile: this.maxTurns, // must outlive the task — forgetting = re-edit loop
      createFile: this.maxTurns, // must outlive the task
      gitCommit: this.maxTurns, // git writes must be remembered
      gitPush: this.maxTurns,
      readFile: 4, // until next edit on that file
      gitDiff: 3,
      runCommand: 2,
      listFiles: 2,
      gitStatus: 2,
      gitLog: 2,
    };
    return TTL[toolName] ?? 3;
  }

  // ── Compact large tool outputs to stay under context limits ──────────────

  private _compactToolResult(toolName: string, output: string): string {
    switch (toolName) {
      case "readFile":
        if (output.length <= 1500) return output;
        const totalLines = output.split("\n").length;
        const preview = output.slice(0, 1500);
        const shownLines = preview.split("\n").length;
        return `${preview}\n...[${shownLines}/${totalLines} lines shown]`;
      case "runCommand":
        if (output.length <= 500) return output;
        return "...[truncated]\n" + output.slice(-500);
      default:
        return output;
    }
  }

  // ── Prune expired messages to stay under context limits ──────────────────

  private _pruneMessages(
    messages: any[],
    expiryMap: Map<number, number>,
    currentTurn: number,
    fixedHeader: number,
  ): void {
    const toRemove = new Set<number>();
    for (const [idx, expiryTurn] of expiryMap.entries()) {
      if (currentTurn > expiryTurn && idx >= fixedHeader) toRemove.add(idx);
    }
    if (toRemove.size === 0) return;

    for (const idx of [...toRemove]) {
      const msg = messages[idx];
      const isToolResult =
        msg?.role === "tool" ||
        (msg?.role === "user" &&
          typeof msg?.content === "string" &&
          (msg.content.startsWith("Tool result [") ||
            msg.content.startsWith("Tool error [")));
      if (!isToolResult) continue;

      let assistantIdx = idx - 1;
      while (
        assistantIdx >= fixedHeader &&
        messages[assistantIdx]?.role !== "assistant"
      )
        assistantIdx--;

      if (
        assistantIdx >= fixedHeader &&
        messages[assistantIdx]?.role === "assistant" &&
        !toRemove.has(assistantIdx)
      ) {
        const toolCallIds: string[] = (
          messages[assistantIdx].tool_calls ?? []
        ).map((tc: any) => tc.id);
        if (toolCallIds.length > 0) {
          const allExpiring = toolCallIds.every((id) =>
            [...toRemove].some((i) => messages[i]?.tool_call_id === id),
          );
          if (allExpiring) toRemove.add(assistantIdx);
        } else {
          let nextIdx = assistantIdx + 1;
          const siblingIdxs: number[] = [];
          while (
            nextIdx < messages.length &&
            messages[nextIdx]?.role !== "assistant"
          ) {
            const m = messages[nextIdx];
            if (
              m?.role === "user" &&
              typeof m?.content === "string" &&
              (m.content.startsWith("Tool result [") ||
                m.content.startsWith("Tool error ["))
            ) {
              siblingIdxs.push(nextIdx);
            }
            nextIdx++;
          }
          if (
            siblingIdxs.length > 0 &&
            siblingIdxs.every((i) => toRemove.has(i))
          ) {
            toRemove.add(assistantIdx);
          }
        }
      }
    }

    const surviving = new Map<any, number>();
    for (const [k, v] of expiryMap.entries()) {
      if (!toRemove.has(k)) surviving.set(messages[k], v);
    }

    const kept = messages.filter((_, i) => !toRemove.has(i));
    messages.length = 0;
    messages.push(...kept);

    expiryMap.clear();
    for (const [msgRef, expiry] of surviving.entries()) {
      const newIdx = messages.indexOf(msgRef);
      if (newIdx !== -1) expiryMap.set(newIdx, expiry);
    }
  }

  // ── Parse all tool calls from a raw prompt-mode response ─────────────────

  private _parseAllToolCalls(raw: string): ParsedToolCall[] {
    // try array first, then object, then legacy
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          // existing {tool, args} format
          const calls = parsed
            .filter((item: any) => typeof item?.tool === "string")
            .map((item: any) => ({ tool: item.tool, args: item.args ?? {} }));
          if (calls.length > 0) return calls;

          // OpenAI {name, arguments} format — some models emit this in text
          const calls2 = parsed
            .filter(
              (item: any) =>
                typeof item?.name === "string" && item?.arguments !== undefined,
            )
            .map((item: any) => ({
              tool: item.name,
              args:
                typeof item.arguments === "string"
                  ? JSON.parse(item.arguments)
                  : (item.arguments ?? {}),
            }));
          if (calls2.length > 0) return calls2;
        }
      } catch {}
    }

    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);

        // Standard prompt-injection format: {"tool":"name","args":{...}}
        // Used by most models following the framework's tool prompt template
        if (typeof parsed?.tool === "string") {
          return [{ tool: parsed.tool, args: parsed.args ?? {} }];
        }

        // OpenAI native tool-call format leaked into text: {"name":"name","arguments":{...}}
        // Some models (e.g. Cerebras) ignore tool_choice and emit this format
        // in content instead of tool_calls. Normalise it to {tool, args} so
        // the rest of the prompt path handles it identically.
        if (
          typeof parsed?.name === "string" &&
          parsed?.arguments !== undefined
        ) {
          const args =
            typeof parsed.arguments === "string"
              ? JSON.parse(parsed.arguments)
              : parsed.arguments;
          return [{ tool: parsed.name, args }];
        }
      } catch {}
    }

    return this._legacyParseToolCalls(raw);
  }

  private _legacyParseToolCalls(raw: string): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];
    let i = 0;
    while (i < raw.length) {
      const start = raw.indexOf("{", i);
      if (start === -1) break;
      let depth = 0,
        end = -1,
        inString = false,
        escaped = false;
      for (let j = start; j < raw.length; j++) {
        const char = raw[j];
        if (char === '"' && !escaped) inString = !inString;
        if (char === "\\" && !escaped) escaped = true;
        else escaped = false;
        if (!inString) {
          if (char === "{") depth++;
          else if (char === "}") {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
      }
      const candidate =
        end !== -1
          ? raw.slice(start, end + 1)
          : (() => {
              let s = raw.slice(start);
              if (inString) s += '"';
              s += "}".repeat(depth);
              return s;
            })();
      const sanitized = candidate.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
      try {
        const finalClean = sanitized.replace(/,\s*([\]}])/g, "$1");
        const parsed = JSON.parse(finalClean);
        if (parsed.tool)
          results.push({ tool: parsed.tool, args: parsed.args || {} });
      } catch {
        try {
          const fixed = sanitized.replace(/\\'/g, "'");
          const second = JSON.parse(fixed);
          if (second.tool)
            results.push({ tool: second.tool, args: second.args || {} });
        } catch (err: any) {
          console.warn(
            "[Executor] Failed to parse tool from JSON:",
            err?.message || String(err),
            "Raw:",
            raw.substring(0, 100),
          );
        }
      }
      i = end !== -1 ? end + 1 : raw.length;
    }
    return results;
  }
}
