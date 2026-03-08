/**
 * Bridges myai-core to VS Code
 *
 * The ONLY file in myai-core that imports vscode.
 * All vscode coupling is intentionally isolated here.
 *
 * Wires:
 *   ContextEngine
 *     + FileSystemContextProvider  (project structure, myai.config.json)
 *     + EditorContextProvider      (active file, cursor, tabs)
 *     + MemoryContextProvider      (optional, past tasks)
 */

import * as vscode from "vscode";
import { createAgent, CreateAgentOptions, createChat } from "../index";
import type { AgentEngine } from "../core/AgentEngine";
import type { ChatEngine } from "../core/ChatEngine";
import { ContextEngine } from "../core/ContextEngine";
import { MemoryEngine } from "../core/MemoryEngine";
import { ProviderEngine } from "../core/ProviderEngine";
import { ProfileManager } from "../core/ProfileManager";
import { FileSystemContextProvider } from "../core/contextProvider/FileSystemContext";
import { MemoryContextProvider } from "../core/contextProvider/MemoryContext";
import {
  EditorContextProvider,
  EditorState,
} from "../core/contextProvider/EditorContext";

export type { ContextLevel } from "../core/contextProvider/EditorContext";

export class VSCodeAdapter {
  private _context: vscode.ExtensionContext;
  private _memoryEngine: MemoryEngine;

  // Stored after createAgent() so createChat() can share the same provider engine
  private _providerEngine: ProviderEngine | null = null;
  private _profileManager: ProfileManager | null = null;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._memoryEngine = new MemoryEngine(this.getWorkspaceRoot());
  }

  // ── VS Code confirmation modal ────────────────────────────────────────────

  async confirm(message: string): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(
      `🤖 ${message}`,
      { modal: true },
      " Allow",
      " Deny",
    );
    return result === " Allow";
  }

  // ── Workspace root ────────────────────────────────────────────────────────

  getWorkspaceRoot(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error("No workspace folder open");
    return root;
  }

  // ── Editor state ──────────────────────────────────────────────────────────

  getEditorState(): EditorState {
    const editor = vscode.window.activeTextEditor;
    const root = this.getWorkspaceRoot();

    if (!editor) {
      return {
        activeFilePath: "",
        activeFileContent: "",
        language: "plaintext",
        cursorLine: 0,
        selectedText: "",
        openTabs: [],
        workspaceRoot: root,
      };
    }

    const doc = editor.document;
    const openTabs = vscode.workspace.textDocuments
      .filter((d) => d.uri.scheme === "file" && d.fileName !== doc.fileName)
      .slice(0, 5)
      .map((d) => ({
        path: d.fileName,
        language: d.languageId,
        content: d.getText().slice(0, 2000),
      }));

    return {
      activeFilePath: doc.fileName,
      activeFileContent: doc.getText(),
      language: doc.languageId,
      cursorLine: editor.selection.active.line + 1,
      selectedText: doc.getText(editor.selection),
      openTabs,
      workspaceRoot: root,
    };
  }

  // ── createAgent() ─────────────────────────────────────────────────────────

  createAgent(
    options: Omit<
      CreateAgentOptions,
      "workspaceRoot" | "onMessage" | "confirm"
    > & {
      postMessage: (msg: any) => void;
      workspaceRoot?: string;
      contextLevel?: import("../core/contextProvider/EditorContext").ContextLevel;
      enableMemory?: boolean;
    },
  ): AgentEngine {
    const {
      postMessage,
      workspaceRoot,
      contextLevel = "auto",
      enableMemory = false,
      ...rest
    } = options;

    const root = workspaceRoot ?? this.getWorkspaceRoot();
    const memory = enableMemory ? this._memoryEngine : undefined;

    const { agent } = createAgent({
      ...rest,
      workspaceRoot: root,
      onMessage: postMessage,
      confirm: (msg) => this.confirm(msg),
      memory,
    });

    // Hoist all providers — one instance per agent, never re-created per call
    const fsProvider = new FileSystemContextProvider(root);
    const editorProvider = new EditorContextProvider(this.getEditorState(), {
      level: contextLevel,
    });
    const memProvider = enableMemory
      ? new MemoryContextProvider(this._memoryEngine)
      : null;

    // Capture task for BOTH run() and chat()
    let _currentTask = "";

    const originalRun = agent.run.bind(agent);
    agent.run = async (task: string, overrides?: any) => {
      _currentTask = task;
      // Refresh editor state on each run — cursor position may have changed
      editorProvider.updateState(this.getEditorState());
      return originalRun(task, overrides);
    };

    //  Intercept chat() for memory recall
    const originalChat = (agent as any).chat?.bind(agent);
    if (originalChat) {
      (agent as any).chat = async (query: string, opts?: any) => {
        _currentTask = query;
        return originalChat(query, opts);
      };
    }

    agent.setGatherContext(async (_root: string, task?: string) => {
      const resolvedTask = task ?? _currentTask;
      // Context sequence: FileSystem → Memory → Editor
      const engine = new ContextEngine().use(fsProvider);
      if (memProvider) engine.use(memProvider);
      engine.use(editorProvider);
      return engine.buildContext(resolvedTask);
    });

    return agent;
  }

  //  createChat() — wired ChatEngine with shared provider ───────
  //
  // Context sequence: FileSystem → Memory → Editor (same order as agent)
  // Provider: falls back to the agent's providerEngine via setGetActiveProvider
  // so chat and agent always use the same underlying provider unless overridden.

  createChat(
    options: {
      workspaceRoot?: string;
      profile?: string;
      enableMemory?: boolean;
      contextLevel?: import("../core/contextProvider/EditorContext").ContextLevel;
      provider?: string;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      maxHistory?: number;
      agentProviderEngine?: ProviderEngine; // pass from createCustomAgent result to share
    } = {},
  ): ChatEngine {
    const root = options.workspaceRoot ?? this.getWorkspaceRoot();
    const contextLevel = options.contextLevel ?? "auto";
    const enableMemory = options.enableMemory ?? false;

    // Build context engine with correct sequence: FileSystem → Memory → Editor
    const fsProvider = new FileSystemContextProvider(root);
    const editorProvider = new EditorContextProvider(this.getEditorState(), {
      level: contextLevel,
    });
    const contextEngine = new ContextEngine().use(fsProvider); // 1. structure

    if (enableMemory) {
      contextEngine.use(new MemoryContextProvider(this._memoryEngine)); // 2. memory
    }
    contextEngine.use(editorProvider); // 3. editor

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

    // Share provider engine with agent — chat uses same provider by default
    // Update editor state on send so chat always has current cursor context
    if (options.agentProviderEngine) {
      chat.setCallAI((msgs, prov) =>
        options.agentProviderEngine!.callAI(msgs, prov),
      );
      chat.setGetActiveProvider(() =>
        options.agentProviderEngine!.getActiveProvider(),
      );
    }

    // Refresh editor state before each session start
    const originalStart = chat.startSession.bind(chat);
    chat.startSession = async (query?: string) => {
      editorProvider.updateState(this.getEditorState());
      return originalStart(query);
    };

    return chat;
  }

  // ── Expose engines for advanced use ──────────────────────────────────────

  getMemoryEngine(): MemoryEngine {
    return this._memoryEngine;
  }

  /**
   * Call on extension deactivate.
   * Promotes mid-term memories → long-term, writes session.json synchronously.
   *
   * In extension.ts:
   *   export function deactivate() { adapter.dispose() }
   */
  dispose(): void {
    this._memoryEngine.endSession();
  }
}
