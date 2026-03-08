/**
 * Tests multi-step pipeline execution, profile switching, error handling.
 * runFn is mocked — no real LLM calls.
 */

import { describe, it, expect, vi } from "vitest";
import { PipelineRunner } from "../src/core/agent/PipelineRunner";
import type {
  AgentConfig,
  AgentResult,
  PipelineStep,
} from "../src/core/AgentEngine";

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

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    summary: "Step complete",
    toolsUsed: ["readFile"],
    turnsUsed: 2,
    filesChanged: ["src/index.ts"],
    tokensUsed: 100,
    ...overrides,
  };
}

function makeRunFn(result: AgentResult = makeResult()) {
  return vi.fn(async () => result);
}

function makeSteps(
  n: number,
  overrides: Partial<PipelineStep> = {},
): PipelineStep[] {
  return Array.from({ length: n }, (_, i) => ({
    task: `step ${i + 1}`,
    ...overrides,
  }));
}

// ── Basic execution ───────────────────────────────────────────────────────────

describe("PipelineRunner — basic execution", () => {
  it("runs all steps and returns success", async () => {
    const runFn = makeRunFn();
    const runner = new PipelineRunner(makeConfig(), "code", runFn);
    const result = await runner.runPipeline(makeSteps(3));

    expect(result.success).toBe(true);
    expect(runFn).toHaveBeenCalledTimes(3);
  });

  it("returns correct step count", async () => {
    const runner = new PipelineRunner(makeConfig(), "code", makeRunFn());
    const result = await runner.runPipeline(makeSteps(3));
    expect(result.steps).toHaveLength(3);
  });

  it("aggregates filesChanged across steps", async () => {
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ filesChanged: ["a.ts"] }))
      .mockResolvedValueOnce(makeResult({ filesChanged: ["b.ts"] }))
      .mockResolvedValueOnce(makeResult({ filesChanged: ["a.ts"] })); // duplicate

    const runner = new PipelineRunner(makeConfig(), "code", runFn);
    const result = await runner.runPipeline(makeSteps(3));

    // deduped
    expect(result.totalFilesChanged).toContain("a.ts");
    expect(result.totalFilesChanged).toContain("b.ts");
    expect(result.totalFilesChanged.filter((f) => f === "a.ts")).toHaveLength(
      1,
    );
  });

  it("aggregates toolsUsed across steps", async () => {
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ toolsUsed: ["readFile"] }))
      .mockResolvedValueOnce(makeResult({ toolsUsed: ["editFile"] }));

    const runner = new PipelineRunner(makeConfig(), "code", runFn);
    const result = await runner.runPipeline(makeSteps(2));
    expect(result.totalToolsUsed).toContain("readFile");
    expect(result.totalToolsUsed).toContain("editFile");
  });

  it("sums totalTurnsUsed across steps", async () => {
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ turnsUsed: 3 }))
      .mockResolvedValueOnce(makeResult({ turnsUsed: 4 }));

    const runner = new PipelineRunner(makeConfig(), "code", runFn);
    const result = await runner.runPipeline(makeSteps(2));
    expect(result.totalTurnsUsed).toBe(7);
  });

  it("returns empty result for zero steps", async () => {
    const runner = new PipelineRunner(makeConfig(), "code", makeRunFn());
    const result = await runner.runPipeline([]);
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(0);
  });
});

// ── onMessage events ──────────────────────────────────────────────────────────

describe("PipelineRunner — onMessage events", () => {
  it("emits pipelineStart event", async () => {
    const onMessage = vi.fn();
    const cfg = makeConfig({ onMessage });
    const runner = new PipelineRunner(cfg, "code", makeRunFn());
    await runner.runPipeline(makeSteps(2));

    const types = onMessage.mock.calls.map((c) => c[0].type);
    expect(types).toContain("pipelineStart");
  });

  it("emits pipelineStep for each step", async () => {
    const onMessage = vi.fn();
    const cfg = makeConfig({ onMessage });
    const runner = new PipelineRunner(cfg, "code", makeRunFn());
    await runner.runPipeline(makeSteps(3));

    const stepEvents = onMessage.mock.calls.filter(
      (c) => c[0].type === "pipelineStep",
    );
    expect(stepEvents).toHaveLength(3);
  });

  it("emits pipelineDone on success", async () => {
    const onMessage = vi.fn();
    const cfg = makeConfig({ onMessage });
    const runner = new PipelineRunner(cfg, "code", makeRunFn());
    await runner.runPipeline(makeSteps(1));

    const types = onMessage.mock.calls.map((c) => c[0].type);
    expect(types).toContain("pipelineDone");
  });

  it("emits pipelineError when step fails", async () => {
    const onMessage = vi.fn();
    const cfg = makeConfig({ onMessage });
    const runFn = makeRunFn(makeResult({ success: false }));
    const runner = new PipelineRunner(cfg, "code", runFn);
    await runner.runPipeline(makeSteps(2));

    const types = onMessage.mock.calls.map((c) => c[0].type);
    expect(types).toContain("pipelineError");
  });
});

