/**
 * Tests planning prompt resolution and plan generation.
 * callAI is mocked — no real LLM calls.
 */

import { describe, it, expect, vi } from "vitest";
import { Planner } from "../src/core/agent/Planner";
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

function makeCallAI(plan = "1. Read files\n2. Edit code\n3. Done") {
  return vi.fn(async () => ({
    content: plan,
    usage: { total_tokens: 50 },
  }));
}

// ── Planner ───────────────────────────────────────────────────────────────────

describe("Planner — plan()", () => {
  it("throws when callAI is not set", async () => {
    const planner = new Planner();
    await expect(
      planner.plan({
        task: "fix bug",
        projectContext: "",
        config: makeConfig(),
      }),
    ).rejects.toThrow(/callAI not set/i);
  });

  it("returns plan from callAI response", async () => {
    const planner = new Planner();
    planner.setCallAI(makeCallAI("1. Step one\n2. Step two"));
    const result = await planner.plan({
      task: "fix auth bug",
      projectContext: "workspace context",
      config: makeConfig(),
    });
    expect(result.plan).toBe("1. Step one\n2. Step two");
  });

  it("returns tokensUsed from usage", async () => {
    const planner = new Planner();
    planner.setCallAI(
      vi.fn(async () => ({
        content: "plan",
        usage: { total_tokens: 123 },
      })),
    );

    const result = await planner.plan({
      task: "task",
      projectContext: "",
      config: makeConfig(),
    });
    expect(result.tokensUsed).toBe(123);
  });

  it("returns 0 tokensUsed when usage missing", async () => {
    const planner = new Planner();
    planner.setCallAI(vi.fn(async () => ({ content: "plan" })));

    const result = await planner.plan({
      task: "task",
      projectContext: "",
      config: makeConfig(),
    });
    expect(result.tokensUsed).toBe(0);
  });

  it("uses config.planningPrompt when set", async () => {
    const planner = new Planner();
    const callAI = makeCallAI();
    planner.setCallAI(callAI);

    await planner.plan({
      task: "fix bug",
      projectContext: "",
      config: makeConfig({ planningPrompt: "My custom planning prompt" }),
    });

    const messages = callAI.mock.calls[0][0];
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("My custom planning prompt");
  });

  it("falls back to profilePlanningPrompt when no config planningPrompt", async () => {
    const planner = new Planner();
    const callAI = makeCallAI();
    planner.setCallAI(callAI);
    planner.setProfilePlanningPrompt(() => "Profile planning prompt");

    await planner.plan({
      task: "fix bug",
      projectContext: "",
      config: makeConfig(), // no planningPrompt
    });

    const messages = callAI.mock.calls[0][0];
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Profile planning prompt");
  });

  it("uses config.systemPrompt in system message when set", async () => {
    const planner = new Planner();
    const callAI = makeCallAI();
    planner.setCallAI(callAI);

    await planner.plan({
      task: "fix bug",
      projectContext: "ctx",
      config: makeConfig({ systemPrompt: "You are an expert coder" }),
    });

    const messages = callAI.mock.calls[0][0];
    const sysMsg = messages.find((m: any) => m.role === "system");
    expect(sysMsg.content).toContain("You are an expert coder");
  });

  it("uses profileSystemPrompt when no config systemPrompt", async () => {
    const planner = new Planner();
    const callAI = makeCallAI();
    planner.setCallAI(callAI);
    planner.setProfileSystemPrompt(() => "Profile system prompt");

    await planner.plan({
      task: "fix bug",
      projectContext: "ctx",
      config: makeConfig(), // no systemPrompt
    });

    const messages = callAI.mock.calls[0][0];
    const sysMsg = messages.find((m: any) => m.role === "system");
    expect(sysMsg.content).toContain("Profile system prompt");
  });

  it("includes task in user message", async () => {
    const planner = new Planner();
    const callAI = makeCallAI();
    planner.setCallAI(callAI);

    await planner.plan({
      task: "refactor authentication module",
      projectContext: "",
      config: makeConfig(),
    });

    const messages = callAI.mock.calls[0][0];
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("refactor authentication module");
  });

  it("includes userPrompt in user message when set", async () => {
    const planner = new Planner();
    const callAI = makeCallAI();
    planner.setCallAI(callAI);

    await planner.plan({
      task: "fix bug",
      projectContext: "",
      config: makeConfig({ userPrompt: "Always use TypeScript" }),
    });

    const messages = callAI.mock.calls[0][0];
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Always use TypeScript");
  });

  it("overrides take precedence over config", async () => {
    const planner = new Planner();
    const callAI = makeCallAI();
    planner.setCallAI(callAI);

    await planner.plan({
      task: "fix bug",
      projectContext: "",
      config: makeConfig({ planningPrompt: "default prompt" }),
      overrides: { planningPrompt: "override prompt" },
    });

    const messages = callAI.mock.calls[0][0];
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("override prompt");
    expect(userMsg.content).not.toContain("default prompt");
  });
});
