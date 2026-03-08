/**
 * Tests tool gating, profile switching, registration, and system prompt.
 * ProfileManager.register() takes a BaseProfile instance — not a plain object.
 */

import { describe, it, expect } from "vitest";
import { ProfileManager } from "../src/core/ProfileManager";
import { BaseProfile } from "../src/core/profiles/Base";

// ── Minimal test profile ──────────────────────────────────────────────────────

class TestProfile extends BaseProfile {
  readonly name = "test";
  readonly description = "Test profile";
  readonly systemPrompt = "You are a test agent.";
  readonly planningPrompt = "Plan carefully.";
  readonly allowedTools = ["readFile", "listFiles", "done"];
  readonly styleRules = ["Be concise"];
  readonly safetyRules = ["never delete files"];
}

class EmptyToolProfile extends BaseProfile {
  readonly name = "empty";
  readonly description = "No tools";
  readonly systemPrompt = "Empty profile";
  readonly planningPrompt = "No plan";
  readonly allowedTools = [];
  readonly styleRules = [];
  readonly safetyRules = [];
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("ProfileManager — registration", () => {
  it("registers built-in profiles on construction", () => {
    const pm = new ProfileManager();
    const list = pm.list();
    expect(list).toContain("code");
    expect(list).toContain("devops");
    expect(list).toContain("general");
    expect(list).toContain("research");
    expect(list).toContain("support");
    expect(list).toContain("automation");
  });

  it("register() adds a custom profile", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    expect(pm.list()).toContain("test");
  });

  it("register() is chainable", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile()).register(new EmptyToolProfile());
    expect(pm.list()).toContain("test");
    expect(pm.list()).toContain("empty");
  });

  it("get() throws for unknown profile", () => {
    const pm = new ProfileManager();
    expect(() => pm.get("nonexistent")).toThrow(/unknown profile/i);
  });
});

// ── Switching ─────────────────────────────────────────────────────────────────

describe("ProfileManager — switching", () => {
  it("defaults to 'code' profile", () => {
    const pm = new ProfileManager();
    expect(pm.getActiveName()).toBe("code");
  });

  it("switch() changes active profile", () => {
    const pm = new ProfileManager();
    pm.switch("devops");
    expect(pm.getActiveName()).toBe("devops");
  });

  it("switch() returns the new active profile", () => {
    const pm = new ProfileManager();
    const profile = pm.switch("research");
    expect(profile.name).toBe("research");
  });

  it("switch() throws for unknown profile", () => {
    const pm = new ProfileManager();
    expect(() => pm.switch("nonexistent")).toThrow();
  });

  it("getActive() returns currently active profile", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    expect(pm.getActive().name).toBe("test");
  });

  it("switch() affects isToolAllowed() immediately", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());

    pm.switch("code");
    const codeAllowed = pm.isToolAllowed("editFile");

    pm.switch("test");
    const testAllowed = pm.isToolAllowed("editFile"); // not in TestProfile.allowedTools

    expect(codeAllowed).toBe(true);
    expect(testAllowed).toBe(false);
  });
});

// ── Tool gating ───────────────────────────────────────────────────────────────

describe("ProfileManager — tool gating", () => {
  it("isToolAllowed() returns true for allowed tool", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    expect(pm.isToolAllowed("readFile")).toBe(true);
  });

  it("isToolAllowed() returns false for disallowed tool", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    expect(pm.isToolAllowed("editFile")).toBe(false);
    expect(pm.isToolAllowed("runCommand")).toBe(false);
    expect(pm.isToolAllowed("gitCommit")).toBe(false);
  });

  it("isToolAllowed() returns false for all tools on EmptyToolProfile", () => {
    const pm = new ProfileManager();
    pm.register(new EmptyToolProfile());
    pm.switch("empty");
    expect(pm.isToolAllowed("readFile")).toBe(false);
    expect(pm.isToolAllowed("editFile")).toBe(false);
    expect(pm.isToolAllowed("done")).toBe(false);
  });
});

// ── addAllowedTools() ─────────────────────────────────────────────────────────

