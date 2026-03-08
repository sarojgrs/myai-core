/**
 *  Public API for @saroj/myai-core
 *
 * Single entry point for the library.
 *
 * Quick start:
 *   import { createAgent } from "@saroj/myai-core"
 *
 *   const { agent } = createAgent({
 *     provider: "cerebras",
 *     apiKey: "your-key",
 *     model: "llama-4-scout",
 *     baseUrl: "https://api.cerebras.ai/v1",
 *     workspaceRoot: "/path/to/project",
 *     profile: "code",
 *     onMessage: (msg) => console.log(msg.text),
 *   })
 *
 *   await agent.run("fix the login bug")
 */

// ── Core engines ──────────────────────────────────────────────────────────────
export { AgentEngine } from "./core/AgentEngine";
export { MemoryEngine } from "./core/MemoryEngine";
export { ChatEngine } from "./core/ChatEngine";
export { AgentManager, type ManagedAgent } from "./core/AgentManager";
export { ToolRegistry } from "./core/registry/ToolRegistry";

// ── AgentEngine types ─────────────────────────────────────────────────────────
export type {
  AgentConfig,
  AgentResult,
  AgentMemory,
  PipelineResult,
  PipelineStep,
  PipelineStepResult,
  Message,
  PlannerContext,
  ExecutorContext,
  AgentMessage,
  AgentMessageType,
} from "./core/AgentEngine";

// ── Executor types ────────────────────────────────────────────────────────────
// ExecutorCheckpoint is the value returned by agent.getCheckpoint(task).
// Pass it directly to agent.resumeFromCheckpoint(cp) to resume an interrupted run.
export type { ExecutorCheckpoint } from "./core/agent/Executor";

// ── ToolEngine ────────────────────────────────────────────────────────────────
export {
  ToolEngine,
  TOOL_DEFINITIONS,
  buildToolSystemPrompt,
} from "./core/ToolEngine";
export type { ToolDefinition, ToolResult } from "./core/ToolEngine";

// ── ProviderEngine ────────────────────────────────────────────────────────────
export { ProviderEngine } from "./core/ProviderEngine";
export type {
  ProviderConfig,
  NativeTool,
  ToolCallResponse,
  ProviderCapabilities,
} from "./core/ProviderEngine";
export type { ProviderAdapter } from "./core/providers/Types";

// ── ProfileManager ────────────────────────────────────────────────────────────
export { ProfileManager } from "./core/ProfileManager";
export type { ProfileConfig } from "./core/ProfileManager";
export { BaseProfile } from "./core/profiles/Base";
export { CodeProfile } from "./core/profiles/Code";
export { DevOpsProfile } from "./core/profiles/DevOps";
export { GeneralProfile } from "./core/profiles/General";
export { ResearchProfile } from "./core/profiles/Research";
export { SupportProfile } from "./core/profiles/Support";
export { AutomationProfile } from "./core/profiles/Automation";

// ── Context system ────────────────────────────────────────────────────────────
export { ContextEngine } from "./core/ContextEngine";
export { BaseContextProvider } from "./core/contextProvider/Base";
export { FileSystemContextProvider } from "./core/contextProvider/FileSystemContext";
export { EditorContextProvider } from "./core/contextProvider/EditorContext";
export { MemoryContextProvider } from "./core/contextProvider/MemoryContext";
export type { ContextProvider } from "./core/ContextEngine";
export type {
  EditorState,
  ContextLevel,
  FileEntry,
} from "./core/contextProvider/EditorContext";
export type { MyAIConfig } from "./core/contextProvider/FileSystemContext";

// ── Recall strategies ─────────────────────────────────────────────────────────
export type {
  RecallStrategy,
  RecallResult,
} from "./core/strategies/RecallStrategy";
export {
  HybridRecallStrategy,
  TextSimilarityRecallStrategy,
  TimeDecayRecallStrategy,
  SuccessWeightedRecallStrategy,
  FileAffinityRecallStrategy,
  ToolAffinityRecallStrategy,
  CustomRecallStrategy,
} from "./core/strategies/RecallStrategy";

// ── Error handlers ────────────────────────────────────────────────────────────
export type { ErrorHandler, ErrorContext, ErrorAction } from "./ErrorHandler";
export {
  DefaultErrorHandler,
  StrictErrorHandler,
  ResilientErrorHandler,
} from "./ErrorHandler";

// ── Adapters ──────────────────────────────────────────────────────────────────
export { CLIAdapter, runCLI } from "./adapters/CLIAdapter";

// ── Misc types ────────────────────────────────────────────────────────────────
export type { ChatConfig, ChatSession } from "./core/ChatEngine";
export type { MemoryConfig } from "./core/MemoryEngine";

// factories — re-exported from factory.ts for cleaner imports
export { createAgent, createChat } from "./factory";

// ── Lifecycle Hooks ───────────────────────────────────────────────────────────────────
export type {
  AgentLifecycleHooks,
  AgentTurnState,
  ToolExecutionContext,
} from "./core/hooks/AgentLifecycleHooks";
export {
  LoggingHooks,
  TokenBudgetHooks,
  TruncationHooks,
  TurnLimitHooks,
  composeHooks,
} from "./core/hooks/AgentLifecycleHooks";

export type {
  CreateAgentOptions,
  CreateAgentResult,
  CreateChatOptions,
  CreateChatResult,
  CustomProfileDefinition,
  ProviderEntry,
} from "./factory";
