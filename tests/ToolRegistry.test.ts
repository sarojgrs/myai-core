/**
 * Tests: register/unregister, argument validation, category/tag filtering,
 *        builtin protection, schema validation.
 * Pure logic only — no LLM, no fs, no network.
 */

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/core/registry/ToolRegistry";
import type { EnhancedToolDefinition } from "../src/core/registry/ToolRegistry";

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeHandler() {
  return async (_args: Record<string, string>) => ({
    tool: "test",
    success: true,
    output: "ok",
  });
}

function makeDefinition(
  overrides: Partial<Omit<EnhancedToolDefinition, "name" | "isBuiltin">> = {},
): Omit<EnhancedToolDefinition, "name" | "isBuiltin"> {
  return {
    description: "Does something useful",
    params: {
      path: { type: "string", description: "a path", required: true },
    },
    category: "custom",
    ...overrides,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("ToolRegistry — registerTool()", () => {
  it("registers a new tool and hasTool() confirms it", () => {
    const reg = new ToolRegistry();
    reg.registerTool("myTool", makeDefinition(), makeHandler());
    expect(reg.hasTool("myTool")).toBe(true);
  });

  it("getDefinition() returns the registered definition", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "myTool",
      makeDefinition({ description: "Custom tool" }),
      makeHandler(),
    );
    expect(reg.getDefinition("myTool")!.description).toBe("Custom tool");
  });

  it("getHandler() returns the registered handler", () => {
    const reg = new ToolRegistry();
    const handler = makeHandler();
    reg.registerTool("myTool", makeDefinition(), handler);
    expect(reg.getHandler("myTool")).toBe(handler);
  });

  it("throws when registering with empty name", () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.registerTool("", makeDefinition(), makeHandler()),
    ).toThrow();
  });

  it("throws when name contains invalid characters (starts with number)", () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.registerTool("1bad", makeDefinition(), makeHandler()),
    ).toThrow(/must start with letter/i);
  });

  it("throws when description is empty", () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.registerTool(
        "myTool",
        makeDefinition({ description: "" }),
        makeHandler(),
      ),
    ).toThrow(/description/i);
  });

  it("allows re-registering (overwrite) a custom tool", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "myTool",
      makeDefinition({ description: "v1" }),
      makeHandler(),
    );
    reg.registerTool(
      "myTool",
      makeDefinition({ description: "v2" }),
      makeHandler(),
    );
    expect(reg.getDefinition("myTool")!.description).toBe("v2");
  });
});

// ── Unregister ────────────────────────────────────────────────────────────────

describe("ToolRegistry — unregisterTool()", () => {
  it("removes a registered custom tool", () => {
    const reg = new ToolRegistry();
    reg.registerTool("myTool", makeDefinition(), makeHandler());
    const removed = reg.unregisterTool("myTool");
    expect(removed).toBe(true);
    expect(reg.hasTool("myTool")).toBe(false);
  });

  it("returns false for unregistered tool name", () => {
    const reg = new ToolRegistry();
    const removed = reg.unregisterTool("nonexistent");
    expect(removed).toBe(false);
  });
});

// ── Builtin protection ────────────────────────────────────────────────────────

describe("ToolRegistry — builtin protection", () => {
  function makeRegistryWithBuiltin(): ToolRegistry {
    const reg = new ToolRegistry();
    // Manually inject a builtin (simulating what AgentEngine would do)
    (reg as any).toolDefinitions.set("readFile", {
      name: "readFile",
      description: "Read a file",
      params: {},
      isBuiltin: true,
      category: "builtin",
    });
    (reg as any).toolHandlers.set("readFile", makeHandler());
    return reg;
  }

  it("isBuiltinTool() returns true for builtin", () => {
    const reg = makeRegistryWithBuiltin();
    expect(reg.isBuiltinTool("readFile")).toBe(true);
  });

  it("isBuiltinTool() returns false for custom tool", () => {
    const reg = new ToolRegistry();
    reg.registerTool("myTool", makeDefinition(), makeHandler());
    expect(reg.isBuiltinTool("myTool")).toBe(false);
  });

  it("registerTool() throws when name conflicts with builtin", () => {
    const reg = makeRegistryWithBuiltin();
    expect(() =>
      reg.registerTool("readFile", makeDefinition(), makeHandler()),
    ).toThrow(/conflicts with built-in/i);
  });

  it("unregisterTool() throws when trying to remove builtin", () => {
    const reg = makeRegistryWithBuiltin();
    expect(() => reg.unregisterTool("readFile")).toThrow(
      /Cannot unregister built-in/i,
    );
  });
});

// ── Query methods ─────────────────────────────────────────────────────────────