// ── Failure handling ──────────────────────────────────────────────────────────

describe("PipelineRunner — failure handling", () => {
  it("stops pipeline when a step returns success=false", async () => {
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ success: true }))
      .mockResolvedValueOnce(makeResult({ success: false }))
      .mockResolvedValueOnce(makeResult({ success: true }));

    const runner = new PipelineRunner(makeConfig(), "code", runFn);
    const result = await runner.runPipeline(makeSteps(3));

    expect(result.success).toBe(false);
    expect(runFn).toHaveBeenCalledTimes(2); // stopped at step 2
    expect(result.failedAtStep).toBe(2);
  });

  it("stops pipeline when runFn throws", async () => {
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ success: true }))
      .mockRejectedValueOnce(new Error("LLM timeout"));

    const runner = new PipelineRunner(makeConfig(), "code", runFn);
    const result = await runner.runPipeline(makeSteps(3));

    expect(result.success).toBe(false);
    expect(result.summary).toContain("LLM timeout");
    expect(runFn).toHaveBeenCalledTimes(2);
  });

  it("includes completed steps in result even when pipeline fails", async () => {
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({ success: true, summary: "step 1 done" }),
      )
      .mockResolvedValueOnce(makeResult({ success: false }));

    const runner = new PipelineRunner(makeConfig(), "code", runFn);
    const result = await runner.runPipeline(makeSteps(3));

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].result.summary).toBe("step 1 done");
  });
});

// ── Profile switching ─────────────────────────────────────────────────────────

describe("PipelineRunner — profile switching", () => {
  it("calls switchProfileFn when step has different profile", async () => {
    const switchFn = vi.fn();
    const runner = new PipelineRunner(makeConfig(), "code", makeRunFn());
    runner.setSwitchProfile(switchFn);

    const steps: PipelineStep[] = [
      { task: "step 1", profile: "code" },
      { task: "step 2", profile: "devops" },
      { task: "step 3", profile: "research" },
    ];

    await runner.runPipeline(steps);
    expect(switchFn).toHaveBeenCalledWith("devops");
    expect(switchFn).toHaveBeenCalledWith("research");
  });

  it("does not call switchProfileFn when profile unchanged", async () => {
    const switchFn = vi.fn();
    const runner = new PipelineRunner(makeConfig(), "code", makeRunFn());
    runner.setSwitchProfile(switchFn);

    const steps: PipelineStep[] = [
      { task: "step 1", profile: "code" },
      { task: "step 2" }, // no profile — uses default
    ];

    await runner.runPipeline(steps);
    expect(switchFn).not.toHaveBeenCalled();
  });

  it("restores default profile after pipeline completes", async () => {
    const switchFn = vi.fn();
    const runner = new PipelineRunner(makeConfig(), "code", makeRunFn());
    runner.setSwitchProfile(switchFn);

    const steps: PipelineStep[] = [{ task: "step 1", profile: "devops" }];

    await runner.runPipeline(steps);
    // Last call should restore to "code"
    const lastCall = switchFn.mock.calls[switchFn.mock.calls.length - 1];
    expect(lastCall[0]).toBe("code");
  });
});

// ── Provider per step ─────────────────────────────────────────────────────────

describe("PipelineRunner — provider per step", () => {
  it("passes step provider to runFn via overrides", async () => {
    const runFn = makeRunFn();
    const runner = new PipelineRunner(
      makeConfig({ provider: "codestral" }),
      "code",
      runFn,
    );

    const steps: PipelineStep[] = [{ task: "step 1", provider: "groq" }];

    await runner.runPipeline(steps);
    const overrides = runFn.mock.calls[0][1];
    expect(overrides?.provider).toBe("groq");
  });

  it("uses default provider when step has no provider", async () => {
    const runFn = makeRunFn();
    const runner = new PipelineRunner(
      makeConfig({ provider: "codestral" }),
      "code",
      runFn,
    );

    await runner.runPipeline([{ task: "step 1" }]);
    const overrides = runFn.mock.calls[0][1];
    expect(overrides?.provider).toBe("codestral");
  });
});
