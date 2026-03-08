/**
 * Tests for CacheEngine and ContextEngine cache behaviour.
 *
 * CacheEngine tests:
 *   - set/get, TTL expiry, manual invalidate, invalidateAll, stats
 *
 * ContextEngine tests:
 *   - cache hit/miss per provider
 *   - notifyToolExecuted invalidates correct provider
 *   - notifyToolExecuted does not affect unrelated providers
 *   - invalidateOn undefined = never invalidated by tools
 *   - cache: false provider always calls buildContext fresh
 *   - TTL expiry returns fresh result
 *   - invalidateAll clears all providers + internal caches
 *   - provider.invalidateCache() called when notifyToolExecuted hits
 *   - Executor wires onToolExecuted correctly end-to-end
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

// Simple mock provider — tracks how many times buildContext was called
function makeProvider(name: string, output: string, invalidateOn?: string[]) {
  const buildContext = vi.fn(async () => output);
  const invalidateCache = vi.fn();

  const provider = {
    name,
    buildContext,
    invalidateCache,
    ...(invalidateOn !== undefined ? { invalidateOn } : {}),
  };

  return { provider, buildContext, invalidateCache };
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

  it("size() returns count of valid entries only", async () => {
    cache.set("a", "1", 0); // never expires
    cache.set("b", "2", 20); // expires soon
    expect(cache.size()).toBe(2);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.size()).toBe(1); // b expired
  });

  it("keys() returns only valid (non-expired) keys", async () => {
    cache.set("a", "1", 0);
    cache.set("b", "2", 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.keys()).toEqual(["a"]);
  });

  it("getStats() returns valid and age for each entry", () => {
    cache.set("a", "1", 0);
    const stats = cache.getStats();
    expect(stats["a"].valid).toBe(true);
    expect(stats["a"].age).toBeGreaterThanOrEqual(0);
    expect(stats["a"].ttl).toBe(0);
  });

  it("getStats() marks expired entries as invalid", async () => {
    cache.set("a", "1", 20);
    await new Promise((r) => setTimeout(r, 40));
    const stats = cache.getStats();
    expect(stats["a"].valid).toBe(false);
  });

  it("clear() removes all entries including expired", async () => {
    cache.set("a", "1", 20);
    await new Promise((r) => setTimeout(r, 40));
    cache.clear();
    expect(cache.getStats()).toEqual({});
  });
});

// ── ContextEngine — cache behaviour ──────────────────────────────────────────

describe("ContextEngine — cache", () => {
  it("cache: false — always calls buildContext fresh", async () => {
    const { provider, buildContext } = makeProvider("p1", "ctx");
    const engine = new ContextEngine().use(provider); // cache: false by default

    await engine.buildContext("task");
    await engine.buildContext("task");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(3);
  });

  it("cache: true — returns cached on second call", async () => {
    const { provider, buildContext } = makeProvider("p1", "ctx");
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1); // second call = cache hit
  });

  it("cache hit returns correct value", async () => {
    const { provider } = makeProvider("p1", "my context");
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    const first = await engine.buildContext("task");
    const second = await engine.buildContext("task");

    expect(first).toBe("my context");
    expect(second).toBe("my context");
  });

  it("TTL expiry causes fresh call", async () => {
    const { provider, buildContext } = makeProvider("p1", "ctx");
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 30 });

    await engine.buildContext("task");
    await new Promise((r) => setTimeout(r, 60)); // wait for TTL
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(2); // second = fresh after expiry
  });

  it("multiple providers — each cached independently", async () => {
    const { provider: p1, buildContext: b1 } = makeProvider("p1", "ctx1");
    const { provider: p2, buildContext: b2 } = makeProvider("p2", "ctx2");

    const engine = new ContextEngine()
      .use(p1, { cache: true, ttl: 0 })
      .use(p2, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    await engine.buildContext("task");

    expect(b1).toHaveBeenCalledTimes(1);
    expect(b2).toHaveBeenCalledTimes(1);
  });

  it("combined output joins both providers with blank line", async () => {
    const { provider: p1 } = makeProvider("p1", "part one");
    const { provider: p2 } = makeProvider("p2", "part two");

    const engine = new ContextEngine().use(p1).use(p2);
    const result = await engine.buildContext("task");

    expect(result).toBe("part one\n\npart two");
  });
});

// ── ContextEngine — notifyToolExecuted ───────────────────────────────────────

describe("ContextEngine — notifyToolExecuted", () => {
  it("invalidates provider whose invalidateOn includes the tool", async () => {
    const { provider, buildContext } = makeProvider("filesystem", "ctx", [
      "createFile",
      "editFile",
    ]);
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task"); // cold start → cached
    engine.notifyToolExecuted("createFile");
    await engine.buildContext("task"); // cache cleared → fresh call

    expect(buildContext).toHaveBeenCalledTimes(2);
  });

  it("does NOT invalidate provider whose invalidateOn excludes the tool", async () => {
    const { provider, buildContext } = makeProvider("filesystem", "ctx", [
      "createFile",
    ]);
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.notifyToolExecuted("gitCommit"); // not in invalidateOn
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1); // still cached
  });

  it("undefined invalidateOn — never invalidated by tools", async () => {
    const { provider, buildContext } = makeProvider("memory", "ctx");
    // no invalidateOn defined
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");
    engine.notifyToolExecuted("editFile");
    engine.notifyToolExecuted("runCommand");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1); // always cached
  });

  it("empty invalidateOn — never invalidated by tools", async () => {
    const { provider, buildContext } = makeProvider("memory", "ctx", []);
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(1);
  });

  it("calls provider.invalidateCache('all') when invalidated", async () => {
    const { provider, invalidateCache } = makeProvider("filesystem", "ctx", [
      "createFile",
    ]);
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");

    expect(invalidateCache).toHaveBeenCalledWith("all");
  });

  it("does NOT call provider.invalidateCache() when tool not in invalidateOn", async () => {
    const { provider, invalidateCache } = makeProvider("filesystem", "ctx", [
      "createFile",
    ]);
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.notifyToolExecuted("gitCommit"); // not in invalidateOn

    expect(invalidateCache).not.toHaveBeenCalled();
  });

  it("only invalidates the matching provider — not others", async () => {
    const { provider: fs, buildContext: fsCall } = makeProvider(
      "filesystem",
      "fs ctx",
      ["createFile"],
    );
    const { provider: mem, buildContext: memCall } = makeProvider(
      "memory",
      "mem ctx",
      [],
    );

    const engine = new ContextEngine()
      .use(fs, { cache: true, ttl: 0 })
      .use(mem, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.notifyToolExecuted("createFile");
    await engine.buildContext("task");

    expect(fsCall).toHaveBeenCalledTimes(2); // invalidated → re-fetched
    expect(memCall).toHaveBeenCalledTimes(1); // untouched → still cached
  });
});

// ── ContextEngine — invalidate / invalidateAll ────────────────────────────────

describe("ContextEngine — invalidate and invalidateAll", () => {
  it("invalidate() clears one provider cache", async () => {
    const { provider, buildContext } = makeProvider("p1", "ctx");
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.invalidate("p1");
    await engine.buildContext("task");

    expect(buildContext).toHaveBeenCalledTimes(2);
  });

  it("invalidate() on non-existent provider does not throw", () => {
    const engine = new ContextEngine();
    expect(() => engine.invalidate("non-existent")).not.toThrow();
  });

  it("invalidateAll() clears all provider caches", async () => {
    const { provider: p1, buildContext: b1 } = makeProvider("p1", "ctx1");
    const { provider: p2, buildContext: b2 } = makeProvider("p2", "ctx2");

    const engine = new ContextEngine()
      .use(p1, { cache: true, ttl: 0 })
      .use(p2, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    engine.invalidateAll();
    await engine.buildContext("task");

    expect(b1).toHaveBeenCalledTimes(2);
    expect(b2).toHaveBeenCalledTimes(2);
  });

  it("invalidateAll() calls invalidateCache() on all providers", async () => {
    const { provider: p1, invalidateCache: ic1 } = makeProvider(
      "p1",
      "ctx1",
      [],
    );
    const { provider: p2, invalidateCache: ic2 } = makeProvider(
      "p2",
      "ctx2",
      [],
    );

    const engine = new ContextEngine().use(p1).use(p2);
    engine.invalidateAll();

    expect(ic1).toHaveBeenCalledWith("all");
    expect(ic2).toHaveBeenCalledWith("all");
  });

  it("getCacheStats() returns stats for cached providers", async () => {
    const { provider } = makeProvider("p1", "ctx");
    const engine = new ContextEngine().use(provider, { cache: true, ttl: 0 });

    await engine.buildContext("task");
    const stats = engine.getCacheStats();

    expect(stats["p1"]).toBeDefined();
    expect(stats["p1"].valid).toBe(true);
    expect(stats["p1"].ttl).toBe(0);
  });
});

// ── Executor — onToolExecuted wired end-to-end ────────────────────────────────

// ── Executor — onToolExecuted ─────────────────────────────────────────────────

describe("Executor — onToolExecuted", () => {
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

  it("calls onToolExecuted after successful tool", async () => {
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

    // Cache was cleared — next call is fresh
    await contextEngine.buildContext("task");
    expect(buildContext).toHaveBeenCalledTimes(2);
  });
});

it("does NOT call onToolExecuted when tool fails", async () => {
  const onToolExecuted = vi.fn();
  const cfg = makeConfig({ onToolExecuted });

  const executor = makeExecutor(5);
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
                path: "src/Router.ts",
                content: "",
              }),
            },
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

  executor.setCallAIWithTools(callAI);
  executor.setBuildToolSchemas(() => []);
  executor.setExecuteTool(makeToolResult(false, "permission denied")); // tool fails

  await executor.execute(makeContext(cfg, true));

  expect(onToolExecuted).not.toHaveBeenCalled();
});
