/**
 * Stateful conversational engine
 *
 * Completely separate from AgentEngine.
 * No tools, no planning loop, no turn limit, no confirmation callbacks.
 *
 * KEY BEHAVIOURS:
 *   - Context gathered ONCE at startSession() — never re-gathered per turn
 *   - Memory recall uses the real opening query — not empty string
 *   - Provider locked at session start — immune to pipeline provider switching
 *   - Profile defaults to "support" — read-only, conversational, no git ops
 *   - History trimmed in pairs — never breaks conversation coherence
 *   - Streaming first-class via setCallAIStream()
 *
 * Provider resolution priority (highest → lowest):
 *   1. ChatConfig.provider explicitly set
 *   2. getActiveProviderFn() — whatever AgentEngine currently uses
 *   3. "cerebras" — hardcoded last-resort fallback
 *
 * Context sequence (fixed order, registered at startSession):
 *   1. FileSystemContextProvider  — project structure, conventions
 *   2. MemoryContextProvider      — past tasks scored against opening query
 *   3. EditorContextProvider      — active file/cursor (if adapter injects contextEngine)
 */

import type { Message, CallAIResult } from "./AgentEngine";
import type { ContextEngine } from "./ContextEngine";
import type { MemoryEngine } from "./MemoryEngine";
import { FileSystemContextProvider } from "./contextProvider/FileSystemContext";
import { MemoryContextProvider } from "./contextProvider/MemoryContext";

// ── Config ────────────────────────────────────────────────────────────────────

export interface ChatConfig {
  workspaceRoot: string;

  /**
   * Provider to use for chat calls.
   * If omitted, falls back to getActiveProviderFn() (the agent's active provider).
   */
  provider?: string;

  /**
   * Profile to activate at session start.
   * Defaults to "support" — read-only, friendly, no tools, no git.
   */
  profile?: string;

  /** Override the profile's system prompt entirely. */
  systemPrompt?: string;

  /** Prepended to every user message — same semantics as AgentConfig.userPrompt. */
  userPrompt?: string;

  /**
   * Pre-built ContextEngine to use at startSession().
   * If not provided, ChatEngine builds one automatically:
   *   FileSystemContextProvider (always)
   *   + MemoryContextProvider (if config.memory is set)
   *
   * Pass a pre-built engine from the adapter to include EditorContextProvider.
   */
  contextEngine?: ContextEngine;

  /**
   * MemoryEngine for recall.
   * Only used when contextEngine is NOT provided.
   * If you provide contextEngine, wire MemoryContextProvider into it yourself.
   */
  memory?: MemoryEngine;

  /**
   * Max messages kept in history (oldest pairs dropped first to stay within budget).
   * Counted in messages — 20 = 10 back-and-forth turns.
   * Default: 20.
   */
  maxHistory?: number;
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface ChatSession {
  /** System prompt + project context — locked in at startSession, never re-gathered */
  systemPrompt: string;
  /** Resolved provider for this session — immune to pipeline switches */
  provider: string;
  /** Active profile name */
  profile: string;
  history: Message[];
  startedAt: number;
}

// ── ChatEngine ────────────────────────────────────────────────────────────────

export class ChatEngine {
  private config: ChatConfig;
  private session: ChatSession | null = null;

  // ── Injected dependencies — same DI pattern as AgentEngine ───────────────
  private callAIFn?: (
    messages: Message[],
    provider: string,
  ) => Promise<CallAIResult | string>;
  private callAIStreamFn?: (
    messages: Message[],
    provider: string,
    onChunk: (chunk: string) => void,
  ) => Promise<string>;
  /** Returns the agent's currently active provider — used as fallback */
  private getActiveProviderFn?: () => string;
  /** Returns the active profile's system prompt */
  private profileSystemPromptFn?: () => string;
  /** Switches the active profile — called once at startSession */
  private switchProfileFn?: (name: string) => void;

  constructor(config: ChatConfig) {
    this.config = config;
  }

  // ── Dependency injection ──────────────────────────────────────────────────

  setCallAI(
    fn: (
      messages: Message[],
      provider: string,
    ) => Promise<CallAIResult | string>,
  ): void {
    this.callAIFn = fn as (
      messages: Message[],
      provider: string,
    ) => Promise<CallAIResult>;
  }

  setCallAIStream(
    fn: (
      messages: Message[],
      provider: string,
      onChunk: (c: string) => void,
    ) => Promise<string>,
  ): void {
    this.callAIStreamFn = fn;
  }

  /** Wire to providerEngine.getActiveProvider — used as provider fallback */
  setGetActiveProvider(fn: () => string): void {
    this.getActiveProviderFn = fn;
  }

  /** Wire to profileManager.buildSystemPrompt */
  setProfileSystemPrompt(fn: () => string): void {
    this.profileSystemPromptFn = fn;
  }

  /** Wire to profileManager.switch */
  setSwitchProfile(fn: (name: string) => void): void {
    this.switchProfileFn = fn;
  }

