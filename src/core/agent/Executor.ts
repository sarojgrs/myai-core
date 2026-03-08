/**
 * Execution logic for agent tasks
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

  private async _runNative(ctx: ExecutorContext): Promise<AgentResult> {
    let lastInputTokens = 0;
    let totalTokens = 0;
    const {
      task,
      plan,
      provider,
      projectContext,
      toolsUsed,
      config: cfg,
      hooks,
      tokenBudget,
    } = ctx;
    const { onMessage, memory } = cfg;
    const schemas = this.buildToolSchemasForProvider!(provider);
    const filesChanged: string[] = [];

    // unique runId per run() invocation prevents checkpoint key collisions
    // when the same task is run concurrently or back-to-back.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;

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

    // compute fixedHeader at run start and carry it into every
    // checkpoint so executeFromCheckpoint() uses the real value, not a
    // hardcoded guess of 4.
    const fixedHeader = agentMessages.length;
    const expiryMap = new Map<number, number>();
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      // ── Abort check — checked at the start of every turn ─────────────────
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

      // ── beforeTurn hook (AgentLifecycleHooks) ───────────────────────────────
      // Receives full AgentTurnState snapshot. Can return Partial<AgentTurnState>
      // to mutate state, or void/undefined to continue unchanged.
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
          await hooks.beforeTurn(state);
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `beforeTurn hook threw: ${err.message ?? err}`,
          });
        }
      }

      onMessage({ type: "agentTurn", text: `⟳ Turn ${turn}/${this.maxTurns}` });

      let response: any;
      try {
        console.log(`[Executor] Turn ${turn} - About to call API`);
        //Ask the AI what to do next
        response = await this.callAIWithToolsFn!(
          agentMessages,
          schemas,
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
      } catch (err: any) {
        // ── onError hook (AgentLifecycleHooks) ───────────────────────────────
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

      // ── shouldContinue hook (AgentLifecycleHooks) ────────────────────────
      // Called after every turn. TokenBudgetHooks.shouldContinue handles budget
      // enforcement here — no separate tokenBudget check needed.
      // Also used by TurnLimitHooks and any custom continue conditions.
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
      // If AgentLifecycleHooks are set, use TokenBudgetHooks.shouldContinue instead.
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

      //  Check if AI wants to do anything
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const text = response.content ?? "";
        onMessage({
          type: "agentDone",
          text: `${text || "Task complete."}`,
        });
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

      agentMessages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // AI requested tools, execute them
      for (const toolCall of response.tool_calls) {
        const { id, function: func } = toolCall;
        const toolName = func.name;
        const toolArgs = JSON.parse(func.arguments || "{}");

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

        // ── beforeTurn state refresh not needed here — tool loop is within a turn

        onMessage({
          type: "agentTool",
          text: `${toolName}(${Object.keys(toolArgs).join(", ")})`,
        });

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
            // onToolExecuted was called twice for editFile/createFile —
            // once in the outer if-block and again in a redundant inner check.
            // The duplicate caused double cache invalidation. Now called exactly once.
            cfg.onToolExecuted?.(toolName);
          }
        }

        // ── afterToolExecution hook (AgentLifecycleHooks) ───────────────────
        // Receives full ToolExecutionContext. Can mutate or nullify the result.
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
              // Hook nullified this result — skip pushing to messages entirely
              continue;
            }
            toolResult = mutated;
          } catch (err: any) {
            onMessage({
              type: "agentTool",
              text: `afterToolExecution hook threw: ${err.message ?? err}`,
            });
          }
        }

        const compactContent = toolResult.success
          ? this._compactToolResult(toolName, toolResult.output)
          : `Error: ${toolResult.output}\n\nTry a different approach.`;

        // Tell AI what happened
        agentMessages.push({
          role: "tool",
          tool_call_id: id,
          content: compactContent,
        });

        const ttl = this._getTTL(toolName);
        expiryMap.set(agentMessages.length - 1, turn + ttl);
      }

      this._pruneMessages(agentMessages, expiryMap, turn, fixedHeader);

      // ── Save checkpoint after every turn ─────────────────────────────────
      // include fixedHeader so resume uses the correct value.
      // serialise expiryMap so pruning resumes correctly.
      // include runId to isolate concurrent runs of the same task.
      this.saveCheckpoint({
        task,
        plan,
        turn,
        messages: [...agentMessages],
        filesChanged: [...filesChanged],
        toolsUsed: [...toolsUsed],
        tokensUsed: totalTokens,
        lastInputTokens,
        timestamp: Date.now(),
        fixedHeader,
        expiryMap: Array.from(expiryMap.entries()),
        runId,
      });
    }
    console.log(`[Executor] Returning result with tokensUsed: ${totalTokens}`);
    // returns totalTokens (cumulative cost across all turns).
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

  private async _runPrompt(ctx: ExecutorContext): Promise<AgentResult> {
    let totalTokens = 0;
    const {
      task,
      plan,
      provider,
      projectContext,
      toolsUsed,
      config: cfg,
      hooks,
      tokenBudget,
    } = ctx;
    const { onMessage, memory } = cfg;
    const filesChanged: string[] = [];

    // unique runId per run() invocation
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

    // store real fixedHeader, not a hardcoded guess
    const fixedHeader = agentMessages.length;
    const expiryMap = new Map<number, number>();
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      // ── Abort check — checked at the start of every turn ─────────────────
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

      // ── beforeTurn hook (AgentLifecycleHooks) ───────────────────────────────
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
          await hooks.beforeTurn(state);
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `beforeTurn hook threw: ${err.message ?? err}`,
          });
        }
      }

      onMessage({ type: "agentTurn", text: `⟳ Turn ${turn}/${this.maxTurns}` });

      let response: CallAIResult;
      try {
        response = await this.callAIFn!(agentMessages, provider);
      } catch (err: any) {
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

      // ── Token tracking ────────────────────────────────────────────────────
      const thisTurnTokens = response.usage?.total_tokens ?? 0;
      totalTokens += thisTurnTokens;

      // ── shouldContinue hook (AgentLifecycleHooks) ────────────────────────
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

      // ── Raw token budget fallback — only if no hooks wired ───────────────
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

      const raw = response.content;
      const toolCalls = this._parseAllToolCalls(raw);

      if (toolCalls.length === 0) {
        const clean = this._cleanDoneMessage(raw);
        onMessage({ type: "agentDone", text: `${clean}` });
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

      agentMessages.push({ role: "assistant", content: raw });

      for (const { tool, args } of toolCalls) {
        if (this.loopDetector.detectToolLoop(tool, args)) {
          onMessage({
            type: "agentTool",
            text: `🔄 Loop detected: ${tool} called repeatedly. Stopping.`,
          });
          return {
            success: false,
            summary: `Agent stopped — detected tool loop on ${tool}`,
            toolsUsed,
            turnsUsed: turn,
            filesChanged,
            tokensUsed: totalTokens,
            error: "Tool loop detected",
            runId,
          };
        }

        // tool will be filtered via afterToolExecution if needed

        onMessage({
          type: "agentTool",
          text: ` ${tool}(${Object.keys(args).join(", ")})`,
        });

        let toolResult: { tool: string; success: boolean; output: string };
        try {
          toolResult = await this.executeToolFn!(tool, args, onMessage, cfg);
        } catch (err: any) {
          toolResult = {
            tool,
            success: false,
            output: `Error: ${err.message}`,
          };
        }

        toolsUsed.push(tool);
        memory?.trackToolUsed(tool);

        if (toolResult.success) {
          if (
            tool === "editFile" ||
            tool === "createFile" ||
            tool === "runTerminal"
          ) {
            const changedPath = args.path || args.filePath || "terminal";
            filesChanged.push(changedPath);
            memory?.trackFileTouched(changedPath);
            // Mirror _runNative: notify once on file mutations
            cfg.onToolExecuted?.(tool);
          }
        }

        // ── afterToolExecution hook (AgentLifecycleHooks) ───────────────────
        if (hooks?.afterToolExecution) {
          try {
            const toolCtx: ToolExecutionContext = {
              tool,
              args,
              turn,
              taskContext: task,
            };
            const mutated = await hooks.afterToolExecution(
              tool,
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

        const compactOutput = toolResult.success
          ? this._compactToolResult(tool, toolResult.output)
          : toolResult.output;

        agentMessages.push({
          role: "user",
          content: toolResult.success
            ? `Tool result [${tool}]:\n${compactOutput}`
            : `Tool error [${tool}]:\n${compactOutput}\n\nTry a different approach.`,
        });

        const ttl = this._getTTL(tool);
        expiryMap.set(agentMessages.length - 1, turn + ttl);
      }

      this._pruneMessages(agentMessages, expiryMap, turn, fixedHeader);

      // ── Save checkpoint after every turn ─────────────────────────────────
      this.saveCheckpoint({
        task,
        plan,
        turn,
        messages: [...agentMessages],
        filesChanged: [...filesChanged],
        toolsUsed: [...toolsUsed],
        tokensUsed: totalTokens,
        lastInputTokens: 0, // prompt mode doesn't track input tokens separately
        timestamp: Date.now(),
        fixedHeader,
        expiryMap: Array.from(expiryMap.entries()),
        runId,
      });
    }

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

  async executeFromCheckpoint(
    cp: ExecutorCheckpoint,
    // Accept full ExecutorContext so hooks, tokenBudget, and provider
    // override all flow in exactly as they do for a fresh _runNative run.
    ctx: ExecutorContext,
  ): Promise<AgentResult> {
    const { task, plan, messages, filesChanged, toolsUsed } = cp;
    let totalTokens = cp.tokensUsed;
    let lastInputTokens = cp.lastInputTokens;
    const { config: cfg, hooks, tokenBudget, provider } = ctx;
    const { onMessage, memory } = cfg;
    const schemas = this.buildToolSchemasForProvider!(provider);
    const agentMessages = [...messages];

    // restore the real fixedHeader saved at run start instead of
    // using a hardcoded guess of 4. An incorrect fixedHeader causes _pruneMessages
    // to discard system/user messages, producing hallucinated context.
    const fixedHeader = cp.fixedHeader;

    // restore expiryMap from checkpoint so _pruneMessages correctly
    // expires old tool results. An empty expiryMap means nothing is ever pruned
    // and the context window grows unboundedly.
    const expiryMap = new Map<number, number>(cp.expiryMap);

    // resume from NEXT turn after checkpoint
    for (let turn = cp.turn + 1; turn <= this.maxTurns; turn++) {
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
        };
      }

      // ── beforeTurn hook — mirrors _runNative ─────────────────────────────
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
          await hooks.beforeTurn(state);
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `beforeTurn hook threw: ${err.message ?? err}`,
          });
        }
      }

      onMessage({ type: "agentTurn", text: `⟳ Turn ${turn}/${this.maxTurns}` });

      let response: any;
      try {
        console.log(`[Executor] Resume Turn ${turn} - About to call API`);
        response = await this.callAIWithToolsFn!(
          agentMessages,
          schemas,
          provider,
        );

        const currentInputTokens = response.usage?.prompt_tokens ?? 0;
        const newInputTokens = currentInputTokens - lastInputTokens;
        const newOutputTokens = response.usage?.completion_tokens ?? 0;
        const thisTurnTokens = Math.max(0, newInputTokens) + newOutputTokens;
        totalTokens += thisTurnTokens;
        lastInputTokens = currentInputTokens;

        console.log(
          `[Executor] Resume Turn ${turn} - input=${currentInputTokens} output=${newOutputTokens} total=${totalTokens}`,
        );
      } catch (err: any) {
        // ── onError hook — mirrors _runNative ───────────────────────────────
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
          summary: `Agent stopped on resume turn ${turn}: ${err.message}`,
          toolsUsed,
          turnsUsed: turn,
          filesChanged,
          tokensUsed: totalTokens,
          error: err.message,
        };
      }

      // ── shouldContinue hook — mirrors _runNative ─────────────────────────
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
            };
          }
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `shouldContinue hook threw: ${err.message ?? err}`,
          });
        }
      }

      // ── Raw token budget fallback — only if no hooks wired ───────────────
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
        };
      }

      if (!response.tool_calls || response.tool_calls.length === 0) {
        const text = response.content ?? "";
        onMessage({ type: "agentDone", text: `${text || "Task complete."}` });
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
        };
      }

      agentMessages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      for (const toolCall of response.tool_calls) {
        const { id, function: func } = toolCall;
        const toolName = func.name;
        const toolArgs = JSON.parse(func.arguments || "{}");

        // ── Loop detection — mirrors _runNative ──────────────────────────
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
          };
        }

        onMessage({
          type: "agentTool",
          text: `${toolName}(${Object.keys(toolArgs).join(", ")})`,
        });

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

        // ── runTerminal added — mirrors _runNative (was missing on resume) ─
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
            cfg.onToolExecuted?.(toolName);
          }
        }

        // ── afterToolExecution hook — mirrors _runNative ─────────────────
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
              continue;
            }
            toolResult = mutated;
          } catch (err: any) {
            onMessage({
              type: "agentTool",
              text: `afterToolExecution hook threw: ${err.message ?? err}`,
            });
          }
        }

        // ── Consistent error format — mirrors _runNative ─────────────────
        const compactContent = toolResult.success
          ? this._compactToolResult(toolName, toolResult.output)
          : `Error: ${toolResult.output}\n\nTry a different approach.`;

        agentMessages.push({
          role: "tool",
          tool_call_id: id,
          content: compactContent,
        });

        const ttl = this._getTTL(toolName);
        expiryMap.set(agentMessages.length - 1, turn + ttl);
      }

      this._pruneMessages(agentMessages, expiryMap, turn, fixedHeader);

      this.saveCheckpoint({
        task,
        plan,
        turn,
        messages: [...agentMessages],
        filesChanged: [...filesChanged],
        toolsUsed: [...toolsUsed],
        tokensUsed: totalTokens,
        lastInputTokens,
        timestamp: Date.now(),
        fixedHeader,
        expiryMap: Array.from(expiryMap.entries()),
        runId: cp.runId,
      });
    }

    return {
      success: false,
      summary: this._buildCapSummary(task, toolsUsed, this.maxTurns),
      toolsUsed,
      turnsUsed: this.maxTurns,
      filesChanged,
      tokensUsed: totalTokens,
    };
  }

  async executeFromCheckpointPrompt(
    cp: ExecutorCheckpoint,
    // Accept full ExecutorContext so hooks, tokenBudget, and provider
    // override all flow in exactly as they do for a fresh _runPrompt run.
    ctx: ExecutorContext,
  ): Promise<AgentResult> {
    const { task, plan, messages, filesChanged, toolsUsed } = cp;
    let totalTokens = cp.tokensUsed;
    const { config: cfg, hooks, tokenBudget, provider } = ctx;
    const { onMessage, memory } = cfg;
    const agentMessages: Message[] = [...messages];

    // use real fixedHeader from checkpoint, not hardcoded 4
    const fixedHeader = cp.fixedHeader;
    // restore expiryMap so pruning works correctly on resume
    const expiryMap = new Map<number, number>(cp.expiryMap);

    for (let turn = cp.turn + 1; turn <= this.maxTurns; turn++) {
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
        };
      }

      // ── beforeTurn hook — mirrors _runPrompt ─────────────────────────────
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
          await hooks.beforeTurn(state);
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `beforeTurn hook threw: ${err.message ?? err}`,
          });
        }
      }

      onMessage({ type: "agentTurn", text: `⟳ Turn ${turn}/${this.maxTurns}` });

      let response: CallAIResult;
      try {
        console.log(
          `[Executor] Resume Prompt Turn ${turn} - About to call API`,
        );
        response = await this.callAIFn!(agentMessages, provider);
        totalTokens += response.usage?.total_tokens ?? 0;
      } catch (err: any) {
        return {
          success: false,
          summary: `Agent stopped on resume turn ${turn}: ${err.message}`,
          toolsUsed,
          turnsUsed: turn,
          filesChanged,
          tokensUsed: totalTokens,
          error: err.message,
        };
      }

      // ── shouldContinue hook — mirrors _runPrompt ─────────────────────────
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
            };
          }
        } catch (err: any) {
          onMessage({
            type: "agentTool",
            text: `shouldContinue hook threw: ${err.message ?? err}`,
          });
        }
      }

      // ── Raw token budget fallback — only if no hooks wired ───────────────
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
        };
      }

      const raw = response.content;
      const toolCalls = this._parseAllToolCalls(raw);

      if (toolCalls.length === 0) {
        const clean = this._cleanDoneMessage(raw);
        onMessage({ type: "agentDone", text: `${clean}` });
        return {
          success: true,
          summary: this._buildSummary(task, clean, toolsUsed, turn),
          toolsUsed,
          turnsUsed: turn,
          filesChanged,
          tokensUsed: totalTokens,
        };
      }

      agentMessages.push({ role: "assistant", content: raw });

      for (const { tool, args } of toolCalls) {
        // ── Loop detection — mirrors _runPrompt ──────────────────────────
        if (this.loopDetector.detectToolLoop(tool, args)) {
          onMessage({
            type: "agentTool",
            text: `🔄 Loop detected: ${tool} called repeatedly. Stopping.`,
          });
          return {
            success: false,
            summary: `Agent stopped — detected tool loop on ${tool}`,
            toolsUsed,
            turnsUsed: turn,
            filesChanged,
            tokensUsed: totalTokens,
            error: "Tool loop detected",
          };
        }

        onMessage({
          type: "agentTool",
          text: `${tool}(${Object.keys(args).join(", ")})`,
        });

        let toolResult: { tool: string; success: boolean; output: string };
        try {
          toolResult = await this.executeToolFn!(tool, args, onMessage, cfg);
        } catch (err: any) {
          toolResult = {
            tool,
            success: false,
            output: `Error: ${err.message}`,
          };
        }

        toolsUsed.push(tool);
        memory?.trackToolUsed(tool);

        // ── onToolExecuted added — was missing in original ────────────────
        if (toolResult.success) {
          if (
            tool === "editFile" ||
            tool === "createFile" ||
            tool === "runTerminal"
          ) {
            const changedPath = args.path || args.filePath || "terminal";
            filesChanged.push(changedPath);
            memory?.trackFileTouched(changedPath);
            cfg.onToolExecuted?.(tool);
          }
        }

        // ── afterToolExecution hook — mirrors _runPrompt ─────────────────
        if (hooks?.afterToolExecution) {
          try {
            const toolCtx: ToolExecutionContext = {
              tool,
              args,
              turn,
              taskContext: task,
            };
            const mutated = await hooks.afterToolExecution(
              tool,
              toolResult,
              toolCtx,
            );
            if (mutated === null) {
              continue;
            }
            toolResult = mutated;
          } catch (err: any) {
            onMessage({
              type: "agentTool",
              text: `afterToolExecution hook threw: ${err.message ?? err}`,
            });
          }
        }

        const compactOutput = toolResult.success
          ? this._compactToolResult(tool, toolResult.output)
          : toolResult.output;

        agentMessages.push({
          role: "user",
          content: toolResult.success
            ? `Tool result [${tool}]:\n${compactOutput}`
            : `Tool error [${tool}]:\n${compactOutput}\n\nTry a different approach.`,
        });

        const ttl = this._getTTL(tool);
        expiryMap.set(agentMessages.length - 1, turn + ttl);
      }

      this._pruneMessages(agentMessages, expiryMap, turn, fixedHeader);

      // save updated checkpoint
      this.saveCheckpoint({
        task,
        plan,
        turn,
        messages: [...agentMessages],
        filesChanged: [...filesChanged],
        toolsUsed: [...toolsUsed],
        tokensUsed: totalTokens,
        lastInputTokens: 0,
        timestamp: Date.now(),
        fixedHeader,
        expiryMap: Array.from(expiryMap.entries()),
        runId: cp.runId,
      });
    }

    return {
      success: false,
      summary: this._buildCapSummary(task, toolsUsed, this.maxTurns),
      toolsUsed,
      turnsUsed: this.maxTurns,
      filesChanged,
      tokensUsed: totalTokens,
    };
  }

  private _resolveSystemPrompt(
    projectContext: string,
    cfg: AgentConfig,
  ): string {
    return projectContext;
  }

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

  // ── TTL — how many turns a tool result stays in context ─────────────────

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

  // ── Compact large tool outputs to stay under context limits ───────────────

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

  // ── Prune expired messages to stay under context limits ───────────────────

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
          const calls = parsed
            .filter((item: any) => typeof item?.tool === "string")
            .map((item: any) => ({ tool: item.tool, args: item.args ?? {} }));
          if (calls.length > 0) return calls;
        }
      } catch {}
    }

    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (typeof parsed?.tool === "string") {
          return [{ tool: parsed.tool, args: parsed.args ?? {} }];
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
