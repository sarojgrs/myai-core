/**
 * 3-layer persistent memory system
 *
 * Layer 1 — Short-term (RAM)
 *   Current run only. Files touched, tools used THIS task.
 *   Cleared after each agent.run() completes.
 *
 * Layer 2 — Mid-term (.myai/session.json)
 *   Current work session. Last 20 tasks.
 *   "What I was just working on."
 *   Cleared when session ends (endSession()).
 *   Top entries promoted to long-term on session end.
 *
 * Layer 3 — Long-term (.myai/memory.json)
 *   Persistent across restarts. Top 100 important tasks.
 *   File associations, learned preferences.
 *   Keyword-scored recall.
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  timestamp: number;
  type: "task" | "preference" | "file-pattern" | "error-pattern";
  task: string;
  summary: string;
  filesChanged: string[];
  toolsUsed: string[];
  success: boolean;
  turnsUsed: number;
  tags: string[];
}

export interface UserPreference {
  key: string;
  value: string;
  learnedAt: number;
  source: string;
}

export interface FileAssociation {
  file: string;
  relatedFiles: string[];
  editCount: number;
  lastEdited: number;
}

// ── Layer stores ──────────────────────────────────────────────────────────────

export interface ShortTermMemory {
  files: Set<string>;
  tools: string[];
  startedAt: number;
}

export interface MidTermStore {
  sessionId: string;
  startedAt: number;
  entries: MemoryEntry[];
}

export interface LongTermStore {
  version: number;
  entries: MemoryEntry[];
  preferences: UserPreference[];
  fileAssociations: Record<string, FileAssociation>;
  stats: {
    totalTasks: number;
    successfulTasks: number;
    totalToolsUsed: number;
  };
}

// ── Config — now overridable per instance ─────────────────────────────────────

export interface MemoryConfig {
  midTermMaxEntries?: number;
  sessionFile?: string;
  longTermMaxEntries?: number;
  memoryFile?: string;
  recallTopK?: number;
  minRelevanceScore?: number;
  maxSummaryLength?: number;
  promotionMinTurns?: number;
  promotionRequireSuccess?: boolean;
  promotionMaxPerSession?: number;
  memoryDir?: string;
  saveDebouncMs?: number;
  recallCacheTtlMs?: number;
}

const DEFAULT_MEMORY_CONFIG = {
  midTermMaxEntries: 20,
  sessionFile: "session.json",
  longTermMaxEntries: 100,
  memoryFile: "memory.json",
  recallTopK: 5,
  minRelevanceScore: 0.2,
  maxSummaryLength: 300,
  promotionMinTurns: 2,
  promotionRequireSuccess: false,
  promotionMaxPerSession: 5,
  memoryDir: ".myai",
  saveDebouncMs: 500,
  recallCacheTtlMs: 30_000,
};

// ── MemoryEngine ──────────────────────────────────────────────────────────────

export class MemoryEngine {
  private workspaceRoot: string;
  private memoryDir: string;
  private cfg: Required<MemoryConfig>;

  // Layer 1 — RAM
  private shortTerm: ShortTermMemory = {
    files: new Set(),
    tools: [],
    startedAt: Date.now(),
  };

  // Layer 2 — session.json
  private midTerm: MidTermStore;

  // Layer 3 — memory.json
  private longTerm: LongTermStore;

  // Debounce timers — saves are async, never block event loop
  private _saveTimers: { mid?: NodeJS.Timeout; long?: NodeJS.Timeout } = {};

  // Recall cache — keyed by task string, TTL-invalidated and cleared on remember()
  private _recallCache = new Map<
    string,
    { entries: MemoryEntry[]; time: number }
  >();

  constructor(workspaceRoot: string, config?: MemoryConfig) {
    this.workspaceRoot = workspaceRoot;
    this.cfg = { ...DEFAULT_MEMORY_CONFIG, ...config };
    this.memoryDir = path.join(workspaceRoot, this.cfg.memoryDir);
    this.longTerm = this._loadLongTerm();
    this.midTerm = this._loadMidTerm();

    // register process signal handlers so debounced saves are not
    // lost when the process is killed with SIGTERM/SIGINT or exits unexpectedly.
    // endSession() calls _flushNow() for graceful shutdown — these handlers
    // cover the ungraceful cases. Handlers are stored for cleanup via dispose().
    this._boundFlush = () => this._flushNow();
    process.on("SIGTERM", this._boundFlush);
    process.on("SIGINT", this._boundFlush);
    process.on("exit", this._boundFlush);
  }

  // stored so dispose() can remove the handlers and avoid leaks
  // in long-lived processes that create/destroy multiple MemoryEngine instances.
  private _boundFlush: () => void;

  /**
   * Release resources: flush pending saves, remove process signal handlers.
   * Call this when the MemoryEngine instance is no longer needed (e.g. tests,
   * multi-tenant servers). Not needed for typical single-agent CLI usage.
   */
  dispose(): void {
    this._flushNow();
    process.off("SIGTERM", this._boundFlush);
    process.off("SIGINT", this._boundFlush);
    process.off("exit", this._boundFlush);
  }

  // ── Store a completed task ────────────────────────────────────────────────

  remember(entry: {
    task: string;
    summary: string;
    filesChanged: string[];
    toolsUsed: string[];
    success: boolean;
    turnsUsed: number;
  }): void {
    const tags = this._extractTags(entry.task + " " + entry.summary);

    const memEntry: MemoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      type: "task",
      task: entry.task.slice(0, 200),
      summary: entry.summary.slice(0, this.cfg.maxSummaryLength),
      filesChanged: entry.filesChanged,
      toolsUsed: entry.toolsUsed,
      success: entry.success,
      turnsUsed: entry.turnsUsed,
      tags,
    };

    // Layer 2
    this.midTerm.entries.unshift(memEntry);
    if (this.midTerm.entries.length > this.cfg.midTermMaxEntries) {
      this.midTerm.entries = this.midTerm.entries.slice(
        0,
        this.cfg.midTermMaxEntries,
      );
    }
    this._saveMidTerm();

    // Layer 3
    if (this._isImportant(memEntry)) {
      this.longTerm.entries.unshift(memEntry);
      if (this.longTerm.entries.length > this.cfg.longTermMaxEntries) {
        this.longTerm.entries = this.longTerm.entries.slice(
          0,
          this.cfg.longTermMaxEntries,
        );
      }
      this._updateFileAssociations(entry.filesChanged);
      this.longTerm.stats.totalTasks++;
      if (entry.success) this.longTerm.stats.successfulTasks++;
      this.longTerm.stats.totalToolsUsed += entry.toolsUsed.length;
      this._saveLongTerm();
    }

    // Layer 1
    entry.filesChanged.forEach((f) => this.shortTerm.files.add(f));
    this.shortTerm.tools.push(...entry.toolsUsed);

    // Invalidate recall cache — entries changed, scores are stale
    this._recallCache.clear();

    console.log(
      `[MemoryEngine] Stored: mid=${this.midTerm.entries.length} long=${this.longTerm.entries.length}`,
    );
  }

  // ── Build combined context from all 3 layers ──────────────────────────────

  buildMemoryContext(task: string): string {
    const parts: string[] = [];

    if (this.shortTerm.files.size > 0) {
      parts.push(
        `## Current run context:\n- Files touched: ${[...this.shortTerm.files].join(", ")}\n- Tools used: ${[...new Set(this.shortTerm.tools)].join(", ")}`,
      );
    }

    const recentTasks = this.midTerm.entries.slice(0, 5);
    if (recentTasks.length > 0) {
      const lines = recentTasks.map((e) => {
        const status = e.success ? "" : "";
        const files =
          e.filesChanged.length > 0
            ? ` | Files: ${e.filesChanged.join(", ")}`
            : "";
        return `${status} ${e.task} → ${e.summary}${files}`;
      });
      parts.push(`## Recent work this session:\n${lines.join("\n")}`);
    }

    const relevant = this._recallLongTerm(task);
    if (relevant.length > 0) {
      const lines = relevant.map((e) => {
        const date = new Date(e.timestamp).toLocaleDateString();
        const status = e.success ? "" : "";
        const files =
          e.filesChanged.length > 0
            ? `\n   Files: ${e.filesChanged.join(", ")}`
            : "";
        return `${status} [${date}] ${e.task}\n   → ${e.summary}${files}`;
      });
      parts.push(`## Relevant past tasks:\n${lines.join("\n")}`);
    }

    const fileHints = this._getFileHints(task);
    if (fileHints.length > 0) {
      const lines = fileHints.map(
        (h) => `- ${h.file} is often edited with: ${h.relatedFiles.join(", ")}`,
      );
      parts.push(`## File patterns:\n${lines.join("\n")}`);
    }

    const prefHints = this._getPreferenceHints(task);
    if (prefHints.length > 0) {
      const lines = prefHints.map((p) => `- ${p.key}: ${p.value}`);
      parts.push(`## Learned preferences:\n${lines.join("\n")}`);
    }

    return parts.join("\n\n");
  }

  // ── End session — promote mid-term → long-term, clear session ─────────────

  endSession(): void {
    // Prune old entries before promotion
    this._pruneLongTerm();
    const candidates = this.midTerm.entries.filter((e) => this._isImportant(e));

    const scored = candidates
      .map((e) => ({ e, score: (e.success ? 1 : 0) + e.turnsUsed * 0.1 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.cfg.promotionMaxPerSession);

    let promoted = 0;
    for (const { e } of scored) {
      const exists = this.longTerm.entries.some(
        (le) =>
          le.task === e.task && Math.abs(le.timestamp - e.timestamp) < 60000,
      );
      if (!exists) {
        this.longTerm.entries.unshift(e);
        promoted++;
      }
    }

    if (promoted > 0) {
      if (this.longTerm.entries.length > this.cfg.longTermMaxEntries) {
        this.longTerm.entries = this.longTerm.entries.slice(
          0,
          this.cfg.longTermMaxEntries,
        );
      }
      console.log(
        `[MemoryEngine] Session end: promoted ${promoted} entries to long-term`,
      );
    }

    this.midTerm = this._emptyMidTerm();
    this.clearRun();

    // Use _flushNow() — bypass debounce, write synchronously before process exit
    this._flushNow();

    console.log(
      `[MemoryEngine] Session ended. Long-term: ${this.longTerm.entries.length} entries`,
    );
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  recall(task: string, topK: number = this.cfg.recallTopK): MemoryEntry[] {
    return this._recallLongTerm(task, topK);
  }

  // ── Learn a preference ────────────────────────────────────────────────────

  learnPreference(key: string, value: string, source: string): void {
    const existing = this.longTerm.preferences.find((p) => p.key === key);
    if (existing) {
      existing.value = value;
      existing.learnedAt = Date.now();
      existing.source = source;
    } else {
      this.longTerm.preferences.push({
        key,
        value,
        learnedAt: Date.now(),
        source,
      });
    }
    this._saveLongTerm();
    console.log(`[MemoryEngine] Learned: ${key} = ${value}`);
  }

  // ── Short-term tracking ───────────────────────────────────────────────────

  trackFileTouched(filePath: string): void {
    this.shortTerm.files.add(filePath);
  }

  trackToolUsed(tool: string): void {
    this.shortTerm.tools.push(tool);
  }

  getSessionFiles(): string[] {
    return [...this.shortTerm.files];
  }

  clearRun(): void {
    this.shortTerm = { files: new Set(), tools: [], startedAt: Date.now() };
  }

  getEntries(layer: "mid" | "long" = "long", limit?: number): MemoryEntry[] {
    const entries =
      layer === "mid" ? this.midTerm.entries : this.longTerm.entries;
    return limit ? entries.slice(0, limit) : entries;
  }

  getPreferences(): UserPreference[] {
    return this.longTerm.preferences;
  }

  getFileAssociations(): Record<string, FileAssociation> {
    return this.longTerm.fileAssociations;
  }

  clear(type: "short" | "mid" | "long" | "all" = "all"): void {
    if (type === "short" || type === "all") this.clearRun();
    if (type === "mid" || type === "all") {
      this.midTerm = this._emptyMidTerm();
      this._saveMidTerm();
    }
    if (type === "long" || type === "all") {
      this.longTerm = this._emptyLongTerm();
      this._saveLongTerm();
    }
    console.log(`[MemoryEngine] Cleared: ${type}`);
  }

  async semanticRecall(_task: string, _topK = 5): Promise<MemoryEntry[]> {
    console.warn(
      "[MemoryEngine] semanticRecall is Phase B — using keyword recall.",
    );
    return this.recall(_task, _topK);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _isImportant(entry: MemoryEntry): boolean {
    return (
      entry.filesChanged.length > 0 &&
      entry.turnsUsed >= this.cfg.promotionMinTurns
    );
  }

  // Cached recall — scores computed once per task per TTL window
  private _recallLongTerm(
    task: string,
    topK = this.cfg.recallTopK,
  ): MemoryEntry[] {
    if (this.longTerm.entries.length === 0) return [];
    const queryTags = this._extractTags(task);
    if (queryTags.length === 0) return [];

    const cacheKey = `${task}:${topK}`;
    const cached = this._recallCache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cfg.recallCacheTtlMs) {
      return cached.entries;
    }

    const result = this.longTerm.entries
      .map((entry) => ({
        entry,
        score: this._relevanceScore(queryTags, entry),
      }))
      .filter((s) => s.score >= this.cfg.minRelevanceScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.entry);

    this._recallCache.set(cacheKey, { entries: result, time: Date.now() });
    return result;
  }

  private _loadLongTerm(): LongTermStore {
    const p = path.join(this.memoryDir, this.cfg.memoryFile);
    try {
      if (fs.existsSync(p)) {
        const store = JSON.parse(fs.readFileSync(p, "utf8")) as LongTermStore;
        console.log(
          `[MemoryEngine] Loaded long-term: ${store.entries.length} entries`,
        );
        return store;
      }
    } catch (err) {
      console.warn("[MemoryEngine] Failed to load long-term memory:", err);
    }
    return this._emptyLongTerm();
  }

  // Debounced — never blocks event loop on hot path
  private _saveLongTerm(): void {
    clearTimeout(this._saveTimers.long);
    this._saveTimers.long = setTimeout(() => {
      const p = path.join(this.memoryDir, this.cfg.memoryFile);
      try {
        if (!fs.existsSync(this.memoryDir))
          fs.mkdirSync(this.memoryDir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify(this.longTerm, null, 2), "utf8");
      } catch (err) {
        console.error("[MemoryEngine] Failed to save long-term:", err);
      }
    }, this.cfg.saveDebouncMs);
  }

  private _loadMidTerm(): MidTermStore {
    const p = path.join(this.memoryDir, this.cfg.sessionFile);
    try {
      if (fs.existsSync(p)) {
        const store = JSON.parse(fs.readFileSync(p, "utf8")) as MidTermStore;
        console.log(
          `[MemoryEngine] Loaded mid-term: ${store.entries.length} session entries`,
        );
        return store;
      }
    } catch (err) {
      console.warn("[MemoryEngine] Failed to load mid-term memory:", err);
    }
    return this._emptyMidTerm();
  }

  // Debounced — never blocks event loop on hot path
  private _saveMidTerm(): void {
    clearTimeout(this._saveTimers.mid);
    this._saveTimers.mid = setTimeout(() => {
      const p = path.join(this.memoryDir, this.cfg.sessionFile);
      try {
        if (!fs.existsSync(this.memoryDir))
          fs.mkdirSync(this.memoryDir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify(this.midTerm, null, 2), "utf8");
      } catch (err) {
        console.error("[MemoryEngine] Failed to save mid-term:", err);
      }
    }, this.cfg.saveDebouncMs);
  }

  // Synchronous flush for endSession() / process exit
  // Cancels any pending debounce timers and writes synchronously.
  private _flushNow(): void {
    clearTimeout(this._saveTimers.long);
    clearTimeout(this._saveTimers.mid);
    try {
      if (!fs.existsSync(this.memoryDir))
        fs.mkdirSync(this.memoryDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.memoryDir, this.cfg.memoryFile),
        JSON.stringify(this.longTerm, null, 2),
        "utf8",
      );
      fs.writeFileSync(
        path.join(this.memoryDir, this.cfg.sessionFile),
        JSON.stringify(this.midTerm, null, 2),
        "utf8",
      );
    } catch (err) {
      console.error("[MemoryEngine] Failed to flush on session end:", err);
    }
  }

  /**
   * Prune long-term memory:
   * - Remove entries older than 90 days
   * - Keep only maxEntries newest
   */
  private _pruneLongTerm(): void {
    const now = Date.now();
    const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

    // Remove old entries
    const beforeCount = this.longTerm.entries.length;
    this.longTerm.entries = this.longTerm.entries.filter(
      (e) => now - e.timestamp < MAX_AGE_MS,
    );
    const removedByAge = beforeCount - this.longTerm.entries.length;

    // Keep only maxEntries
    if (this.longTerm.entries.length > this.cfg.longTermMaxEntries) {
      const removed =
        this.longTerm.entries.length - this.cfg.longTermMaxEntries;
      this.longTerm.entries = this.longTerm.entries.slice(
        -this.cfg.longTermMaxEntries,
      );
      console.log(
        `[MemoryEngine] Pruned: ${removedByAge} by age, ${removed} by limit`,
      );
    } else if (removedByAge > 0) {
      console.log(`[MemoryEngine] Pruned ${removedByAge} old entries`);
    }
  }

  /**
   * Force pruning without ending session (for long-running agents)
   */
  pruneNow(): void {
    this._pruneLongTerm();
    this._flushNow();
  }

  /**
   * Get memory statistics
   */
  getStats() {
    return {
      shortTerm: {
        files: this.shortTerm.files.size,
        tools: this.shortTerm.tools.length,
      },
      midTerm: {
        entries: this.midTerm.entries.length,
        sessionId: this.midTerm.sessionId,
        startedAt: new Date(this.midTerm.startedAt).toLocaleString(),
      },
      longTerm: {
        ...this.longTerm.stats,
        totalEntries: this.longTerm.entries.length,
        totalPreferences: this.longTerm.preferences.length,
      },
    };
  }

  /**
   * Clear all memory layers (destructive!)
   */
  clearAll(): void {
    this.shortTerm = {
      files: new Set(),
      tools: [],
      startedAt: Date.now(),
    };
    this.midTerm = this._emptyMidTerm();
    this.longTerm = this._emptyLongTerm();
    this._recallCache.clear();
    this._flushNow();
    console.log("[MemoryEngine] All memory cleared");
  }

  private _emptyLongTerm(): LongTermStore {
    return {
      version: 1,
      entries: [],
      preferences: [],
      fileAssociations: {},
      stats: { totalTasks: 0, successfulTasks: 0, totalToolsUsed: 0 },
    };
  }

  private _emptyMidTerm(): MidTermStore {
    return {
      sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      startedAt: Date.now(),
      entries: [],
    };
  }

  private _extractTags(text: string): string[] {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "is",
      "it",
      "this",
      "that",
      "be",
      "was",
      "are",
      "were",
      "has",
      "have",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "can",
      "not",
      "no",
      "all",
      "any",
      "my",
      "your",
      "its",
      "our",
      "i",
      "you",
      "he",
      "she",
      "we",
      "they",
      "me",
      "him",
      "her",
      "us",
      "them",
    ]);
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s\/\.\-_]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
      .slice(0, 30);
  }

  private _relevanceScore(queryTags: string[], entry: MemoryEntry): number {
    if (queryTags.length === 0) return 0;
    const entryTags = new Set(entry.tags);
    const entryText = (entry.task + " " + entry.summary).toLowerCase();
    let score = 0;
    for (const tag of queryTags) {
      if (entryTags.has(tag)) score += 0.3;
      if (entryText.includes(tag)) score += 0.1;
    }
    for (const tag of queryTags) {
      if (entry.filesChanged.some((f) => f.toLowerCase().includes(tag)))
        score += 0.4;
    }
    const age = Date.now() - entry.timestamp;
    if (age < 7 * 24 * 60 * 60 * 1000) score += 0.1;
    if (entry.success) score += 0.05;
    return Math.min(score, 1.0);
  }

  private _updateFileAssociations(files: string[]): void {
    if (files.length === 0) return;
    for (const file of files) {
      if (!this.longTerm.fileAssociations[file]) {
        this.longTerm.fileAssociations[file] = {
          file,
          relatedFiles: [],
          editCount: 0,
          lastEdited: 0,
        };
      }
      this.longTerm.fileAssociations[file].editCount++;
      this.longTerm.fileAssociations[file].lastEdited = Date.now();
      const related = files.filter((f) => f !== file);
      for (const rel of related) {
        if (!this.longTerm.fileAssociations[file].relatedFiles.includes(rel)) {
          this.longTerm.fileAssociations[file].relatedFiles.push(rel);
        }
      }
    }
  }

  private _getFileHints(task: string): FileAssociation[] {
    const tags = this._extractTags(task);
    return Object.values(this.longTerm.fileAssociations)
      .filter(
        (fa) =>
          fa.relatedFiles.length > 0 &&
          tags.some((t) => fa.file.toLowerCase().includes(t)),
      )
      .slice(0, 3);
  }

  private _getPreferenceHints(task: string): UserPreference[] {
    const tags = this._extractTags(task);
    return this.longTerm.preferences
      .filter((p) =>
        tags.some(
          (t) =>
            p.key.toLowerCase().includes(t) ||
            p.value.toLowerCase().includes(t),
        ),
      )
      .slice(0, 3);
  }
}
