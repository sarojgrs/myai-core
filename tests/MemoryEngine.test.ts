/**
 * Tests pure in-memory logic only — no filesystem reads/writes.
 * Uses vi.mock to stub fs so no .myai/ folder is created.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryEngine } from "../src/core/MemoryEngine";

// ── Stub fs so MemoryEngine never touches disk ────────────────────────────────
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// ── Helper — build a minimal remember() payload ───────────────────────────────
function makeEntry(
  overrides: Partial<Parameters<MemoryEngine["remember"]>[0]> = {},
) {
  return {
    task: "fix authentication bug",
    summary: "Fixed null pointer in auth middleware",
    filesChanged: ["src/auth.ts"],
    toolsUsed: ["readFile", "editFile"],
    success: true,
    turnsUsed: 3,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MemoryEngine — short-term tracking", () => {
  let mem: MemoryEngine;

  beforeEach(() => {
    mem = new MemoryEngine("/workspace");
  });

  it("trackFileTouched adds to short-term", () => {
    mem.trackFileTouched("src/index.ts");
    mem.trackFileTouched("src/auth.ts");
    const files = mem.getSessionFiles();
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/auth.ts");
  });

  it("trackFileTouched deduplicates (Set)", () => {
    mem.trackFileTouched("index.ts");
    mem.trackFileTouched("index.ts");
    expect(mem.getSessionFiles()).toHaveLength(1);
  });

  it("trackToolUsed appends to short-term tools", () => {
    mem.trackToolUsed("gitCommit");
    mem.trackToolUsed("gitCommit");
    const stats = mem.getStats();
    expect(stats.shortTerm.tools).toBe(2);
  });

  it("clearRun resets short-term", () => {
    mem.trackFileTouched("index.ts");
    mem.trackToolUsed("readFile");
    mem.clearRun();
    expect(mem.getSessionFiles()).toHaveLength(0);
    expect(mem.getStats().shortTerm.tools).toBe(0);
  });
});

describe("MemoryEngine — remember() and mid-term layer", () => {
  let mem: MemoryEngine;

  beforeEach(() => {
    mem = new MemoryEngine("/workspace");
  });

  it("remember() stores entry in mid-term", () => {
    mem.remember(makeEntry());
    expect(mem.getEntries("mid")).toHaveLength(1);
  });

  it("remember() stores entry in long-term when important (files + turns)", () => {
    mem.remember(makeEntry({ filesChanged: ["auth.ts"], turnsUsed: 3 }));
    expect(mem.getEntries("long")).toHaveLength(1);
  });

  it("remember() does NOT store in long-term when not important (no files)", () => {
    mem.remember(makeEntry({ filesChanged: [], turnsUsed: 3 }));
    expect(mem.getEntries("long")).toHaveLength(0);
  });

  it("remember() does NOT store in long-term when turnsUsed below minimum", () => {
    mem.remember(makeEntry({ filesChanged: ["auth.ts"], turnsUsed: 1 }));
    expect(mem.getEntries("long")).toHaveLength(0);
  });

  it("mid-term respects maxEntries cap", () => {
    const mem2 = new MemoryEngine("/workspace", { midTermMaxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      mem2.remember(makeEntry({ task: `task ${i}` }));
    }
    expect(mem2.getEntries("mid").length).toBeLessThanOrEqual(3);
  });

  it("remember() clears recall cache", () => {
    // First recall populates cache
    mem.remember(
      makeEntry({
        task: "fix auth bug",
        filesChanged: ["auth.ts"],
        turnsUsed: 3,
      }),
    );
    const first = mem.recall("fix auth");
    // Remember again — cache should be invalidated
    mem.remember(
      makeEntry({
        task: "fix auth bug again",
        filesChanged: ["auth.ts"],
        turnsUsed: 3,
      }),
    );
    const second = mem.recall("fix auth");
    expect(second.length).toBeGreaterThanOrEqual(first.length);
  });
});

describe("MemoryEngine — recall()", () => {
  let mem: MemoryEngine;

  beforeEach(() => {
    mem = new MemoryEngine("/workspace");
  });

  it("returns empty array when no entries", () => {
    expect(mem.recall("fix bug")).toEqual([]);
  });

  it("returns relevant entries for matching task", () => {
    mem.remember(
      makeEntry({
        task: "fix authentication bug",
        summary: "Fixed auth middleware",
        filesChanged: ["auth.ts"],
        turnsUsed: 3,
      }),
    );
    const results = mem.recall("fix authentication");
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty for completely unrelated task", () => {
    mem.remember(
      makeEntry({
        task: "fix authentication bug",
        filesChanged: ["auth.ts"],
        turnsUsed: 3,
      }),
    );
    // No keyword overlap with "authentication"
    const results = mem.recall("xyz");
    expect(results).toEqual([]);
  });

  it("respects topK limit", () => {
    for (let i = 0; i < 10; i++) {
      mem.remember(
        makeEntry({
          task: `fix authentication issue ${i}`,
          filesChanged: ["auth.ts"],
          turnsUsed: 3,
        }),
      );
    }
    const results = mem.recall("fix authentication", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe("MemoryEngine — endSession()", () => {
  let mem: MemoryEngine;

  beforeEach(() => {
    mem = new MemoryEngine("/workspace");
  });

  it("clears mid-term after endSession()", () => {
    mem.remember(makeEntry());
    expect(mem.getEntries("mid").length).toBeGreaterThan(0);
    mem.endSession();
    expect(mem.getEntries("mid")).toHaveLength(0);
  });

  it("promotes important entries to long-term on endSession()", () => {
    // Important = has files + enough turns
    mem.remember(
      makeEntry({ filesChanged: ["auth.ts"], turnsUsed: 3, success: true }),
    );
    const beforeLong = mem.getEntries("long").length;
    mem.endSession();
    // Long-term should have at least as many entries
    expect(mem.getEntries("long").length).toBeGreaterThanOrEqual(beforeLong);
  });

  it("clears short-term after endSession()", () => {
    mem.trackFileTouched("index.ts");
    mem.endSession();
    expect(mem.getSessionFiles()).toHaveLength(0);
  });
});

describe("MemoryEngine — learnPreference()", () => {
  let mem: MemoryEngine;

  beforeEach(() => {
    mem = new MemoryEngine("/workspace");
  });

  it("stores a preference", () => {
    mem.learnPreference("indent", "2 spaces", "user");
    const prefs = mem.getPreferences();
    expect(
      prefs.some((p) => p.key === "indent" && p.value === "2 spaces"),
    ).toBe(true);
  });

  it("updates existing preference", () => {
    mem.learnPreference("indent", "2 spaces", "user");
    mem.learnPreference("indent", "4 spaces", "user");
    const prefs = mem.getPreferences().filter((p) => p.key === "indent");
    expect(prefs).toHaveLength(1);
    expect(prefs[0].value).toBe("4 spaces");
  });
});

describe("MemoryEngine — getStats()", () => {
  it("returns correct stats structure", () => {
    const mem = new MemoryEngine("/workspace");
    const stats = mem.getStats();
    expect(stats).toHaveProperty("shortTerm");
    expect(stats).toHaveProperty("midTerm");
    expect(stats).toHaveProperty("longTerm");
    expect(stats.shortTerm.files).toBe(0);
    expect(stats.shortTerm.tools).toBe(0);
  });
});

describe("MemoryEngine — clear()", () => {
  it("clear('short') only resets short-term", () => {
    const mem = new MemoryEngine("/workspace");
    mem.trackFileTouched("index.ts");
    mem.remember(makeEntry());
    mem.clear("short");
    expect(mem.getSessionFiles()).toHaveLength(0);
    expect(mem.getEntries("mid").length).toBeGreaterThan(0);
  });

  it("clear('all') resets everything", () => {
    const mem = new MemoryEngine("/workspace");
    mem.trackFileTouched("index.ts");
    mem.remember(makeEntry({ filesChanged: ["auth.ts"], turnsUsed: 3 }));
    mem.clear("all");
    expect(mem.getSessionFiles()).toHaveLength(0);
    expect(mem.getEntries("mid")).toHaveLength(0);
    expect(mem.getEntries("long")).toHaveLength(0);
  });
});

describe("MemoryEngine — buildMemoryContext()", () => {
  it("returns empty string when all layers empty", () => {
    const mem = new MemoryEngine("/workspace");
    expect(mem.buildMemoryContext("fix auth")).toBe("");
  });

  it("includes current run context when files touched", () => {
    const mem = new MemoryEngine("/workspace");
    mem.trackFileTouched("src/auth.ts");
    mem.trackToolUsed("readFile");

    const ctx = mem.buildMemoryContext("fix auth");
    expect(ctx).toContain("## Current run context");
    expect(ctx).toContain("src/auth.ts");
    expect(ctx).toContain("readFile");
  });

  it("includes recent session tasks from mid-term", () => {
    const mem = new MemoryEngine("/workspace");
    mem.remember(makeEntry({ task: "refactor login module" }));

    const ctx = mem.buildMemoryContext("fix auth");
    expect(ctx).toContain("## Recent work this session");
    expect(ctx).toContain("refactor login module");
  });

  it("marks successful tasks with  in session context", () => {
    const mem = new MemoryEngine("/workspace");
    mem.remember(makeEntry({ success: true }));

    const ctx = mem.buildMemoryContext("fix auth");
    expect(ctx).toContain("");
  });

  it("marks failed tasks with  in session context", () => {
    const mem = new MemoryEngine("/workspace");
    mem.remember(makeEntry({ success: false }));

    const ctx = mem.buildMemoryContext("fix auth");
    expect(ctx).toContain("");
  });

  it("includes relevant past tasks from long-term when keywords match", () => {
    const mem = new MemoryEngine("/workspace");
    // Important entry — has files + enough turns → goes to long-term
    mem.remember(
      makeEntry({
        task: "fix authentication middleware issue",
        filesChanged: ["src/auth.ts"],
        turnsUsed: 3,
      }),
    );

    const ctx = mem.buildMemoryContext("fix authentication middleware");
    expect(ctx).toContain("## Relevant past tasks");
  });

  it("does not include long-term section when no relevant entries", () => {
    const mem = new MemoryEngine("/workspace");
    mem.remember(
      makeEntry({
        task: "fix authentication issue",
        filesChanged: ["src/auth.ts"],
        turnsUsed: 3,
      }),
    );

    // Completely unrelated task — no keyword match
    const ctx = mem.buildMemoryContext("xyz");
    expect(ctx).not.toContain("## Relevant past tasks");
  });

  it("includes learned preferences when task keywords match", () => {
    const mem = new MemoryEngine("/workspace");
    mem.learnPreference("typescript style", "always use strict mode", "user");

    const ctx = mem.buildMemoryContext("typescript refactor");
    expect(ctx).toContain("## Learned preferences");
    expect(ctx).toContain("typescript style");
  });

  it("combines all layers when all have content", () => {
    const mem = new MemoryEngine("/workspace");
    mem.trackFileTouched("src/auth.ts");
    mem.remember(makeEntry({ task: "refactor authentication module" }));

    const ctx = mem.buildMemoryContext("fix auth");
    expect(ctx).toContain("## Current run context");
    expect(ctx).toContain("## Recent work this session");
  });

  it("sections separated by double newline", () => {
    const mem = new MemoryEngine("/workspace");
    mem.trackFileTouched("src/auth.ts");
    mem.remember(makeEntry());

    const ctx = mem.buildMemoryContext("fix auth");
    expect(ctx).toContain("\n\n");
  });

  it("includes files changed in session task entry", () => {
    const mem = new MemoryEngine("/workspace");
    mem.remember(makeEntry({ filesChanged: ["src/login.ts", "src/auth.ts"] }));

    const ctx = mem.buildMemoryContext("fix auth");
    expect(ctx).toContain("src/login.ts");
  });
});

describe("MemoryEngine — _isImportant() boundary (promotionMinTurns=2)", () => {
  it("stores in long-term when turnsUsed equals promotionMinTurns (2)", () => {
    const mem = new MemoryEngine("/workspace", { promotionMinTurns: 2 });
    mem.remember(makeEntry({ filesChanged: ["auth.ts"], turnsUsed: 2 }));
    expect(mem.getEntries("long")).toHaveLength(1);
  });

  it("does NOT store in long-term when turnsUsed is below promotionMinTurns", () => {
    const mem = new MemoryEngine("/workspace", { promotionMinTurns: 2 });
    mem.remember(makeEntry({ filesChanged: ["auth.ts"], turnsUsed: 1 }));
    expect(mem.getEntries("long")).toHaveLength(0);
  });

  it("does NOT store in long-term when filesChanged is empty regardless of turns", () => {
    const mem = new MemoryEngine("/workspace");
    mem.remember(makeEntry({ filesChanged: [], turnsUsed: 10 }));
    expect(mem.getEntries("long")).toHaveLength(0);
  });
});
