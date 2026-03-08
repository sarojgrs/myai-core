/**
 * Tests provider chaining, error handling, strict mode, and management API.
 * No filesystem, no network — pure in-memory providers.
 */

import { describe, it, expect } from "vitest";
import { ContextEngine } from "../src/core/ContextEngine";
import type { ContextProvider } from "../src/core/ContextEngine";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider(name: string, output: string): ContextProvider {
  return {
    name,
    buildContext: async () => output,
  };
}

function makeFailingProvider(name: string): ContextProvider {
  return {
    name,
    buildContext: async () => {
      throw new Error(`${name} failed`);
    },
  };
}

// ── Provider chaining ─────────────────────────────────────────────────────────

describe("ContextEngine — provider chaining", () => {
  it("combines output from multiple providers", async () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("a", "context from A"));
    engine.use(makeProvider("b", "context from B"));

    const result = await engine.buildContext("task");
    expect(result).toContain("context from A");
    expect(result).toContain("context from B");
  });

  it("filters out empty string outputs", async () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("empty", ""));
    engine.use(makeProvider("real", "real context"));

    const result = await engine.buildContext("task");
    expect(result).toBe("real context");
  });

  it("returns empty string when no providers", async () => {
    const engine = new ContextEngine();
    const result = await engine.buildContext("task");
    expect(result).toBe("");
  });

  it("separates provider outputs with double newline", async () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("a", "A output"));
    engine.use(makeProvider("b", "B output"));

    const result = await engine.buildContext("task");
    expect(result).toContain("\n\n");
  });

  it("use() is chainable", async () => {
    const engine = new ContextEngine()
      .use(makeProvider("a", "A"))
      .use(makeProvider("b", "B"));

    const result = await engine.buildContext("task");
    expect(result).toContain("A");
    expect(result).toContain("B");
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("ContextEngine — error handling (default mode)", () => {
  it("continues if one provider throws", async () => {
    const engine = new ContextEngine();
    engine.use(makeFailingProvider("bad"));
    engine.use(makeProvider("good", "good context"));

    const result = await engine.buildContext("task");
    expect(result).toContain("good context");
  });

  it("returns empty string if all providers throw", async () => {
    const engine = new ContextEngine();
    engine.use(makeFailingProvider("bad1"));
    engine.use(makeFailingProvider("bad2"));

    const result = await engine.buildContext("task");
    expect(result).toBe("");
  });

  it("does not throw in default mode even with failures", async () => {
    const engine = new ContextEngine();
    engine.use(makeFailingProvider("bad"));
    await expect(engine.buildContext("task")).resolves.not.toThrow();
  });
});

// ── Strict mode ───────────────────────────────────────────────────────────────

describe("ContextEngine — strict mode", () => {
  it("throws when a provider fails in strict mode", async () => {
    const engine = new ContextEngine({ strict: true });
    engine.use(makeFailingProvider("bad"));
    await expect(engine.buildContext("task")).rejects.toThrow();
  });

  it("does not throw in strict mode when all providers succeed", async () => {
    const engine = new ContextEngine({ strict: true });
    engine.use(makeProvider("good", "good context"));
    await expect(engine.buildContext("task")).resolves.toBe("good context");
  });
});

// ── Provider management ───────────────────────────────────────────────────────

describe("ContextEngine — provider management", () => {
  it("has() returns true for registered provider", () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("myProvider", "ctx"));
    expect(engine.has("myProvider")).toBe(true);
  });

  it("has() returns false for unregistered provider", () => {
    const engine = new ContextEngine();
    expect(engine.has("missing")).toBe(false);
  });

  it("remove() unregisters a provider", () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("toRemove", "ctx"));
    engine.remove("toRemove");
    expect(engine.has("toRemove")).toBe(false);
  });

  it("remove() is chainable", () => {
    const engine = new ContextEngine()
      .use(makeProvider("a", "A"))
      .use(makeProvider("b", "B"))
      .remove("a");
    expect(engine.has("a")).toBe(false);
    expect(engine.has("b")).toBe(true);
  });

  it("remove() does nothing for unknown provider", () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("a", "A"));
    expect(() => engine.remove("unknown")).not.toThrow();
    expect(engine.has("a")).toBe(true);
  });

  it("list() returns all registered provider names", () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("a", "A"));
    engine.use(makeProvider("b", "B"));
    expect(engine.list()).toEqual(["a", "b"]);
  });

  it("clear() removes all providers", async () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("a", "A"));
    engine.use(makeProvider("b", "B"));
    engine.clear();
    expect(engine.list()).toHaveLength(0);
    expect(await engine.buildContext("task")).toBe("");
  });

  it("replace() swaps existing provider", async () => {
    const engine = new ContextEngine();
    engine.use(makeProvider("a", "old A"));
    engine.replace("a", makeProvider("a", "new A"));

    const result = await engine.buildContext("task");
    expect(result).toBe("new A");
  });

  it("replace() adds provider if not found", async () => {
    const engine = new ContextEngine();
    engine.replace("new", makeProvider("new", "added"));
    expect(engine.has("new")).toBe(true);
  });
});
