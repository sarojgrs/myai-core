/**
 * Bridges myai-core to CLI/terminal
 *
 * Wires:
 *   ContextEngine
 *     + FileSystemContextProvider  (project structure, myai.config.json)
 *     + MemoryContextProvider      (optional, past tasks)
 *
 * No EditorContextProvider — CLI has no active editor.
 * No vscode imports — pure Node.js + readline.
 */

import * as readline from "readline";
import { createAgent, CreateAgentOptions, createChat } from "../index";
import type { AgentEngine } from "../core/AgentEngine";
import type { ChatEngine } from "../core/ChatEngine";
import { ContextEngine } from "../core/ContextEngine";
import { MemoryEngine } from "../core/MemoryEngine";
import { FileSystemContextProvider } from "../core/contextProvider/FileSystemContext";
import { MemoryContextProvider } from "../core/contextProvider/MemoryContext";

// ── ANSI colours ──────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

function formatMessage(msg: any): string {
  switch (msg.type) {
    case "agentStart":
      return `\n${BOLD}${CYAN}🤖 Task: ${msg.text}${RESET}`;
    case "agentPlan":
      return `\n${DIM}📋 Plan:\n${msg.text}${RESET}`;
    case "agentTurn":
      return `${DIM}${msg.text}${RESET}`;
    case "agentTool":
      return `  ${CYAN}${msg.text}${RESET}`;
    case "agentDone":
      return `\n${BOLD}${GREEN}${msg.text}${RESET}`;
    case "agentError":
      return `\n${BOLD}${RED}${msg.text}${RESET}`;
    case "runOutput":
      return `${DIM}${msg.text}${RESET}`;
    default:
      return msg.text ?? "";
  }
}

// ── CLIAdapter ────────────────────────────────────────────────────────────────

export class CLIAdapter {
  private _workspaceRoot: string;
  private _silent: boolean;
  private _memoryEngine: MemoryEngine;

  constructor(options: { workspaceRoot?: string; silent?: boolean } = {}) {
    this._workspaceRoot = options.workspaceRoot ?? process.cwd();
    this._silent = options.silent ?? false;
    this._memoryEngine = new MemoryEngine(this._workspaceRoot);
  }

  async confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(
        `\n${YELLOW}  ${message}\n   Allow? (y/n): ${RESET}`,
        (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase() === "y");
        },
      );
    });
  }

  onMessage(msg: any): void {
    if (this._silent) return;
    const formatted = formatMessage(msg);
    if (formatted) process.stdout.write(formatted + "\n");
  }

  getWorkspaceRoot(): string {
    return this._workspaceRoot;
  }

  getMemoryEngine(): MemoryEngine {
    return this._memoryEngine;
  }

  // ── createAgent() ─────────────────────────────────────────────────────────

  createAgent(
    options: Omit<
      CreateAgentOptions,
      "workspaceRoot" | "onMessage" | "confirm"
    > & {
      workspaceRoot?: string;
      enableMemory?: boolean;
    },
  ): AgentEngine {
    const { workspaceRoot, enableMemory = false, ...rest } = options;
    const root = workspaceRoot ?? this._workspaceRoot;
    const memory = enableMemory ? this._memoryEngine : undefined;

    const { agent } = createAgent({
      ...rest,
      workspaceRoot: root,
      onMessage: (msg) => this.onMessage(msg),
      confirm: (msg) => this.confirm(msg),
      memory,
    });

    // Hoist context providers — one instance per agent, never re-created per call
    const fsProvider = new FileSystemContextProvider(root);
    const memProvider = enableMemory
      ? new MemoryContextProvider(this._memoryEngine)
      : null;

    // Build the ContextEngine ONCE here, outside the closure.
    // Previously a new ContextEngine() was created on every run() invocation,
    // discarding the cache on every turn. The closure now captures the single
    // engine instance — identical to how VSCodeAdapter does it correctly.
    const engine = new ContextEngine().use(fsProvider);
    if (memProvider) engine.use(memProvider);

    // Override the default gatherContext wired by createAgent() with a richer
    // version that receives the actual task for memory-aware context recall.
    agent.setGatherContext(async (_root: string, task?: string) => {
      return engine.buildContext(task ?? "");
    });

    return agent;
  }

  // ── createChat() — returns a wired ChatEngine for CLI ─────────────────────

  createChat(
    options: {
      workspaceRoot?: string;
      profile?: string;
      enableMemory?: boolean;
      provider?: string;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      maxHistory?: number;
    } = {},
  ): ChatEngine {
    const root = options.workspaceRoot ?? this._workspaceRoot;
    const enableMemory = options.enableMemory ?? false;

    const fsProvider = new FileSystemContextProvider(root);
    const contextEngine = new ContextEngine().use(fsProvider);
    if (enableMemory) {
      contextEngine.use(new MemoryContextProvider(this._memoryEngine));
    }

    const { chat } = createChat({
      workspaceRoot: root,
      provider: options.provider,
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl,
      profile: options.profile,
      maxHistory: options.maxHistory,
      memory: enableMemory ? this._memoryEngine : undefined,
      contextEngine,
    });

    return chat;
  }
}

// ── runCLI() — convenience entry point for bin/myai.ts ───────────────────────

export async function runCLI(
  task: string,
  options: {
    provider: string;
    apiKey: string;
    model: string;
    baseUrl: string;
    profile?: string;
    workspaceRoot?: string;
    enableMemory?: boolean;
    silent?: boolean;
  },
): Promise<void> {
  const adapter = new CLIAdapter({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    silent: options.silent ?? false,
  });

  const agent = adapter.createAgent({
    provider: options.provider,
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    profile: options.profile ?? "code",
    enableMemory: options.enableMemory ?? false,
  });

  const result = await agent.run(task);

  if (!result.success) {
    console.error(
      `\n${RED}\x1b[1m Agent failed: ${result.error ?? result.summary}\x1b[0m`,
    );
    process.exit(1);
  }
}
