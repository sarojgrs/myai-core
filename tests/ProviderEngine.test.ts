/**
 * Tests routing, capability registry, adapter registration, and schema building.
 * No real HTTP calls — adapters are mocked.
 */

import { describe, it, expect, vi } from "vitest";
import { ProviderEngine } from "../src/core/ProviderEngine";
import type { ProviderAdapter } from "../src/core/providers/Types";
import type { Message } from "../src/core/AgentEngine";

// ── Mock adapter ──────────────────────────────────────────────────────────────

function makeMockAdapter(response = "mock response"): ProviderAdapter {
  return {
    call: vi.fn(async () => ({ content: response, usage: {} })),
    callWithTools: vi.fn(async () => ({
      role: "assistant" as const,
      content: null,
      tool_calls: [],
    })),
  };
}

function makeConfig() {
  return {
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://api.test.com",
  };
}

const messages: Message[] = [{ role: "user", content: "hello" }];

// ── Provider config ───────────────────────────────────────────────────────────

describe("ProviderEngine — config", () => {
  it("setProviderConfig() stores config", async () => {
    const engine = new ProviderEngine();
    const adapter = makeMockAdapter();
    engine.registerAdapter("myProvider", adapter);
    engine.setProviderConfig("myProvider", makeConfig());
    engine.setActiveProvider("myProvider");
    await engine.callAI(messages);
    expect(adapter.call).toHaveBeenCalled();
  });

  it("callAI() throws when no config set for provider", async () => {
    const engine = new ProviderEngine();
    engine.setActiveProvider("unconfigured");
    await expect(engine.callAI(messages)).rejects.toThrow(/no config/i);
  });

  it("setActiveProvider() changes active provider", () => {
    const engine = new ProviderEngine();
    engine.setActiveProvider("groq");
    expect(engine.getActiveProvider()).toBe("groq");
  });
});

// ── Adapter routing ───────────────────────────────────────────────────────────

describe("ProviderEngine — adapter routing", () => {
  it("uses registered custom adapter", async () => {
    const engine = new ProviderEngine();
    const adapter = makeMockAdapter("custom response");
    engine.registerAdapter("custom-llm", adapter);
    engine.setProviderConfig("custom-llm", makeConfig());
    engine.setActiveProvider("custom-llm");

    const result = await engine.callAI(messages);
    expect(result.content).toBe("custom response");
    expect(adapter.call).toHaveBeenCalledOnce();
  });

  it("providerOverride routes to different provider", async () => {
    const engine = new ProviderEngine();
    const adapterA = makeMockAdapter("A response");
    const adapterB = makeMockAdapter("B response");

    engine.registerAdapter("providerA", adapterA);
    engine.registerAdapter("providerB", adapterB);
    engine.setProviderConfig("providerA", makeConfig());
    engine.setProviderConfig("providerB", makeConfig());
    engine.setActiveProvider("providerA");

    const result = await engine.callAI(messages, "providerB");
    expect(result.content).toBe("B response");
    expect(adapterA.call).not.toHaveBeenCalled();
    expect(adapterB.call).toHaveBeenCalled();
  });

  it("passes AbortSignal to adapter call", async () => {
    const engine = new ProviderEngine();
    const adapter = makeMockAdapter();
    engine.registerAdapter("myProvider", adapter);
    engine.setProviderConfig("myProvider", makeConfig());
    engine.setActiveProvider("myProvider");

    const controller = new AbortController();
    await engine.callAI(messages, undefined, controller.signal);
    expect(adapter.call).toHaveBeenCalledWith(
      messages,
      expect.anything(),
      controller.signal,
    );
  });
});

// ── Capability registry ───────────────────────────────────────────────────────

describe("ProviderEngine — capabilities", () => {
  it("useNativeTools() returns true for groq", () => {
    const engine = new ProviderEngine();
    expect(engine.useNativeTools("groq")).toBe(true);
  });

  it("useNativeTools() returns false for cerebras", () => {
    const engine = new ProviderEngine();
    expect(engine.useNativeTools("cerebras")).toBe(false);
  });

  it("useNativeTools() returns false for unknown provider", () => {
    const engine = new ProviderEngine();
    expect(engine.useNativeTools("unknownXYZ")).toBe(false);
  });

  it("registerProvider() adds custom capabilities", () => {
    const engine = new ProviderEngine();
    engine.registerProvider("mistral", { nativeTools: true, chat: true });
    expect(engine.useNativeTools("mistral")).toBe(true);
    expect(engine.getCapabilities("mistral").chat).toBe(true);
  });

  it("getCapabilities() returns empty object for unknown provider", () => {
    const engine = new ProviderEngine();
    expect(engine.getCapabilities("unknown")).toEqual({});
  });
});

