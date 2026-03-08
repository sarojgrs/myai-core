/**
 * Pluggable memory recall strategies
 *
 * Strategies for scoring how relevant past tasks are to the current task.
 * Built-in: TextSimilarity, TimeDecay, SuccessWeighted, Hybrid
 *
 * Usage:
 *   const memory = new MemoryEngine(
 *     "/workspace",
 *     new TimeDecayRecallStrategy(14), // Memories decay over 2 weeks
 *   );
 */

import type { MemoryEntry } from "../MemoryEngine";

// ── Recall result with scoring ────────────────────────────────────────────────

export interface RecallResult {
  /** The memory entry */
  entry: MemoryEntry;
  /** Relevance score (0..1) */
  score: number;
  /** Optional reason for this score */
  reason?: string;
}

// ── RecallStrategy interface ──────────────────────────────────────────────────

/**
 * Pluggable strategy for scoring memory entries against current task.
 *
 * Score 0 = completely irrelevant
 * Score 1 = perfect match
 * Scores between 0 and 1 indicate partial relevance
 */
export interface RecallStrategy {
  /**
   * Score an entry against current task.
   * Return 0 to exclude from results.
   */
  score(currentTask: string, entry: MemoryEntry): Promise<number>;

  /**
   * Optional: rank and filter results.
   * Called after all entries are scored.
   * Default: sorts by score descending, returns top N.
   */
  rank?(results: RecallResult[], topN?: number): RecallResult[];
}

// ── Built-in: TextSimilarityRecallStrategy ────────────────────────────────────

/**
 * Simple keyword-based similarity.
 * Matches words in the current task against past task descriptions.
 * Fast, no external dependencies, works well for exact term overlap.
 *
 * Example: "fix auth bug" matches past "fix authentication bugs" well.
 * Does NOT match conceptually similar tasks (e.g., "fix login" vs "debug auth").
 */
export class TextSimilarityRecallStrategy implements RecallStrategy {
  async score(currentTask: string, entry: MemoryEntry): Promise<number> {
    const taskWords = this._getKeywords(currentTask);
    const entryText = `${entry.task} ${entry.summary}`.toLowerCase();

    if (taskWords.length === 0) return 0;

    let matches = 0;
    for (const word of taskWords) {
      // Count exact matches and partial matches
      if (entryText.includes(word)) matches++;
    }

    return Math.min(matches / taskWords.length, 1.0);
  }

  private _getKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
  }
}

// ── Built-in: TimeDecayRecallStrategy ─────────────────────────────────────────

/**
 * Text similarity + time decay.
 * Recent memories are weighted more heavily than old ones.
 * Useful when you want to learn from recent work first.
 *
 * Example: with halfLifeDays=7, memories older than 1 week lose 50% score.
 * After 2 weeks, they lose 75% score.
 *
 * Formula: score * 2^(-age_days / halfLifeDays)
 */
export class TimeDecayRecallStrategy implements RecallStrategy {
  private textSim = new TextSimilarityRecallStrategy();
  private halfLifeDays: number;

  constructor(halfLifeDays: number = 7) {
    this.halfLifeDays = halfLifeDays;
  }

  async score(currentTask: string, entry: MemoryEntry): Promise<number> {
    const textScore = await this.textSim.score(currentTask, entry);
    if (textScore === 0) return 0;

    // Apply time decay
    const ageMs = Date.now() - entry.timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const decayFactor = Math.pow(0.5, ageDays / this.halfLifeDays);

    return textScore * decayFactor;
  }

  rank(results: RecallResult[], topN: number = 5): RecallResult[] {
    return results.sort((a, b) => b.score - a.score).slice(0, topN);
  }
}

// ── Built-in: SuccessWeightedRecallStrategy ───────────────────────────────────

/**
 * Text similarity weighted by success.
 * Successful tasks are weighted 2x more than failed tasks.
 * Useful when you want to learn from what worked, not what failed.
 *
 * Example: "fix login bug" (successful) scores higher than
 * "attempted auth refactor" (unsuccessful).
 */
export class SuccessWeightedRecallStrategy implements RecallStrategy {
  private textSim = new TextSimilarityRecallStrategy();
  private successWeight: number = 2.0;
  private failureWeight: number = 1.0;

  constructor(
    options: { successWeight?: number; failureWeight?: number } = {},
  ) {
    this.successWeight = options.successWeight ?? 2.0;
    this.failureWeight = options.failureWeight ?? 1.0;
  }

  async score(currentTask: string, entry: MemoryEntry): Promise<number> {
    const textScore = await this.textSim.score(currentTask, entry);
    if (textScore === 0) return 0;

    // Apply success weighting
    const weight = entry.success ? this.successWeight : this.failureWeight;
    return Math.min(textScore * weight, 1.0);
  }
}

// ── Built-in: HybridRecallStrategy ────────────────────────────────────────────

/**
 * Combines multiple scoring factors:
 *   - 50% text similarity
 *   - 30% time decay (recent memories weighted higher)
 *   - 20% success (successful tasks weighted higher)
 *
 * Best general-purpose strategy. Balances relevance, recency, and quality.
 */
export class HybridRecallStrategy implements RecallStrategy {
  private textSim = new TextSimilarityRecallStrategy();
  private timeSim = new TimeDecayRecallStrategy(7);
  private successSim = new SuccessWeightedRecallStrategy();

