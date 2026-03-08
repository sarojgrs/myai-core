/**
 * Tests for CacheEngine and ContextEngine cache behaviour.
 *
 * CacheEngine  — set/get, TTL, invalidate, stats
 * ContextEngine — cache hit/miss, notifyToolExecuted, invalidateAll
 * Executor     — onToolExecuted fired after success, not on failure
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CacheEngine } from "../src/core/CacheEngine";
import { ContextEngine } from "../src/core/ContextEngine";
import { Executor } from "../src/core/agent/Executor";
import { LoopDetector } from "../src/core/agent/LoopDetector";
import type { AgentConfig } from "../src/core/AgentEngine";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "codestral",
    onMessage: vi.fn(),
    workspaceRoot: "/workspace",
    maxTurns: 10,
    ...overrides,
  } as unknown as AgentConfig;
}

function makeExecutor(maxTurns = 5): Executor {
  return new Executor(maxTurns, new LoopDetector());
}

function makeToolResult(success = true, output = "tool output") {
  return vi.fn(async (tool: string) => ({ tool, success, output }));
}

function makeContext(config: AgentConfig, nativeTools = true) {
  return {
    task: "fix the bug",
    plan: "1. Read file\n2. Fix bug",
    provider: "codestral",
    projectContext: "workspace context",
    toolsUsed: [],
    config,
    nativeTools,
  };
}

// One-turn native callAI — executes one named tool then exits cleanly
function makeOneToolCallAI(toolName: string, args: Record<string, string>) {
  let turn = 0;
  return vi.fn(async () => {
    turn++;
    if (turn === 1) {
      return {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function" as const,
            function: { name: toolName, arguments: JSON.stringify(args) },
          },
        ],
      };
    }
    return {
      role: "assistant" as const,
      content: "Done",
      tool_calls: [] as any[],
    };
  }) as any;
}

function makeCheckpoint(overrides: Record<string, any> = {}) {
  return {
    runId: "1",
    task: "fix the bug",
    plan: "1. Read file\n2. Fix bug",
    turn: 2,
    messages: [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "Task: fix the bug" },
    ],
    filesChanged: ["src/api/Middleware.ts"],
    toolsUsed: ["createFile"],
    tokensUsed: 3000,
    lastInputTokens: 0,
    timestamp: Date.now(),
    fixedHeader: 2,
    expiryMap: [] as Array<[number, number]>,
    ...overrides,
  };
}

// ── CacheEngine ───────────────────────────────────────────────────────────────

describe("CacheEngine", () => {
  let cache: CacheEngine<string>;

  beforeEach(() => {
    cache = new CacheEngine<string>();
  });

  it("returns undefined for unknown key", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a value", () => {
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  it("has() returns true for valid key", () => {
    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);
  });

  it("has() returns false for missing key", () => {
    expect(cache.has("missing")).toBe(false);
  });

  it("ttl: 0 — never auto-expires", async () => {
    cache.set("key", "value", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(cache.get("key")).toBe("value");
  });

  it("ttl > 0 — expires after TTL", async () => {
    cache.set("key", "value", 30);
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("key")).toBeUndefined();
  });

  it("invalidate() removes a single key", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });

  it("invalidate() on non-existent key does not throw", () => {
    expect(() => cache.invalidate("non-existent")).not.toThrow();
  });

  it("invalidateAll() clears everything", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.invalidateAll();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("size() counts only valid entries", async () => {
    cache.set("a", "1", 0);
    cache.set("b", "2", 20);
    expect(cache.size()).toBe(2);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.size()).toBe(1);
  });

  it("keys() returns only non-expired keys", async () => {
    cache.set("a", "1", 0);
    cache.set("b", "2", 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.keys()).toEqual(["a"]);
  });

  it("getStats() returns valid, age, ttl per entry", () => {
    cache.set("a", "1", 0);
    const stats = cache.getStats();
    expect(stats["a"].valid).toBe(true);
    expect(stats["a"].age).toBeGreaterThanOrEqual(0);
    expect(stats["a"].ttl).toBe(0);
  });

  it("getStats() marks expired entries as invalid", async () => {
    cache.set("a", "1", 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.getStats()["a"].valid).toBe(false);
  });

  it("clear() removes all entries", () => {
    cache.set("a", "1");
    cache.clear();
    expect(cache.getStats()).toEqual({});
  });
});

// ── ContextEngine — cache ─────────────────────────────────────────────────────

describe("ContextEngine — cache", () => {
  it("cache: false — always calls buildContext fresh", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use({ name: "p1", buildContext });

    await engine.buildContext("task");
    await engine.buildContext("task");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(3);
  });

  it("cache: true — returns cached on second call", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use(
      { name: "p1", buildContext },
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1);
  });

  it("cached value is correct", async () => {
    const engine = new ContextEngine().use(
      { name: "p1", buildContext: async () => "my context" },
      { cache: true, ttl: 0 },
    );

    expect(await engine.buildContext("task")).toBe("my context");
    expect(await engine.buildContext("task")).toBe("my context");
  });

  it("TTL expiry causes fresh call", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use(
      { name: "p1", buildContext },
      { cache: true, ttl: 30 },
    );

    await engine.buildContext("task");
    await new Promise((r) => setTimeout(r, 60));
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(2);
  });

  it("two providers cached independently", async () => {
    const b1 = vi.fn(async () => "ctx1");
    const b2 = vi.fn(async () => "ctx2");
    const engine = new ContextEngine()
      .use({ name: "p1", buildContext: b1 }, { cache: true, ttl: 0 })
      .use({ name: "p2", buildContext: b2 }, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    await engine.buildContext("task");

    expect(b1).toHaveBeenCalledTimes(1);
    expect(b2).toHaveBeenCalledTimes(1);
  });

  it("combined output joins providers with blank line", async () => {
    const engine = new ContextEngine()
      .use({ name: "p1", buildContext: async () => "part one" })
      .use({ name: "p2", buildContext: async () => "part two" });

    expect(await engine.buildContext("task")).toBe("part one\n\npart two");
  });
});

// ── ContextEngine — notifyToolExecuted ───────────────────────────────────────

describe("ContextEngine — notifyToolExecuted", () => {
  it("invalidates provider whose invalidateOn includes the tool", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use(
      {
        name: "filesystem",
        buildContext,
        invalidateOn: ["createFile", "editFile"],
      },
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(2);
  });

  it("does NOT invalidate provider when tool not in invalidateOn", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use(
      { name: "filesystem", buildContext, invalidateOn: ["createFile"] },
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    engine.notifyToolExecuted("gitCommit");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1);
  });

  it("undefined invalidateOn — never invalidated by tools", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use(
      { name: "memory", buildContext },
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");
    engine.notifyToolExecuted("editFile");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1);
  });

  it("empty invalidateOn — never invalidated by tools", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use(
      { name: "memory", buildContext, invalidateOn: [] },
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1);
  });

  it("calls provider.invalidateCache('all') when invalidated", async () => {
    const invalidateCache = vi.fn();
    const engine = new ContextEngine().use(
      {
        name: "filesystem",
        buildContext: async () => "ctx",
        invalidateOn: ["createFile"],
        invalidateCache,
      } as any,
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");

    expect(invalidateCache).toHaveBeenCalledWith("all");
  });

  it("only invalidates matching provider — leaves others cached", async () => {
    const fsCall = vi.fn(async () => "fs");
    const memCall = vi.fn(async () => "mem");

    const engine = new ContextEngine()
      .use(
        {
          name: "filesystem",
          buildContext: fsCall,
          invalidateOn: ["createFile"],
        },
        { cache: true, ttl: 0 },
      )
      .use(
        { name: "memory", buildContext: memCall, invalidateOn: [] },
        { cache: true, ttl: 0 },
      );

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");
    await engine.buildContext("task");

    expect(fsCall).toHaveBeenCalledTimes(2);
    expect(memCall).toHaveBeenCalledTimes(1);
  });
});

// ── ContextEngine — invalidate / invalidateAll ────────────────────────────────

describe("ContextEngine — invalidate and invalidateAll", () => {
  it("invalidate() clears one provider", async () => {
    const buildContext = vi.fn(async () => "ctx");
    const engine = new ContextEngine().use(
      { name: "p1", buildContext },
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    engine.invalidate("p1");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(2);
  });

  it("invalidate() on non-existent provider does not throw", () => {
    const engine = new ContextEngine();
    expect(() => engine.invalidate("non-existent")).not.toThrow();
  });

  it("invalidateAll() clears all providers", async () => {
    const b1 = vi.fn(async () => "ctx1");
    const b2 = vi.fn(async () => "ctx2");
    const engine = new ContextEngine()
      .use({ name: "p1", buildContext: b1 }, { cache: true, ttl: 0 })
      .use({ name: "p2", buildContext: b2 }, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.invalidateAll();
    await engine.buildContext("task");

    expect(b1).toHaveBeenCalledTimes(2);
    expect(b2).toHaveBeenCalledTimes(2);
  });

  it("invalidateAll() calls invalidateCache() on all providers", () => {
    const ic1 = vi.fn();
    const ic2 = vi.fn();
    const engine = new ContextEngine()
      .use({
        name: "p1",
        buildContext: async () => "",
        invalidateCache: ic1,
      } as any)
      .use({
        name: "p2",
        buildContext: async () => "",
        invalidateCache: ic2,
      } as any);

    engine.invalidateAll();

    expect(ic1).toHaveBeenCalledWith("all");
    expect(ic2).toHaveBeenCalledWith("all");
  });

  it("getCacheStats() returns stats after buildContext", async () => {
    const engine = new ContextEngine().use(
      { name: "p1", buildContext: async () => "ctx" },
      { cache: true, ttl: 0 },
    );

    await engine.buildContext("task");
    const stats = engine.getCacheStats();

    expect(stats["p1"]).toBeDefined();
    expect(stats["p1"].valid).toBe(true);
    expect(stats["p1"].ttl).toBe(0);
  });
});

// ── Executor — onToolExecuted ─────────────────────────────────────────────────

describe("Executor — onToolExecuted", () => {
  it("calls onToolExecuted after successful createFile", async () => {
    const onToolExecuted = vi.fn();
    const executor = makeExecutor(5);

    executor.setCallAIWithTools(
      makeOneToolCallAI("createFile", { path: "src/Router.ts", content: "x" }),
    );
    executor.setBuildToolSchemas(() => []);
    executor.setExecuteTool(makeToolResult(true));

    await executor.execute(makeContext(makeConfig({ onToolExecuted }), true));

    expect(onToolExecuted).toHaveBeenCalledWith("createFile");
  });

  it("calls onToolExecuted after successful editFile", async () => {
    const onToolExecuted = vi.fn();
    const executor = makeExecutor(5);

    executor.setCallAIWithTools(
      makeOneToolCallAI("editFile", { path: "src/app.ts", content: "x" }),
    );
    executor.setBuildToolSchemas(() => []);
    executor.setExecuteTool(makeToolResult(true));

    await executor.execute(makeContext(makeConfig({ onToolExecuted }), true));

    expect(onToolExecuted).toHaveBeenCalledWith("editFile");
  });

  it("does NOT call onToolExecuted when tool fails", async () => {
    const onToolExecuted = vi.fn();
    const executor = makeExecutor(5);

    executor.setCallAIWithTools(
      makeOneToolCallAI("createFile", { path: "src/Router.ts", content: "x" }),
    );
    executor.setBuildToolSchemas(() => []);
    executor.setExecuteTool(makeToolResult(false, "permission denied"));

    await executor.execute(makeContext(makeConfig({ onToolExecuted }), true));

    expect(onToolExecuted).not.toHaveBeenCalled();
  });

  it("onToolExecuted invalidates ContextEngine cache end-to-end", async () => {
    const buildContext = vi.fn(async () => "fs context");
    const contextEngine = new ContextEngine().use(
      { name: "filesystem", buildContext, invalidateOn: ["createFile"] },
      { cache: true, ttl: 0 },
    );

    // Pre-warm cache
    await contextEngine.buildContext("task");
    expect(buildContext).toHaveBeenCalledTimes(1);

    const executor = makeExecutor(5);
    executor.setCallAIWithTools(
      makeOneToolCallAI("createFile", { path: "src/Router.ts", content: "x" }),
    );
    executor.setBuildToolSchemas(() => []);
    executor.setExecuteTool(makeToolResult(true));

    await executor.execute(
      makeContext(
        makeConfig({
          onToolExecuted: (t) => contextEngine.notifyToolExecuted(t),
        }),
        true,
      ),
    );

    // Cache was cleared — next call hits provider fresh
    await contextEngine.buildContext("task");
    expect(buildContext).toHaveBeenCalledTimes(2);
  });
});

// ── Executor — checkpoint ─────────────────────────────────────────────────────

it("saves checkpoint after each turn in native mode", async () => {
  const executor = makeExecutor(5);
  let savedCp: any = null;

  const original = executor.saveCheckpoint.bind(executor);
  vi.spyOn(executor, "saveCheckpoint").mockImplementation((cp) => {
    savedCp = cp;
    original(cp);
  });

  let turn = 0;
  const callAI = vi.fn(async () => {
    turn++;
    if (turn === 1) {
      return {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function" as const,
            function: {
              name: "createFile",
              arguments: JSON.stringify({
                path: "src/api/Request.ts",
                content: "class Request {}",
              }),
            },
          },
        ],
      };
    }
    return {
      role: "assistant" as const,
      content: "Task complete",
      tool_calls: [] as any[],
    };
  }) as any;

  executor.setCallAIWithTools(callAI);
  executor.setBuildToolSchemas(() => []);
  executor.setExecuteTool(makeToolResult());

  await executor.execute(makeContext(makeConfig(), true));

  // use the real runId captured from saveCheckpoint
  expect(savedCp).not.toBeNull();
  expect(savedCp.turn).toBe(1);
  expect(savedCp.task).toBe("fix the bug");
  expect(savedCp.toolsUsed).toContain("createFile");

  // load using the real runId
  const cp = executor.loadCheckpoint(savedCp.task, savedCp.runId);
  expect(cp).toBeDefined();
});