// ── callAIWithTools() ─────────────────────────────────────────────────────────

describe("ProviderEngine — callAIWithTools()", () => {
  it("throws when provider does not support native tools", async () => {
    const engine = new ProviderEngine();
    const adapter = makeMockAdapter();
    engine.registerAdapter("noTools", adapter);
    engine.setProviderConfig("noTools", makeConfig());
    engine.registerProvider("noTools", { nativeTools: false });
    engine.setActiveProvider("noTools");

    await expect(engine.callAIWithTools(messages, [])).rejects.toThrow(
      /does not support/i,
    );
  });

  it("calls adapter.callWithTools when provider supports native tools", async () => {
    const engine = new ProviderEngine();
    const adapter = makeMockAdapter();
    engine.registerAdapter("withTools", adapter);
    engine.setProviderConfig("withTools", makeConfig());
    engine.registerProvider("withTools", { nativeTools: true });
    engine.setActiveProvider("withTools");

    await engine.callAIWithTools(messages, []);
    expect(adapter.callWithTools).toHaveBeenCalled();
  });
});

// ── buildNativeSchemas() ──────────────────────────────────────────────────────

describe("ProviderEngine — buildNativeSchemas()", () => {
  it("converts ToolDefinition to NativeTool format", () => {
    const engine = new ProviderEngine();
    const schemas = engine.buildNativeSchemas([
      {
        name: "readFile",
        description: "Read a file",
        params: { path: "File path to read" },
      },
    ]);

    expect(schemas).toHaveLength(1);
    expect(schemas[0].type).toBe("function");
    expect(schemas[0].function.name).toBe("readFile");
    expect(schemas[0].function.parameters.properties).toHaveProperty("path");
    expect(schemas[0].function.parameters.required).toContain("path");
  });

  it("marks optional params as not required", () => {
    const engine = new ProviderEngine();
    const schemas = engine.buildNativeSchemas([
      {
        name: "editFile",
        description: "Edit a file",
        params: {
          path: "File path",
          encoding: "Encoding (optional)",
        },
      },
    ]);

    const required = schemas[0].function.parameters.required;
    expect(required).toContain("path");
    expect(required).not.toContain("encoding");
  });

  it("returns empty array for empty tools list", () => {
    const engine = new ProviderEngine();
    expect(engine.buildNativeSchemas([])).toEqual([]);
  });
});

describe("ProviderEngine — callAIStream()", () => {
  it("falls back to call() when adapter has no callStream", async () => {
    const engine = new ProviderEngine();
    const adapter = {
      call: vi.fn(async () => ({ content: "streamed response", usage: {} })),
      // no callStream
    };
    engine.registerAdapter("myProvider", adapter as any);
    engine.setProviderConfig("myProvider", {
      apiKey: "key",
      model: "model",
      baseUrl: "https://api.test.com",
    });
    engine.setActiveProvider("myProvider");

    const chunks: string[] = [];
    const result = await engine.callAIStream(
      [{ role: "user", content: "hello" }],
      undefined,
      (chunk) => chunks.push(chunk),
    );

    expect(result).toBe("streamed response");
    expect(chunks).toContain("streamed response");
    expect(adapter.call).toHaveBeenCalledOnce();
  });

  it("uses callStream when adapter supports it", async () => {
    const engine = new ProviderEngine();
    const adapter = {
      call: vi.fn(),
      callStream: vi.fn(
        async (_msgs: any, _cfg: any, onChunk: (c: string) => void) => {
          onChunk("chunk1");
          onChunk("chunk2");
          return "chunk1chunk2";
        },
      ),
    };
    engine.registerAdapter("streaming", adapter as any);
    engine.setProviderConfig("streaming", {
      apiKey: "key",
      model: "model",
      baseUrl: "https://api.test.com",
    });
    engine.setActiveProvider("streaming");

    const chunks: string[] = [];
    const result = await engine.callAIStream(
      [{ role: "user", content: "hello" }],
      undefined,
      (chunk) => chunks.push(chunk),
    );

    expect(result).toBe("chunk1chunk2");
    expect(chunks).toEqual(["chunk1", "chunk2"]);
    expect(adapter.call).not.toHaveBeenCalled();
  });
});