  // ── Provider resolution ───────────────────────────────────────────────────

  private _resolveProvider(): string {
    return (
      this.config.provider ??
      (this.getActiveProviderFn ? this.getActiveProviderFn() : null) ??
      "cerebras"
    );
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Start a new chat session.
   * Gathers context ONCE here — never re-gathered on subsequent send() calls.
   *
   * Pass openingQuery so MemoryContextProvider scores recall against the real
   * first question (not empty string). If you call send() without startSession(),
   * the first query is used automatically via auto-start.
   */
  async startSession(openingQuery: string = ""): Promise<void> {
    // 1. Lock provider for this session
    const provider = this._resolveProvider();

    // 2. Activate profile (default: "support")
    const profileName = this.config.profile ?? "support";
    this.switchProfileFn?.(profileName);

    // 3. Build context engine if not injected by adapter
    let contextEngine = this.config.contextEngine;
    if (!contextEngine) {
      const { ContextEngine: CE } = await import("./ContextEngine");
      contextEngine = new CE().use(
        new FileSystemContextProvider(this.config.workspaceRoot),
      );
      if (this.config.memory) {
        contextEngine.use(new MemoryContextProvider(this.config.memory));
      }
    }

    // 4. Gather context ONCE — scored against the real opening query
    let projectContext = "";
    try {
      projectContext = await contextEngine.buildContext(openingQuery);
    } catch (err: any) {
      console.warn(
        "[ChatEngine] Failed to build context for query:",
        err?.message || String(err),
      );
    }

    // 5. Build system prompt
    const persona =
      this.config.systemPrompt ??
      (this.profileSystemPromptFn ? this.profileSystemPromptFn() : "");

    const systemContent = [persona, projectContext]
      .filter(Boolean)
      .join("\n\n");

    this.session = {
      systemPrompt: systemContent,
      provider,
      profile: profileName,
      history: [],
      startedAt: Date.now(),
    };

    console.log(
      `[ChatEngine] Session started | provider=${provider} profile=${profileName} context=${projectContext.length} chars`,
    );
  }

  /**
   * Send a message and receive a reply.
   *
   * Auto-starts a session if none is active, using the first query as the
   * memory recall seed — so recall is correct even without explicit startSession().
   *
   * Context is NOT re-gathered here. Turns 2–N use the locked system prompt
   * from startSession() — no extra I/O, no redundant token spend.
   */
  async send(
    query: string,
    options: { stream?: (chunk: string) => void } = {},
  ): Promise<string> {
    if (!this.callAIFn)
      throw new Error("[ChatEngine] callAI not set. Call setCallAI() first.");

    // Auto-start: use first real query as context seed
    if (!this.session) {
      await this.startSession(query);
    }

    const userContent = this.config.userPrompt
      ? `${this.config.userPrompt}\n\n${query}`
      : query;

    const messages: Message[] = [
      { role: "system", content: this.session!.systemPrompt },
      ...this._trimmedHistory(),
      { role: "user", content: userContent },
    ];

    const result =
      options.stream && this.callAIStreamFn
        ? await this.callAIStreamFn(
            messages,
            this.session!.provider,
            options.stream,
          )
        : await this.callAIFn(messages, this.session!.provider);

    // Extract content if result is a CallAIResult object, otherwise use as-is
    const reply = typeof result === "string" ? result : result.content;

    // Append to history only after successful reply
    this.session!.history.push(
      { role: "user", content: userContent },
      { role: "assistant", content: reply },
    );

    return reply;
  }

  // ── Session control ───────────────────────────────────────────────────────

  /**
   * Clear conversation history but keep the system prompt and context.
   * Cheaper than endSession() + startSession() — no fs I/O.
   * Use when the user starts a new topic within the same session.
   */
  clearHistory(): void {
    if (this.session) this.session.history = [];
  }

  /**
   * End the session. Next send() will re-gather context from scratch.
   * Use when switching workspaces or after a long idle period.
   */
  endSession(): void {
    this.session = null;
    console.log("[ChatEngine] Session ended");
  }

  isActive(): boolean {
    return this.session !== null;
  }

  getHistory(): Message[] {
    return this.session?.history ?? [];
  }

  getSession(): ChatSession | null {
    return this.session;
  }

  getResolvedProvider(): string {
    return this.session?.provider ?? this._resolveProvider();
  }

  // ── History trimming ──────────────────────────────────────────────────────
  //
  // Always drop in pairs (user + assistant) so conversation stays coherent.
  // Never drop the most recent turn.

  private _trimmedHistory(): Message[] {
    const max = this.config.maxHistory ?? 20;
    const h = this.session!.history;
    if (h.length <= max) return h;
    // Overflow rounded up to nearest even number (pairs)
    const overflow = h.length - max;
    const dropPairs = Math.ceil(overflow / 2) * 2;
    return h.slice(dropPairs);
  }
}