  constructor(options: { halfLifeDays?: number } = {}) {
    this.timeSim = new TimeDecayRecallStrategy(options.halfLifeDays ?? 7);
  }

  async score(currentTask: string, entry: MemoryEntry): Promise<number> {
    const textScore = await this.textSim.score(currentTask, entry);
    if (textScore === 0) return 0;

    const timeScore = await this.timeSim.score(currentTask, entry);
    const successScore = await this.successSim.score(currentTask, entry);

    // Weighted average: 50% text, 30% time, 20% success
    return textScore * 0.5 + timeScore * 0.3 + successScore * 0.2;
  }

  rank(results: RecallResult[], topN: number = 5): RecallResult[] {
    return results.sort((a, b) => b.score - a.score).slice(0, topN);
  }
}

// ── Built-in: FileAffinity RecallStrategy ────────────────────────────────────

/**
 * Score based on file overlap.
 * Tasks that touched the same files are considered more relevant.
 * Useful when you want to leverage work on related files.
 *
 * Example: working on "LoginForm.tsx"? Recall past tasks that also edited LoginForm.tsx.
 */
export class FileAffinityRecallStrategy implements RecallStrategy {
  private textSim = new TextSimilarityRecallStrategy();

  async score(currentTask: string, entry: MemoryEntry): Promise<number> {
    const textScore = await this.textSim.score(currentTask, entry);

    // Extract file paths from current task (very heuristic)
    const taskFiles = this._extractFilesFromTask(currentTask);
    if (taskFiles.length === 0) return textScore;

    // Check overlap with entry's files
    let fileMatches = 0;
    for (const taskFile of taskFiles) {
      if (
        entry.filesChanged.some((f) =>
          f.toLowerCase().includes(taskFile.toLowerCase()),
        )
      ) {
        fileMatches++;
      }
    }

    // Boost score if files overlap
    const fileBoost = (fileMatches / taskFiles.length) * 0.5; // Max +0.5
    return Math.min(textScore + fileBoost, 1.0);
  }

  private _extractFilesFromTask(task: string): string[] {
    // Very simple: look for .ts, .tsx, .js patterns
    const filePattern = /\b[\w\/-]+\.(?:tsx?|jsx?|py|go|rs|java|cs)\b/gi;
    const matches = task.match(filePattern) ?? [];
    return Array.from(new Set(matches.map((m) => m.toLowerCase())));
  }
}

// ── Built-in: ToolAffinityRecallStrategy ──────────────────────────────────────

/**
 * Score based on tools used.
 * Tasks that used the same tools are considered more relevant.
 * Useful when you want to reuse patterns from similar operations.
 *
 * Example: if current task mentions "commit", recall past tasks that used gitCommit.
 */
export class ToolAffinityRecallStrategy implements RecallStrategy {
  private textSim = new TextSimilarityRecallStrategy();
  private toolKeywords = new Map<string, string[]>([
    ["readFile", ["read", "view", "show", "cat", "content"]],
    ["editFile", ["edit", "modify", "change", "update", "fix"]],
    ["createFile", ["create", "new", "add", "make"]],
    ["runCommand", ["run", "execute", "build", "test", "npm", "yarn"]],
    ["gitCommit", ["commit", "push", "git", "merge", "release"]],
    ["gitPush", ["push", "deploy", "publish"]],
  ]);

  async score(currentTask: string, entry: MemoryEntry): Promise<number> {
    const textScore = await this.textSim.score(currentTask, entry);

    // Infer tools from task description
    const taskTools = this._inferToolsFromTask(currentTask);
    if (taskTools.length === 0) return textScore;

    // Check overlap with entry's tools
    let toolMatches = 0;
    for (const tool of taskTools) {
      if (entry.toolsUsed.includes(tool)) toolMatches++;
    }

    // Boost score if tools overlap
    const toolBoost = (toolMatches / taskTools.length) * 0.4; // Max +0.4
    return Math.min(textScore + toolBoost, 1.0);
  }

  private _inferToolsFromTask(task: string): string[] {
    const taskLower = task.toLowerCase();
    const tools: string[] = [];

    for (const [tool, keywords] of this.toolKeywords.entries()) {
      if (keywords.some((kw) => taskLower.includes(kw))) {
        tools.push(tool);
      }
    }

    return tools;
  }
}

// ── Built-in: CustomRecallStrategy ────────────────────────────────────────────

/**
 * Flexible strategy that accepts a custom scoring function.
 *
 * Example:
 *   new CustomRecallStrategy((task, entry) => {
 *     // Custom logic: score based on tags, domain, etc.
 *     return 0.8;
 *   })
 */
export class CustomRecallStrategy implements RecallStrategy {
  private scoreFn: (task: string, entry: MemoryEntry) => Promise<number>;
  private rankFn?: (results: RecallResult[], topN?: number) => RecallResult[];

  constructor(options: {
    scoreFn: (task: string, entry: MemoryEntry) => Promise<number>;
    rankFn?: (results: RecallResult[], topN?: number) => RecallResult[];
  }) {
    this.scoreFn = options.scoreFn;
    this.rankFn = options.rankFn;
  }

  async score(currentTask: string, entry: MemoryEntry): Promise<number> {
    return this.scoreFn(currentTask, entry);
  }

  rank(results: RecallResult[], topN: number = 5): RecallResult[] {
    if (this.rankFn) {
      return this.rankFn(results, topN);
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topN);
  }
}