describe("ToolRegistry — query methods", () => {
  it("listToolNames() returns all registered tool names", () => {
    const reg = new ToolRegistry();
    reg.registerTool("toolA", makeDefinition(), makeHandler());
    reg.registerTool("toolB", makeDefinition(), makeHandler());
    expect(reg.listToolNames()).toContain("toolA");
    expect(reg.listToolNames()).toContain("toolB");
  });

  it("getAllDefinitions() includes all tools", () => {
    const reg = new ToolRegistry();
    reg.registerTool("myTool", makeDefinition(), makeHandler());
    expect(reg.getAllDefinitions().map((d) => d.name)).toContain("myTool");
  });

  it("getToolsByCategory() filters correctly", () => {
    const reg = new ToolRegistry();
    reg.registerTool("t1", makeDefinition({ category: "file" }), makeHandler());
    reg.registerTool("t2", makeDefinition({ category: "git" }), makeHandler());
    const fileTools = reg.getToolsByCategory("file");
    expect(fileTools.map((t) => t.name)).toContain("t1");
    expect(fileTools.map((t) => t.name)).not.toContain("t2");
  });

  it("getToolsByTag() filters by tag", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "tagged",
      makeDefinition({ tags: ["read", "safe"] }),
      makeHandler(),
    );
    reg.registerTool(
      "untagged",
      makeDefinition({ tags: ["write"] }),
      makeHandler(),
    );
    expect(reg.getToolsByTag("read").map((t) => t.name)).toContain("tagged");
    expect(reg.getToolsByTag("read").map((t) => t.name)).not.toContain(
      "untagged",
    );
  });

  it("getCustomTools() excludes builtins", () => {
    const reg = new ToolRegistry();
    (reg as any).toolDefinitions.set("builtinTool", {
      name: "builtinTool",
      description: "x",
      params: {},
      isBuiltin: true,
    });
    reg.registerTool("myCustom", makeDefinition(), makeHandler());
    const custom = reg.getCustomTools();
    expect(custom.map((t) => t.name)).toContain("myCustom");
    expect(custom.map((t) => t.name)).not.toContain("builtinTool");
  });

  it("getDefinition() returns null for unknown tool", () => {
    const reg = new ToolRegistry();
    expect(reg.getDefinition("ghost")).toBeNull();
  });

  it("getHandler() returns null for unknown tool", () => {
    const reg = new ToolRegistry();
    expect(reg.getHandler("ghost")).toBeNull();
  });
});

// ── validateArguments() ───────────────────────────────────────────────────────

describe("ToolRegistry — validateArguments()", () => {
  it("throws for unknown tool name", () => {
    const reg = new ToolRegistry();
    expect(() => reg.validateArguments("ghost", {})).toThrow(/Unknown tool/);
  });

  it("throws for missing required parameter", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "sendEmail",
      {
        description: "Send email",
        params: {
          to: { type: "string", description: "recipient", required: true },
        },
      },
      makeHandler(),
    );
    expect(() => reg.validateArguments("sendEmail", {})).toThrow(
      /requires parameter "to"/i,
    );
  });

  it("throws for unexpected parameter", () => {
    const reg = new ToolRegistry();
    reg.registerTool("myTool", makeDefinition(), makeHandler());
    expect(() =>
      reg.validateArguments("myTool", { path: "a.ts", unknown: "x" }),
    ).toThrow(/does not accept parameter "unknown"/i);
  });

  it("passes validation for correct required params", () => {
    const reg = new ToolRegistry();
    reg.registerTool("myTool", makeDefinition(), makeHandler());
    expect(() =>
      reg.validateArguments("myTool", { path: "a.ts" }),
    ).not.toThrow();
  });

  it("validates number type — throws for non-numeric", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "countTool",
      {
        description: "Count things",
        params: {
          count: { type: "number", description: "how many", required: true },
        },
      },
      makeHandler(),
    );
    expect(() => reg.validateArguments("countTool", { count: "abc" })).toThrow(
      /must be a number/i,
    );
  });

  it("validates number min/max bounds", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "rangeTool",
      {
        description: "Range check",
        params: {
          val: {
            type: "number",
            description: "value",
            required: true,
            min: 1,
            max: 10,
          },
        },
      },
      makeHandler(),
    );
    expect(() => reg.validateArguments("rangeTool", { val: "0" })).toThrow(
      /must be >=/i,
    );
    expect(() => reg.validateArguments("rangeTool", { val: "11" })).toThrow(
      /must be <=/i,
    );
    expect(() =>
      reg.validateArguments("rangeTool", { val: "5" }),
    ).not.toThrow();
  });

  it("validates boolean type — throws for invalid value", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "flagTool",
      {
        description: "Flag",
        params: {
          enabled: { type: "boolean", description: "flag", required: true },
        },
      },
      makeHandler(),
    );
    expect(() =>
      reg.validateArguments("flagTool", { enabled: "maybe" }),
    ).toThrow(/must be boolean/i);
    expect(() =>
      reg.validateArguments("flagTool", { enabled: "true" }),
    ).not.toThrow();
    expect(() =>
      reg.validateArguments("flagTool", { enabled: "false" }),
    ).not.toThrow();
  });

  it("validates string enum — throws for value not in enum", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "modeTool",
      {
        description: "Mode selector",
        params: {
          mode: {
            type: "string",
            description: "mode",
            required: true,
            enum: ["fast", "slow"],
          },
        },
      },
      makeHandler(),
    );
    expect(() => reg.validateArguments("modeTool", { mode: "turbo" })).toThrow(
      /must be one of/i,
    );
    expect(() =>
      reg.validateArguments("modeTool", { mode: "fast" }),
    ).not.toThrow();
  });

  it("validates string minLength", () => {
    const reg = new ToolRegistry();
    reg.registerTool(
      "nameTool",
      {
        description: "Name",
        params: {
          name: {
            type: "string",
            description: "name",
            required: true,
            minLength: 3,
          },
        },
      },
      makeHandler(),
    );
    expect(() => reg.validateArguments("nameTool", { name: "ab" })).toThrow(
      /at least 3/i,
    );
    expect(() =>
      reg.validateArguments("nameTool", { name: "abc" }),
    ).not.toThrow();
  });
});
