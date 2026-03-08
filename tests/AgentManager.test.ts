/**
 * Tests registration, routing, broadcast, and abort.
 * AgentEngine is mocked — no real LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../src/core/AgentManager";
import type { AgentEngine, AgentResult } from "../src/core/AgentEngine";

// ── Mock AgentEngine ──────────────────────────────────────────────────────────

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    summary: "Task complete",
    toolsUsed: ["readFile"],
    turnsUsed: 2,
    filesChanged: ["src/index.ts"],
    tokensUsed: 100,
    ...overrides,
  };
}

function makeMockAgent(result: AgentResult = makeResult()): AgentEngine {
  return {
    run: vi.fn(async () => result),
    runPipeline: vi.fn(async () => ({
      success: true,
      steps: [],
      summary: "Pipeline done",
      totalTurnsUsed: 2,
      totalFilesChanged: [],
      totalToolsUsed: [],
      failedAtStep: -1,
    })),
    setSignal: vi.fn(),
  } as unknown as AgentEngine;
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("AgentManager — registration", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager();
  });

  it("registerAgent() adds agent to registry", () => {
    manager.registerAgent("coder", makeMockAgent(), "Writes code");
    expect(manager.getAgent("coder")).toBeDefined();
  });

  it("registerAgent() stores role", () => {
    manager.registerAgent("coder", makeMockAgent(), "Writes code");
    expect(manager.getAgent("coder")?.role).toBe("Writes code");
  });

  it("registerAgent() overwrites existing agent with same id", () => {
    const first = makeMockAgent(makeResult({ summary: "first" }));
    const second = makeMockAgent(makeResult({ summary: "second" }));
    manager.registerAgent("coder", first);
    manager.registerAgent("coder", second);
    expect(manager.getAgent("coder")?.agent).toBe(second);
  });

  it("removeAgent() deletes agent and returns true", () => {
    manager.registerAgent("coder", makeMockAgent());
    expect(manager.removeAgent("coder")).toBe(true);
    expect(manager.getAgent("coder")).toBeUndefined();
  });

  it("removeAgent() returns false for unknown id", () => {
    expect(manager.removeAgent("unknown")).toBe(false);
  });

  it("listAgents() returns all registered agents", () => {
    manager.registerAgent("coder", makeMockAgent());
    manager.registerAgent("reviewer", makeMockAgent());
    const list = manager.listAgents();
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.id)).toContain("coder");
    expect(list.map((a) => a.id)).toContain("reviewer");
  });

  it("getAgent() returns undefined for unknown id", () => {
    expect(manager.getAgent("missing")).toBeUndefined();
  });
});

// ── runOnAgent() ──────────────────────────────────────────────────────────────

describe("AgentManager — runOnAgent()", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager();
  });

  it("runs task on correct agent", async () => {
    const agent = makeMockAgent();
    manager.registerAgent("coder", agent);
    await manager.runOnAgent("coder", "write a function");
    expect(agent.run).toHaveBeenCalledWith("write a function", undefined);
  });

  it("returns AgentResult from the agent", async () => {
    const result = makeResult({ summary: "wrote function" });
    manager.registerAgent("coder", makeMockAgent(result));
    const out = await manager.runOnAgent("coder", "write a function");
    expect(out.summary).toBe("wrote function");
  });

  it("throws for unknown agent id", async () => {
    await expect(manager.runOnAgent("unknown", "task")).rejects.toThrow(
      /no agent registered/i,
    );
  });

  it("does not run other agents", async () => {
    const coder = makeMockAgent();
    const reviewer = makeMockAgent();
    manager.registerAgent("coder", coder);
    manager.registerAgent("reviewer", reviewer);
    await manager.runOnAgent("coder", "task");
    expect(coder.run).toHaveBeenCalledOnce();
    expect(reviewer.run).not.toHaveBeenCalled();
  });
});

// ── broadcast() sequential ────────────────────────────────────────────────────

describe("AgentManager — broadcast() sequential", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager();
  });

  it("runs task on all agents sequentially", async () => {
    const coder = makeMockAgent(makeResult({ summary: "coded" }));
    const reviewer = makeMockAgent(makeResult({ summary: "reviewed" }));
    manager.registerAgent("coder", coder, "Coder");
    manager.registerAgent("reviewer", reviewer, "Reviewer");

    const results = await manager.broadcast("do task");
    expect(coder.run).toHaveBeenCalledOnce();
    expect(reviewer.run).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
  });

  it("returns results with id and role", async () => {
    manager.registerAgent("coder", makeMockAgent(), "Writes code");
    const results = await manager.broadcast("task");
    expect(results[0].id).toBe("coder");
    expect(results[0].role).toBe("Writes code");
  });

  it("returns empty array when no agents registered", async () => {
    const results = await manager.broadcast("task");
    expect(results).toEqual([]);
  });

  it("sequential — agents run in registration order", async () => {
    const callOrder: string[] = [];
    const makeOrderedAgent = (id: string) =>
      ({
        run: vi.fn(async () => {
          callOrder.push(id);
          return makeResult();
        }),
        runPipeline: vi.fn(),
      }) as unknown as AgentEngine;

    manager.registerAgent("first", makeOrderedAgent("first"));
    manager.registerAgent("second", makeOrderedAgent("second"));
    manager.registerAgent("third", makeOrderedAgent("third"));

    await manager.broadcast("task");
    expect(callOrder).toEqual(["first", "second", "third"]);
  });
});

// ── broadcast() parallel ──────────────────────────────────────────────────────

describe("AgentManager — broadcast() parallel", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager();
  });

  it("runs all agents in parallel", async () => {
    const coder = makeMockAgent(makeResult({ summary: "coded" }));
    const reviewer = makeMockAgent(makeResult({ summary: "reviewed" }));
    manager.registerAgent("coder", coder);
    manager.registerAgent("reviewer", reviewer);

    const results = await manager.broadcast("task", undefined, {
      parallel: true,
    });
    expect(results).toHaveLength(2);
    expect(coder.run).toHaveBeenCalledOnce();
    expect(reviewer.run).toHaveBeenCalledOnce();
  });

  it("parallel — continues even if one agent fails", async () => {
    const good = makeMockAgent(makeResult({ summary: "good" }));
    const bad = {
      run: vi.fn(async () => {
        throw new Error("agent failed");
      }),
      runPipeline: vi.fn(),
    } as unknown as AgentEngine;

    manager.registerAgent("good", good);
    manager.registerAgent("bad", bad);

    const results = await manager.broadcast("task", undefined, {
      parallel: true,
    });

    expect(results).toHaveLength(2); // both returned
    expect(results.find((r) => r.id === "good")?.result).not.toBeNull(); // good has result
    expect(results.find((r) => r.id === "bad")?.result).toBeNull(); // bad has null result
    expect(results.find((r) => r.id === "bad")?.error).toContain(
      "agent failed",
    ); // with error
  });

  it("parallel — returns error entries if all agents fail", async () => {
    const bad = {
      run: vi.fn(async () => {
        throw new Error("failed");
      }),
    } as unknown as AgentEngine;

    manager.registerAgent("bad1", bad);
    manager.registerAgent("bad2", bad);

    const results = await manager.broadcast("task", undefined, {
      parallel: true,
    });

    expect(results).toHaveLength(2); // both returned, not dropped
    expect(results[0].result).toBeNull();
    expect(results[1].result).toBeNull();
    expect(results[0].error).toBe("failed");
    expect(results[1].error).toBe("failed");
  });
});

// ── runPipelineOnAgent() ──────────────────────────────────────────────────────

describe("AgentManager — runPipelineOnAgent()", () => {
  it("runs pipeline on correct agent", async () => {
    const manager = new AgentManager();
    const agent = makeMockAgent();
    manager.registerAgent("coder", agent);

    const steps = [
      { task: "step 1", provider: "codestral" },
      { task: "step 2", provider: "groq" },
    ];

    await manager.runPipelineOnAgent("coder", steps);
    expect(agent.runPipeline).toHaveBeenCalledWith(steps);
  });

  it("throws for unknown agent id", async () => {
    const manager = new AgentManager();
    await expect(manager.runPipelineOnAgent("unknown", [])).rejects.toThrow(
      /no agent registered/i,
    );
  });
});

describe("AgentManager — abortAll()", () => {
  it("does not throw when no agents registered", () => {
    const manager = new AgentManager();
    expect(() => manager.abortAll()).not.toThrow();
  });

  it("does not throw when agents are registered", () => {
    const manager = new AgentManager();
    manager.registerAgent("coder", makeMockAgent());
    manager.registerAgent("reviewer", makeMockAgent());
    expect(() => manager.abortAll()).not.toThrow();
  });
});