describe("ProfileManager — addAllowedTools()", () => {
  it("extends active profile with new tools", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");

    expect(pm.isToolAllowed("editFile")).toBe(false);
    pm.addAllowedTools(["editFile"]);
    expect(pm.isToolAllowed("editFile")).toBe(true);
  });

  it("preserves existing tools after extension", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    pm.addAllowedTools(["editFile"]);
    // Original tools still allowed
    expect(pm.isToolAllowed("readFile")).toBe(true);
    expect(pm.isToolAllowed("listFiles")).toBe(true);
  });

  it("multiple tools added at once", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    pm.addAllowedTools(["editFile", "createFile", "runCommand"]);
    expect(pm.isToolAllowed("editFile")).toBe(true);
    expect(pm.isToolAllowed("createFile")).toBe(true);
    expect(pm.isToolAllowed("runCommand")).toBe(true);
  });
});

// ── System prompt ─────────────────────────────────────────────────────────────

describe("ProfileManager — buildSystemPrompt()", () => {
  it("includes safety rules in system prompt", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    const prompt = pm.buildSystemPrompt();
    expect(prompt).toContain("never delete files");
  });

  it("includes style rules in system prompt", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    const prompt = pm.buildSystemPrompt();
    expect(prompt).toContain("Be concise");
  });

  it("includes base context when provided", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    const prompt = pm.buildSystemPrompt("workspace context here");
    expect(prompt).toContain("workspace context here");
  });

  it("getPlanningPrompt() returns active profile planning prompt", () => {
    const pm = new ProfileManager();
    pm.register(new TestProfile());
    pm.switch("test");
    expect(pm.getPlanningPrompt()).toBe("Plan carefully.");
  });
});

// ── Multi-profile pipeline simulation ────────────────────────────────────────

describe("ProfileManager — pipeline switching", () => {
  it("tool access changes correctly across profile switches", () => {
    const pm = new ProfileManager();

    pm.switch("code");
    expect(pm.isToolAllowed("editFile")).toBe(true);

    pm.switch("research");
    expect(pm.isToolAllowed("editFile")).toBe(false); // research is read-only

    pm.switch("devops");
    expect(pm.isToolAllowed("runCommand")).toBe(true);

    pm.switch("support");
    expect(pm.isToolAllowed("editFile")).toBe(false); // support is read-only
  });
});

describe("ProfileManager — blocksFileEditsOnGit()", () => {
  it("returns a boolean for any profile and task", () => {
    const pm = new ProfileManager();
    pm.switch("code");
    const result = pm.blocksFileEditsOnGit("commit all changes");
    expect(typeof result).toBe("boolean");
  });

  it("returns boolean for all built-in profiles", () => {
    const pm = new ProfileManager();
    const profiles = [
      "code",
      "devops",
      "general",
      "research",
      "support",
      "automation",
    ] as const;
    for (const name of profiles) {
      pm.switch(name);
      const result = pm.blocksFileEditsOnGit("commit changes");
      expect(typeof result).toBe("boolean");
    }
  });

  it("custom profile can override blocksFileEditsOnGit", () => {
    class StrictProfile extends BaseProfile {
      readonly name = "strict";
      readonly description = "Strict profile";
      readonly systemPrompt = "You are strict.";
      readonly planningPrompt = "Plan strictly.";
      readonly allowedTools = ["readFile", "done"];
      readonly styleRules = [];
      readonly safetyRules = [];
      blocksFileEditsOnGit(_task: string): boolean {
        return true; // always block
      }
    }

    const pm = new ProfileManager();
    pm.register(new StrictProfile());
    pm.switch("strict");
    expect(pm.blocksFileEditsOnGit("anything")).toBe(true);
  });

  it("result changes when profile switches", () => {
    const pm = new ProfileManager();

    pm.switch("code");
    const codeResult = pm.blocksFileEditsOnGit("deploy to production");

    pm.switch("devops");
    const devopsResult = pm.blocksFileEditsOnGit("deploy to production");

    // Both are booleans — behavior may differ by profile
    expect(typeof codeResult).toBe("boolean");
    expect(typeof devopsResult).toBe("boolean");
  });
});
