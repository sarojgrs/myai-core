/**
 * Universal context orchestrator with per-provider caching
 *
 * ContextEngine is domain-agnostic. It knows nothing about VS Code,
 * files, databases, or any specific environment.
 *
 * It orchestrates ContextProviders — each provider knows its own domain.
 * Stack as many providers as needed. They are combined into one system prompt.
 *
 * Built-in providers (separate files):
 *   EditorContextProvider     → VS Code active file, cursor, tabs
 *   CLIContextProvider        → cwd, args, stdin
 *   FileSystemContextProvider → plain folder structure
 *   MemoryContextProvider     → past tasks, learned preferences
 *
 * Custom providers:
 *   class MyDBProvider implements ContextProvider {
 *     readonly name = "MyDBProvider";
 *     readonly invalidateOn = []; // TTL only — schema stable during run
 *     async buildContext(task) { return "DB schema: ..." }
 *   }
 *
 * Usage:
 *   const engine = new ContextEngine()
 *     .use(new FileSystemContextProvider(workspaceRoot), { cache: true, ttl: 0 })
 *     .use(new MemoryContextProvider(memoryEngine), { cache: true, ttl: 60_000 })
 *     .use(new EditorContextProvider(editor))  // no cache options = never cached
 *
 *   const systemPrompt = await engine.buildContext("fix the login bug")
 *
 *   // Invalidation is automatic — Executor calls notifyToolExecuted() after tools
 *   // Providers declare their own rules via invalidateOn
 */

import { hashKey } from "../utils/HashKey";
import { CacheEngine } from "./strategies/CacheStrategy";

// ── Config ────────────────────────────────────────────────────────────────────

export interface ContextEngineConfig {
  /** Throw on provider failure instead of silently continuing */
  strict?: boolean;
  /** Log provider errors, cache hits/misses to console */
  verbose?: boolean;
}

// ── Cache options — passed per provider at registration ──────────────────────

export interface ProviderCacheOptions {
  /** Enable caching for this provider (default: false) */
  cache?: boolean;
  /**
   * TTL in milliseconds.
   * 0 = manual invalidate only, never auto-expires (default: 0)
   * >0 = auto-expires after N ms
   */
  ttl?: number;
  /**
   * When true, the cache key includes a hash of the task string so
   * that providers whose output varies per-task (e.g. MemoryContextProvider)
   * do not serve results from a prior task.
   *
   * Set taskSensitive: true for any provider that uses the task argument in
   * buildContext(). Leave false (default) for providers whose output is
   * task-independent (e.g. FileSystemContextProvider).
   */
  taskSensitive?: boolean;
}

// ── ContextProvider interface — implement this for any domain ─────────────────

export interface ContextProvider {
  /** Unique name for this provider — used for logging and deduplication */
  readonly name: string;

  /**
   * Build context string for the given task.
   * Return empty string if no relevant context available.
   */
  buildContext(task: string): Promise<string>;

  /**
   * Optional. Tool names that should invalidate this provider's cache.
   * ContextEngine calls notifyToolExecuted() after every successful tool.
   * Provider declares its own rules — Executor knows nothing about context.
   *
   * Examples:
   *   invalidateOn = ["createFile", "editFile"]  // filesystem provider
   *   invalidateOn = ["gitCommit"]               // git-based provider
   *   invalidateOn = []                          // TTL only, no tool triggers
   *   // omit entirely                           // never invalidated by tools
   */
  readonly invalidateOn?: string[];
}

// ── Internal — provider + cache options pair ──────────────────────────────────

interface ProviderEntry {
  provider: ContextProvider;
  cacheOptions: Required<ProviderCacheOptions>;
}

// ── ContextEngine — orchestrates all providers ────────────────────────────────

export class ContextEngine {
  private providers: ProviderEntry[] = [];
  private config: ContextEngineConfig;
  private cache: CacheEngine<string>;

  constructor(config: ContextEngineConfig = {}) {
    this.config = { strict: false, verbose: false, ...config };
    this.cache = new CacheEngine<string>({
      verbose: config.verbose,
      logPrefix: "ContextEngine",
    });
  }

  /**
   * Register a context provider with optional cache settings.
   * Providers are called in registration order.
   * Returns `this` for chaining.
   *
   * Throws if a provider with the same name is already registered,
   * preventing silent cache-slot collisions.
   *
   * Warns when invalidateOn is an empty array — this is almost
   * always a mistake (the dev likely meant to omit it entirely, which means
   * "never invalidated by tools"). An empty array is identical in behaviour
   * to omitting the field but is confusing to readers.
   *
   * Examples:
   *   engine.use(new FileSystemContextProvider(root), { cache: true, ttl: 0 })
   *   engine.use(new MemoryContextProvider(mem), { cache: true, ttl: 60_000 })
   *   engine.use(new EditorContextProvider(editor))  // cache: false by default
   */
  use(provider: ContextProvider, cacheOptions?: ProviderCacheOptions): this {
    // reject duplicate names — two providers sharing a name would
    // silently share one cache slot and corrupt each other's data.
    if (this.has(provider.name)) {
      throw new Error(
        `ContextEngine: provider "${provider.name}" is already registered. ` +
          `Use a unique name or call remove("${provider.name}") first.`,
      );
    }

    // empty invalidateOn array is almost always a mistake.
    // Omitting the field entirely is the correct way to say "never invalidated by tools".
    if (
      Array.isArray(provider.invalidateOn) &&
      provider.invalidateOn.length === 0
    ) {
      console.warn(
        `[ContextEngine] Provider "${provider.name}" has invalidateOn=[]. ` +
          `An empty array means "never invalidated by tools" — the same as omitting the field. ` +
          `If you want tool-triggered invalidation, list the tool names explicitly.`,
      );
    }

    this.providers.push({
      provider,
      cacheOptions: {
        cache: cacheOptions?.cache ?? false,
        ttl: cacheOptions?.ttl ?? 0,
        taskSensitive: cacheOptions?.taskSensitive ?? false,
      },
    });
    return this;
  }

