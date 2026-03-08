/**
 * Pluggable agent execution hooks
 *
 * Lifecycle hooks allow observing and customizing agent behavior at key points:
 *   - beforeTurn: at start of each turn, before AI call
 *   - afterToolExecution: after tool runs, before next AI call
 *   - afterPlan: after planning phase, before first turn
 *   - shouldContinue: decide whether to continue after each turn
 *   - onComplete: after task completes (success or failure)
 *   - onError: when an error occurs
 *
 * Usage:
 *   agent.setHooks({
 *     beforeTurn: async (state) => {
 *       console.log(`Turn ${state.turn}`);
 *     },
 *     shouldContinue: async (turn, messages, turnsRemaining) => {
 *       return turnsRemaining > 0 && tokensUsed < maxBudget;
 *     },
 *   });
 */

import type { Message, AgentResult, AgentConfig } from "../AgentEngine";
import { ToolResult } from "../ToolEngine";

// ── Turn state snapshot ────────────────────────────────────────────────────────

export interface AgentTurnState {
  /** Current turn number (1..maxTurns) */
  turn: number;

  /** All messages so far (system, user, assistant, tool results) */
  messages: Message[];

  /** The original task/user prompt */
  currentTask: string;

  /** Tools used so far in this run */
  toolsUsedSoFar: string[];

  /** Estimated total tokens used in this run */
  totalTokens: number;

  /** Files modified so far in this run */
  filesChanged: string[];
}

// ── Tool execution context ────────────────────────────────────────────────────

export interface ToolExecutionContext {
  /** Name of tool being executed */
  tool: string;

  /** Arguments passed to the tool */
  args: Record<string, string>;

  /** Which turn this tool was called in */
  turn: number;

  /** The original task context */
  taskContext: string;
}

// ── Hooks interface ───────────────────────────────────────────────────────────

/**
 * Pluggable lifecycle hooks for agent execution.
 * Each hook is optional. Implement only what you need.
 */
export interface AgentLifecycleHooks {
  /**
   * Called at the start of each turn, before AI call.
   * Use to:
   *   - Log current state
   *   - Enforce token budgets
   *   - Modify state (rare)
   *
   * Return modified state to alter agent behavior, or void/undefined to continue.
   */
  beforeTurn?: (
    state: AgentTurnState,
  ) => Promise<void | Partial<AgentTurnState>>;

  /**
   * Called after each tool execution, before adding result to messages.
   * Use to:
   *   - Filter or modify tool outputs
   *   - Log tool usage
   *   - Reject unwanted tool results
   *
   * Return modified result, null to skip this tool use, or promise resolves to continue.
   */
  afterToolExecution?: (
    tool: string,
    result: ToolResult,
    context: ToolExecutionContext,
  ) => Promise<ToolResult | null>;

  /**
   * Called after planning phase completes, before first turn executes.
   * Use to:
   *   - Inspect the plan
   *   - Modify the plan
   *   - Log planning output
   *
   * Return modified plan, or void/undefined to use original plan.
   */
  afterPlan?: (plan: string, task: string) => Promise<string | void>;

  /**
   * Called after each turn, before deciding whether to continue.
   * Use to:
   *   - Enforce turn limits beyond maxTurns
   *   - Enforce token budgets
   *   - Implement early exit conditions
   *
   * Return false to stop execution immediately (success), true to continue.
   */
  shouldContinue?: (
    turn: number,
    messages: Message[],
    turnsRemaining: number,
  ) => Promise<boolean>;

  /**
   * Called when agent run completes (success or failure).
   * Use to:
   *   - Log final results
   *   - Update metrics
   *   - Store results in external system
   *
   * Errors thrown here do NOT affect agent result, only logged.
   */
  onComplete?: (result: AgentResult) => Promise<void>;

  /**
   * Called when an error occurs during execution.
   * Use to:
   *   - Log errors
   *   - Notify monitoring systems
   *   - Decide whether to retry
   *
   * Return true to retry (if supported by ErrorHandler), false to propagate error.
   * This is called BEFORE ErrorHandler, for logging purposes.
   */
  onError?: (
    error: Error,
    context: {
      turn: number;
      tool?: string;
      task?: string;
    },
  ) => Promise<boolean>;
}

// ── Helper: No-op hooks (for defaults) ────────────────────────────────────────

export class NoOpHooks implements AgentLifecycleHooks {
  // All methods are implicitly empty
}

// ── Helper: Composable hooks (combine multiple hook sets) ──────────────────────

/**
 * Combine multiple hook sets into one.
 * All hooks are called in order.
 * Later hooks override earlier ones (for mutations).
 *
 * Example:
 *   const combined = composeHooks(
 *     new LoggingHooks(),
 *     new TokenBudgetHooks({ maxTokens: 100_000 }),
 *     new MetricsHooks(),
 *   );
 */
