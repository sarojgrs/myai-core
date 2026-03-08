/**
 * CacheEngine — generic TTL-based key-value cache
 *
 * Domain-agnostic. Knows nothing about providers, tools, or agents.
 * Used by ContextEngine to cache provider outputs, but can be reused anywhere.
 *
 * Features:
 *   - Per-key TTL (0 = manual invalidate only, never auto-expires)
 *   - Manual invalidate by key
 *   - invalidateAll() for bulk clear
 *   - getCacheStats() for debugging and testing
 *   - Optional verbose logging
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CacheEntry<T = string> {
  value: T;
  timestamp: number;
  ttl: number; // ms. 0 = manual invalidate only
}

export interface CacheStats {
  valid: boolean;
  age: number; // ms since cached
  ttl: number; // 0 = manual only
}

export interface CacheEngineConfig {
  /** Log cache hits, misses, invalidations */
  verbose?: boolean;
  /** Prefix for log messages (default: "CacheEngine") */
  logPrefix?: string;
}

// ── CacheEngine ───────────────────────────────────────────────────────────────

export class CacheEngine<T = string> {
  private store = new Map<string, CacheEntry<T>>();
  private config: Required<CacheEngineConfig>;

  constructor(config: CacheEngineConfig = {}) {
    this.config = {
      verbose: false,
      logPrefix: "CacheEngine",
      ...config,
    };
  }

  /**
   * Store a value in cache with a TTL.
   * ttl = 0 → never auto-expires, manual invalidate only.
   */
  set(key: string, value: T, ttl: number = 0): void {
    this.store.set(key, { value, timestamp: Date.now(), ttl });
    if (this.config.verbose) {
      console.log(`[${this.config.logPrefix}] Stored: ${key} (ttl=${ttl}ms)`);
    }
  }

  /**
   * Get a cached value.
   * Returns undefined if key not found or entry is expired.
   * Automatically removes expired entries on access.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      if (this.config.verbose) {
        console.log(`[${this.config.logPrefix}] Miss: ${key}`);
      }
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.store.delete(key);
      if (this.config.verbose) {
        console.log(`[${this.config.logPrefix}] Expired: ${key}`);
      }
      return undefined;
    }

    if (this.config.verbose) {
      console.log(`[${this.config.logPrefix}] Hit: ${key}`);
    }
    return entry.value;
  }

  /**
   * Check if a key exists and is still valid (not expired).
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Invalidate a single key.
   * Safe to call even if key does not exist.
   */
  invalidate(key: string): void {
    if (this.store.has(key)) {
      this.store.delete(key);
      if (this.config.verbose) {
        console.log(`[${this.config.logPrefix}] Invalidated: ${key}`);
      }
    }
  }

  /**
   * Invalidate all cached entries.
   */
  invalidateAll(): void {
    const count = this.store.size;
    this.store.clear();
    if (this.config.verbose && count > 0) {
      console.log(
        `[${this.config.logPrefix}] All invalidated (${count} entries)`,
      );
    }
  }

  /**
   * Get all currently cached keys (valid only).
   */
  keys(): string[] {
    return [...this.store.keys()].filter((k) => this.has(k));
  }

  /**
   * Number of valid (non-expired) entries.
   */
  size(): number {
    return this.keys().length;
  }

  /**
   * Get cache stats for all stored entries (including expired).
   * Useful for debugging and tests.
   */
  getStats(): Record<string, CacheStats> {
    const now = Date.now();
    const stats: Record<string, CacheStats> = {};

    for (const [key, entry] of this.store.entries()) {
      stats[key] = {
        valid: !this.isExpired(entry),
        age: now - entry.timestamp,
        ttl: entry.ttl,
      };
    }

    return stats;
  }

  /**
   * Clear everything including expired entries.
   */
  clear(): void {
    this.store.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private isExpired(entry: CacheEntry<T>): boolean {
    if (entry.ttl === 0) return false; // manual invalidate only — never expires
    return Date.now() > entry.timestamp + entry.ttl;
  }
}
