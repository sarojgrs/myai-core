/**
 * Pluggable error recovery strategies
 *
 * Allows customization of how errors are handled during agent execution.
 * Built-in strategies: DefaultErrorHandler, StrictErrorHandler, ResilientErrorHandler
 *
 * Usage:
 *   const agent = createAgent({
 *     errorHandler: new DefaultErrorHandler(),
 *   });
 */

import type { Message } from "./core/AgentEngine";

// ── Error context and actions ─────────────────────────────────────────────────

/**
 * Represents the context in which an error occurred during agent execution.
 */
export interface ErrorContext {
  /** Which turn (1..N) this error occurred in */
  turn: number;

  /** Which tool failed (if applicable) */
  tool?: string;

  /** Which provider failed (if applicable) */
  provider?: string;

  /** The error that occurred */
  error: Error;

  /** Recent messages leading up to error (for context) */
  lastMessages?: Message[];

  /** Current task being executed */
  currentTask?: string;
}

/**
 * Represents the type of action to take when an error occurs.
 */
export type ErrorActionType =
  | "retry"
  | "fallback"
  | "abort"
  | "skip"
  | "continue";

/**
 * Represents the action to take when an error occurs.
 */
export interface ErrorAction {
  type: ErrorActionType;

  /** For "retry": delay in ms before retrying */
  delay?: number;

  /** For "retry": max attempts before giving up */
  maxRetries?: number;

  /** For "fallback": which provider to try next */
  provider?: string;

  /** For "fallback": which tool to try next */
  tool?: string;

  /** Reason/message for this action */
  message?: string;
}

// ── ErrorHandler interface ────────────────────────────────────────────────

/**
 * Interface for error handlers that define how errors are handled during agent execution.
 */
export interface ErrorHandler {
  /**
   * Handles an error that occurred during agent execution.
   *
   * @param context - The context in which the error occurred.
   * @returns The action to take in response to the error.
   */
  handleError(context: ErrorContext): ErrorAction;
}

// ── Built-in error handlers ───────────────────────────────────────────────

/**
 * Default error handler that provides a basic error recovery strategy.
 */
export interface DefaultErrorHandlerOptions {
  maxRetries?: number; // number of retries on the same provider after a failure
  delayMs?: number; // base delay before retrying (can be used with backoff by caller)
  fallbackProvider?: string; // optional single fallback provider to try after retries exhaust
}

export class DefaultErrorHandler implements ErrorHandler {
  private readonly opts: DefaultErrorHandlerOptions;

  constructor(options: DefaultErrorHandlerOptions = {}) {
    this.opts = options;
  }

  handleError(context: ErrorContext): ErrorAction {
    console.error(`Error in turn ${context.turn}:`, context.error.message);
    const action: ErrorAction = {
      type: "retry",
      delay: this.opts.delayMs ?? 1000,
      maxRetries: this.opts.maxRetries ?? 3,
    };
    if (this.opts.fallbackProvider) {
      action.type = "retry"; // primary guidance is retry; caller may use provider for failover after retries
      action.provider = this.opts.fallbackProvider;
    }
    return action;
  }
}

/**
 * Strict error handler that aborts execution on any error.
 */
export class StrictErrorHandler implements ErrorHandler {
  handleError(context: ErrorContext): ErrorAction {
    console.error(
      `Strict error in turn ${context.turn}:`,
      context.error.message,
    );
    return { type: "abort", message: "Aborting due to error" };
  }
}

/**
 * Resilient error handler that attempts to continue execution despite errors.
 */
export class ResilientErrorHandler implements ErrorHandler {
  handleError(context: ErrorContext): ErrorAction {
    console.error(
      `Resilient error in turn ${context.turn}:`,
      context.error.message,
    );
    return { type: "continue", message: "Continuing despite error" };
  }
}

// ── Error handling utilities ────────────────────────────────────────────

/**
 * Logs an error with additional context.
 *
 * @param context - The context in which the error occurred.
 */
export function logError(context: ErrorContext): void {
  console.error(
    `Error in turn ${context.turn}:
` +
      `Tool: ${context.tool || "N/A"}
` +
      `Provider: ${context.provider || "N/A"}
` +
      `Task: ${context.currentTask || "N/A"}
` +
      `Error: ${context.error.message}
` +
      `Stack: ${context.error.stack || "N/A"}`,
  );
}

/**
 * Creates a custom error with additional context.
 *
 * @param message - The error message.
 * @param context - The context in which the error occurred.
 * @returns A new Error instance with additional context.
 */
export function createError(message: string, context: ErrorContext): Error {
  const error = new Error(message);
  (error as any).context = context;
  return error;
}