export function composeHooks(
  ...hooks: AgentLifecycleHooks[]
): AgentLifecycleHooks {
  return {
    beforeTurn: async (state: AgentTurnState) => {
      let result: Partial<AgentTurnState> | void = undefined;
      for (const h of hooks) {
        if (h.beforeTurn) {
          const res = await h.beforeTurn(state);
          if (res) result = res;
        }
      }
      return result;
    },

    afterToolExecution: async (
      tool: string,
      result: ToolResult,
      context: ToolExecutionContext,
    ) => {
      let output: ToolResult | null = result;
      for (const h of hooks) {
        if (h.afterToolExecution && output) {
          output = await h.afterToolExecution(tool, output, context);
        }
      }
      return output;
    },

    afterPlan: async (plan: string, task: string) => {
      let result: string | void = undefined;
      for (const h of hooks) {
        if (h.afterPlan) {
          const res = await h.afterPlan(plan, task);
          if (res) result = res;
        }
      }
      return result;
    },

    shouldContinue: async (turn, messages, turnsRemaining) => {
      for (const h of hooks) {
        if (h.shouldContinue) {
          const should = await h.shouldContinue(turn, messages, turnsRemaining);
          if (!should) return false;
        }
      }
      return true;
    },

    onComplete: async (result: AgentResult) => {
      for (const h of hooks) {
        if (h.onComplete) {
          try {
            await h.onComplete(result);
          } catch (err) {
            console.error("[Hooks] onComplete error:", err);
          }
        }
      }
    },

    onError: async (error, context) => {
      let shouldRetry = true;
      for (const h of hooks) {
        if (h.onError) {
          const should = await h.onError(error, context);
          if (!should) shouldRetry = false;
        }
      }
      return shouldRetry;
    },
  };
}

// ── Built-in hook implementations ─────────────────────────────────────────────

/**
 * Basic logging hook.
 * Logs state at each turn for debugging and monitoring.
 */
export class LoggingHooks implements AgentLifecycleHooks {
  constructor(private logger: (msg: string) => void = console.log) {}

  async beforeTurn(state: AgentTurnState): Promise<void> {
    this.logger(
      `[Turn ${state.turn}] Messages: ${state.messages.length}, Tools: ${state.toolsUsedSoFar.length}`,
    );
  }

  async afterToolExecution(
    tool: string,
    result: ToolResult,
  ): Promise<ToolResult> {
    this.logger(
      `[Tool] ${tool}: ${result.success ? "✓" : "✗"} (${result.output.length} chars)`,
    );
    return result;
  }

  async onComplete(result: AgentResult): Promise<void> {
    this.logger(
      `[Complete] ${result.success ? "Success" : "Failed"} in ${result.turnsUsed} turns`,
    );
  }

  async onError(
    error: Error,
    context: { turn: number; tool?: string },
  ): Promise<boolean> {
    this.logger(`[Error@Turn ${context.turn}] ${error.message}`);
    return true;
  }
}

/**
 * Token budget enforcement hook.
 * Stops execution if token budget exceeded.
 *
 * Note: This is an approximation based on message length.
 * For accurate token counting, integrate with tokenizers.
 */
export class TokenBudgetHooks implements AgentLifecycleHooks {
  private maxTokens: number;
  private tokensPerChar: number = 0.25; // Rough estimate

  constructor(
    options: { maxTokens: number; tokensPerChar?: number } = {
      maxTokens: 100_000,
    },
  ) {
    this.maxTokens = options.maxTokens;
    this.tokensPerChar = options.tokensPerChar ?? 0.25;
  }

  async beforeTurn(state: AgentTurnState): Promise<void> {
    const estimatedTokens = state.messages.reduce(
      (sum, msg) => sum + msg.content.length * this.tokensPerChar,
      0,
    );

    const percent = (estimatedTokens / this.maxTokens) * 100;
    if (percent > 80) {
      console.warn(`[TokenBudget] Using ${percent.toFixed(1)}% of budget`);
    }

    state.totalTokens = Math.ceil(estimatedTokens);
  }

  async shouldContinue(
    _turn: number,
    messages: Message[],
    _turnsRemaining: number,
  ): Promise<boolean> {
    const estimatedTokens = messages.reduce(
      (sum, msg) => sum + msg.content.length * this.tokensPerChar,
      0,
    );

    if (estimatedTokens > this.maxTokens) {
      console.warn(
        `[TokenBudget] Budget exceeded: ${estimatedTokens} > ${this.maxTokens}`,
      );
      return false;
    }

    return true;
  }
}

/**
 * Tool result filtering hook.
 * Truncates verbose tool outputs to save tokens.
 */
export class TruncationHooks implements AgentLifecycleHooks {
  private maxOutputLength: number;

  constructor(maxOutputLength: number = 10_000) {
    this.maxOutputLength = maxOutputLength;
  }

  async afterToolExecution(
    _tool: string,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (result.output.length > this.maxOutputLength) {
      return {
        ...result,
        output:
          result.output.slice(0, this.maxOutputLength) + `\n... (truncated)`,
      };
    }
    return result;
  }
}

/**
 * Turn limit enforcement hook.
 * Stops execution after N turns regardless of maxTurns.
 */
export class TurnLimitHooks implements AgentLifecycleHooks {
  constructor(private maxTurns: number) {}

  async shouldContinue(
    turn: number,
    _messages: Message[],
    _turnsRemaining: number,
  ): Promise<boolean> {
    if (turn >= this.maxTurns) {
      console.log(`[TurnLimit] Reached ${this.maxTurns} turns`);
      return false;
    }
    return true;
  }
}