  /**
   * Remove a provider by name.
   * Also clears its cache entry.
   */
  remove(name: string): this {
    this.providers = this.providers.filter((e) => e.provider.name !== name);
    this.cache.invalidate(name);
    return this;
  }

  /**
   * Replace a provider by name, preserving its cache options.
   * If provider not found, appends it with default cache options.
   */
  replace(name: string, provider: ContextProvider): this {
    const idx = this.providers.findIndex((e) => e.provider.name === name);
    if (idx >= 0) {
      this.providers[idx].provider = provider;
      this.cache.invalidate(name); // clear stale cache for replaced provider
    } else {
      this.providers.push({
        provider,
        cacheOptions: { cache: false, ttl: 0, taskSensitive: false },
      });
    }
    return this;
  }

  /**
   * Check if a provider is registered.
   */
  has(name: string): boolean {
    return this.providers.some((e) => e.provider.name === name);
  }

  /**
   * Get all registered provider names.
   */
  list(): string[] {
    return this.providers.map((e) => e.provider.name);
  }

  /**
   * Notify the engine that a tool was executed successfully.
   * Checks all providers — if the tool name is in a provider's invalidateOn
   * list, that provider's cache is cleared automatically.
   * Also calls provider.invalidateCache() if the provider has its own
   * internal cache (e.g. FileSystemContextProvider).
   *
   * Called by Executor via cfg.onToolExecuted — Executor knows nothing
   * about which providers exist or what they cache.
   */
  notifyToolExecuted(toolName: string): void {
    for (const { provider } of this.providers) {
      if (provider.invalidateOn?.includes(toolName)) {
        this.cache.invalidate(provider.name);
        // Also clear provider's own internal cache if it has one
        (provider as any).invalidateCache?.("all");
      }
    }
  }

  /**
   * Invalidate cache for a specific provider by name.
   */
  invalidate(name: string): void {
    this.cache.invalidate(name);
  }

  /**
   * Invalidate all provider caches.
   * Call between pipeline steps or at the start of a new run.
   */
  invalidateAll(): void {
    this.cache.invalidateAll();
    // Also clear internal caches on all providers
    for (const { provider } of this.providers) {
      (provider as any).invalidateCache?.("all");
    }
  }

  /**
   * Get cache stats for all providers — useful for debugging and tests.
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Build the combined context string from all providers.
   * Each provider's output is separated by a blank line.
   * Empty outputs are filtered out.
   *
   * Cache behaviour per provider:
   *   cache: false (default) → always calls provider fresh
   *   cache: true, ttl: 0   → cached until explicitly invalidated
   *   cache: true, ttl: N   → cached for N ms then auto-expires
   *
   * When taskSensitive: true the cache key includes a hash of the
   * task string, so providers like MemoryContextProvider never serve results
   * from a different task.
   */
  async buildContext(task: string = ""): Promise<string> {
    const results = await Promise.allSettled(
      this.providers.map(async ({ provider, cacheOptions }) => {
        const { cache: cacheEnabled, ttl, taskSensitive } = cacheOptions;

        // include task hash in key for task-sensitive providers
        const cacheKey =
          cacheEnabled && taskSensitive
            ? `${provider.name}:${hashKey(task)}`
            : provider.name;

        // Try cache first if enabled for this provider
        if (cacheEnabled) {
          const cached = this.cache.get(cacheKey);
          if (cached !== undefined) {
            return cached; // cache hit
          }
        }

        // Cache miss or disabled — call provider
        try {
          const ctx = await provider.buildContext(task);
          if (typeof ctx !== "string") {
            throw new Error("Provider must return string");
          }
          const trimmed = ctx.trim();

          // Store in cache if enabled
          if (cacheEnabled) {
            this.cache.set(cacheKey, trimmed, ttl);
          }

          return trimmed;
        } catch (err: any) {
          const msg = `[ContextEngine] Provider "${provider.name}" failed: ${err.message}`;

          if (this.config.strict) {
            throw new Error(msg);
          }

          if (this.config.verbose) {
            console.warn(msg);
          }

          return "";
        }
      }),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0 && this.config.strict) {
      throw new Error(`${failed.length} provider(s) failed in strict mode`);
    }

    return results
      .filter(
        (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
      )
      .map((r) => r.value)
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Clear all providers and their caches.
   */
  clear(): this {
    this.providers = [];
    this.cache.clear();
    return this;
  }
}
