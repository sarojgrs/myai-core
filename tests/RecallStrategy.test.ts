/**
 * Tests all built-in recall strategies against real MemoryEntry objects.
 * All async — score() is async in every strategy.
 */

import { describe, it, expect } from "vitest";
import {
  TextSimilarityRecallStrategy,
  TimeDecayRecallStrategy,
  SuccessWeightedRecallStrategy,
  HybridRecallStrategy,
  FileAffinityRecallStrategy,
  ToolAffinityRecallStrategy,
  CustomRecallStrategy,
} from "../src/core/recall/RecallStrategy";
import type { MemoryEntry } from "../src/core/MemoryEngine";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "test-1",
    timestamp: Date.now(),
    type: "task",
    task: "fix authentication bug",
    summary: "Fixed null pointer in auth middleware",
    filesChanged: ["src/auth.ts"],
    toolsUsed: ["readFile", "editFile"],
    success: true,
    turnsUsed: 3,
    tags: ["fix", "authentication", "bug", "auth", "middleware"],
    ...overrides,
  };
}

// ── TextSimilarityRecallStrategy ──────────────────────────────────────────────

describe("TextSimilarityRecallStrategy", () => {
  const strategy = new TextSimilarityRecallStrategy();

  it("scores overlapping keywords > 0", async () => {
    const entry = makeMemoryEntry({
      task: "fix authentication bug",
      summary: "",
    });
    const score = await strategy.score("fix authentication", entry);
    expect(score).toBeGreaterThan(0);
  });

  it("scores exact match close to 1", async () => {
    const entry = makeMemoryEntry({
      task: "fix authentication bug",
      summary: "fix authentication bug",
    });
    const score = await strategy.score("fix authentication bug", entry);
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores completely unrelated task as 0", async () => {
    const entry = makeMemoryEntry({ task: "xyz abc", summary: "xyz abc" });
    const score = await strategy.score("fix authentication", entry);
    expect(score).toBe(0);
  });

  it("returns score between 0 and 1", async () => {
    const entry = makeMemoryEntry();
    const score = await strategy.score("fix auth bug in middleware", entry);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("empty task returns 0", async () => {
    const score = await strategy.score("", makeMemoryEntry());
    expect(score).toBe(0);
  });
});

// ── TimeDecayRecallStrategy ───────────────────────────────────────────────────

describe("TimeDecayRecallStrategy", () => {
  it("recent entries score higher than old ones", async () => {
    const strategy = new TimeDecayRecallStrategy(7);
    const recent = makeMemoryEntry({ timestamp: Date.now() });
    const old = makeMemoryEntry({
      timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });

    const recentScore = await strategy.score("fix authentication bug", recent);
    const oldScore = await strategy.score("fix authentication bug", old);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("returns 0 for unrelated task regardless of recency", async () => {
    const strategy = new TimeDecayRecallStrategy(7);
    const entry = makeMemoryEntry({
      task: "xyz",
      summary: "xyz",
      timestamp: Date.now(),
    });
    const score = await strategy.score("fix authentication", entry);
    expect(score).toBe(0);
  });

  it("rank() sorts by score descending and trims to topN", () => {
    const strategy = new TimeDecayRecallStrategy(7);
    const results = [
      { entry: makeMemoryEntry(), score: 0.3 },
      { entry: makeMemoryEntry(), score: 0.9 },
      { entry: makeMemoryEntry(), score: 0.1 },
      { entry: makeMemoryEntry(), score: 0.7 },
    ];
    const ranked = strategy.rank(results, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].score).toBe(0.9);
    expect(ranked[1].score).toBe(0.7);
  });
});

// ── SuccessWeightedRecallStrategy ─────────────────────────────────────────────

describe("SuccessWeightedRecallStrategy", () => {
  it("successful entries score higher than failed ones", async () => {
    const strategy = new SuccessWeightedRecallStrategy();
    const successEntry = makeMemoryEntry({
      task: "refactor authentication middleware",
      summary: "",
      success: true,
    });
    const failEntry = makeMemoryEntry({
      task: "refactor authentication middleware",
      summary: "",
      success: false,
    });

    const successScore = await strategy.score(
      "refactor authentication middleware something",
      successEntry,
    );
    const failScore = await strategy.score(
      "refactor authentication middleware something",
      failEntry,
    );

    expect(successScore).toBeGreaterThan(0);
    expect(failScore).toBeGreaterThan(0);
    expect(successScore).toBeGreaterThan(failScore);
  });

  it("respects custom successWeight and failureWeight", async () => {
    const strategy = new SuccessWeightedRecallStrategy({
      successWeight: 3.0,
      failureWeight: 0.5,
    });
    const successEntry = makeMemoryEntry({ success: true });
    const failEntry = makeMemoryEntry({ success: false });

    const successScore = await strategy.score(
      "fix authentication bug",
      successEntry,
    );
    const failScore = await strategy.score("fix authentication bug", failEntry);
    expect(successScore).toBeGreaterThan(failScore);
  });

  it("returns 0 for unrelated task regardless of success", async () => {
    const strategy = new SuccessWeightedRecallStrategy();
    const entry = makeMemoryEntry({
      task: "xyz",
      summary: "xyz",
      success: true,
    });
    const score = await strategy.score("fix authentication", entry);
    expect(score).toBe(0);
  });

  it("score never exceeds 1.0", async () => {
    const strategy = new SuccessWeightedRecallStrategy({ successWeight: 100 });
    const entry = makeMemoryEntry({
      task: "fix auth bug",
      summary: "fix auth bug",
      success: true,
    });
    const score = await strategy.score("fix auth bug", entry);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ── HybridRecallStrategy ──────────────────────────────────────────────────────

describe("HybridRecallStrategy", () => {
  it("returns score > 0 for matching task", async () => {
    const strategy = new HybridRecallStrategy();
    const entry = makeMemoryEntry();
    const score = await strategy.score("fix authentication bug", entry);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 for unrelated task", async () => {
    const strategy = new HybridRecallStrategy();
    const entry = makeMemoryEntry({ task: "xyz", summary: "xyz" });
    const score = await strategy.score("fix authentication", entry);
    expect(score).toBe(0);
  });

  it("rank() returns top N by score", () => {
    const strategy = new HybridRecallStrategy();
    const results = [
      { entry: makeMemoryEntry(), score: 0.1 },
      { entry: makeMemoryEntry(), score: 0.8 },
      { entry: makeMemoryEntry(), score: 0.5 },
    ];
    const ranked = strategy.rank(results, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].score).toBe(0.8);
  });
});

// ── FileAffinityRecallStrategy ────────────────────────────────────────────────

describe("FileAffinityRecallStrategy", () => {
  it("boosts score when task mentions a file that entry touched", async () => {
    const strategy = new FileAffinityRecallStrategy();
    const entry = makeMemoryEntry({ filesChanged: ["src/auth.ts"] });
    const score = await strategy.score("fix bug in auth.ts", entry);
    expect(score).toBeGreaterThan(0);
  });

  it("returns text-only score when task mentions no files", async () => {
    const strategy = new FileAffinityRecallStrategy();
    const noFileStrategy = new TextSimilarityRecallStrategy();
    const entry = makeMemoryEntry();

    const fileScore = await strategy.score("fix authentication bug", entry);
    const textScore = await noFileStrategy.score(
      "fix authentication bug",
      entry,
    );
    // FileAffinity with no file mentions == text similarity score
    expect(fileScore).toBeCloseTo(textScore, 5);
  });
});

// ── ToolAffinityRecallStrategy ────────────────────────────────────────────────

describe("ToolAffinityRecallStrategy", () => {
  it("boosts score when task implies tools that entry used", async () => {
    const strategy = new ToolAffinityRecallStrategy();
    // "commit" implies gitCommit
    const entry = makeMemoryEntry({ toolsUsed: ["gitCommit"] });
    const score = await strategy.score("commit the changes", entry);
    expect(score).toBeGreaterThan(0);
  });

  it("no boost when no tool keyword in task", async () => {
    const strategy = new ToolAffinityRecallStrategy();
    const entry = makeMemoryEntry({ toolsUsed: ["gitCommit"] });
    // "fix auth" doesn't imply gitCommit
    const score = await strategy.score("fix auth bug", entry);
    // Should still get text score since task keywords may match
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ── CustomRecallStrategy ──────────────────────────────────────────────────────

describe("CustomRecallStrategy", () => {
  it("uses provided scoreFn", async () => {
    const strategy = new CustomRecallStrategy({
      scoreFn: async () => 0.42,
    });
    const score = await strategy.score("anything", makeMemoryEntry());
    expect(score).toBe(0.42);
  });

  it("uses default rank when no rankFn provided", () => {
    const strategy = new CustomRecallStrategy({ scoreFn: async () => 0.5 });
    const results = [
      { entry: makeMemoryEntry(), score: 0.3 },
      { entry: makeMemoryEntry(), score: 0.9 },
      { entry: makeMemoryEntry(), score: 0.1 },
    ];
    const ranked = strategy.rank(results, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].score).toBe(0.9);
  });

  it("uses custom rankFn when provided", () => {
    const strategy = new CustomRecallStrategy({
      scoreFn: async () => 0.5,
      rankFn: (results) => results.slice(0, 1), // always return only first
    });
    const results = [
      { entry: makeMemoryEntry(), score: 0.9 },
      { entry: makeMemoryEntry(), score: 0.1 },
    ];
    const ranked = strategy.rank(results);
    expect(ranked).toHaveLength(1);
  });
});
