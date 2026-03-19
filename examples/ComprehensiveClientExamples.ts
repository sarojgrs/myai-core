/**
 *
 * Comprehensive runnable examples for @saroj/myai-core
 
 
 * ── EXAMPLES ──────────────────────────────────────────────────────────────────
 *1.  Basic Agent— createAgent() with onMessage
 *2.  Multiple Provider switching
 *3.  Chat Mode— Stateful conversation
 *4.  Memory with Recall— MemoryEngine with strategies
 *5.  Custom Tools (ToolRegistry)— registerTool() with typed params
 *6.  Error Handling— Custom ErrorHandler implementations
 *7.  Checkpoint & Resume — Save/restore ExecutorCheckpoint
 *8.  Multi-Provider Fallback— Error-based provider switching
 *9.  Pipeline Execution— Multi-step with profiles
 *10. Loop Detection— LoopDetector in action
 *11. Lifecycle Hooks— Turn-based state + monitoring
 *12. Research Profile — Read-only analysis
 *13. Custom Profiles— Define specialized profiles
 *14. DevOps Profile— Git-only operations
 *15. Tool Validation— ToolRegistry parameter validation
 *16. Custom Error Recovery— Retry + backoff + provider fallback
 *17. Real-World: Analysis → Plan → Code— Sequential workflow with memory
 *18. Advance error context
 *19. Built in RAG tool
 *20. Custom profiles + RAG tool
 */

import * as fs from "fs";
import * as path from "path";
import {
  createAgent,
  createChat,
  MemoryEngine,
  ToolRegistry,
  AgentManager,
  DefaultErrorHandler,
  StrictErrorHandler,
  ResilientErrorHandler,
  ErrorHandler,
  ErrorContext,
  ErrorAction,
  LoggingHooks,
  TokenBudgetHooks,
  TurnLimitHooks,
  composeHooks,
  ExecutorCheckpoint,
  AgentMessage,
  ProfileManager,
  ProviderEngine,
  RAGToolkit,
} from "../src/index";
import { LoopDetector } from "../src/core/agent/LoopDetector";
import { Pool } from "pg";

const WORKSPACE = process.cwd();

function setupWorkspace() {
  if (!fs.existsSync(WORKSPACE)) {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.writeFileSync(
      path.join(WORKSPACE, "README.md"),
      "# Test Project\n\nThis is a test project.",
    );
  }
}

// ── EXAMPLE 1: Basic Agent ──────────────────────────────────────────────────

async function example1_basicAgent() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 1: Basic Agent Setup║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const { agent, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    maxTurns: 5,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentStart") console.log(` Task: ${msg.text}`);
      if (msg.type === "agentPlan") console.log(` Plan:\n${msg.text}`);
      if (msg.type === "agentTool") console.log(` ${msg.text}`);
      if (msg.type === "agentDone") console.log(`Done: ${msg.text}`);
      if (msg.type === "agentError") console.log(` Error: ${msg.text}`);
    },
    confirm: async (message: string) => {
      console.log(`Confirm: ${message}`);
      return true;
    },
  });

  try {
    const result = await agent.run("Create a simple hello world function");
    console.log(`\n Result: ${result.success ? "✓ Success" : "✗ Failed"}`);
    console.log(`Turns used: ${result.turnsUsed}`);
    console.log(`Tools used: ${result.toolsUsed.join(", ")}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 2: Multi-Provider  ────────────────────────────────────

async function example2_multiProvider() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 2: Multi-Provider║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY && !process.env.CODESTRAL_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY or CODESTRAL_API_KEY not set");
    return;
  }

  const { agent, providerEngine, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY || "",
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    providers: {
      codestral: {
        apiKey: process.env.CODESTRAL_API_KEY || "",
        model: "codestral-latest",
        baseUrl: "https://api.mistral.ai/v1",
      },
    },
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentStart") {
        const active = providerEngine.getActiveProvider();
        console.log(`🤖 Provider: ${active}`);
      }
    },
  });

  try {
    console.log("Step 1: Using Cerebras (default)");
    let result = await agent.run("Analyze code structure");
    console.log(`Result: ${result.success ? "✓" : "✗"}`);

    console.log("\nStep 2: Switching to Codestral");
    providerEngine.setActiveProvider("codestral");
    result = await agent.run("Review code style");
    console.log(`Result: ${result.success ? "✓" : "✗"}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 3: Chat Mode (Stateful) ─────────────────────────────────────────

async function example3_chatMode() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 3: Chat Mode (Stateful with History) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const { chat } = createChat({
    workspaceRoot: WORKSPACE,
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    profile: "general",
    maxHistory: 10,
  });

  try {
    chat.startSession();
    console.log("💬 Starting chat session...\n");

    const r1 = await chat.send("What is TypeScript?");
    console.log(`Q: What is TypeScript?`);
    console.log(`A: ${r1.slice(0, 80)}...\n`);

    const r2 = await chat.send("What about its benefits?");
    console.log(`Q: What about its benefits?`);
    console.log(`A: ${r2.slice(0, 80)}...\n`);

    const r3 = await chat.send("Show me an example");
    console.log(`Q: Show me an example`);
    console.log(`A: ${r3.slice(0, 80)}...\n`);

    console.log("Chat session complete");
    chat.endSession();
  } catch (err) {
    console.error("Error:", (err as Error).message);
  }
}

// ── EXAMPLE 4: Memory Engine with Recall ───────────────────────────────────

async function example4_memoryWithRecall() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 4: Memory Engine (Persistent Across Runs)║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const memory = new MemoryEngine(process.cwd());

  // Pre-populate some memories
  await memory.buildMemoryContext("pattern_1");
  await memory.buildMemoryContext("pattern_2");

  const { agent, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    memory,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentDone")
        console.log(`Turn complete: ${msg.text.slice(0, 60)}...`);
    },
  });

  try {
    console.log(" Memory-based workflow:\n");

    const userTask = "Create a utility module in src/module";
    // First task - agent learns
    console.log("[1/2] First task: Create utility module");
    const r1 = await agent.run("userTask");
    console.log(`Result: ${r1.success ? "✓" : "✗"}\n`);

    // Recall memory
    const recalled = await memory.recall(userTask, 3);
    console.log(
      `[*] Recalled: ${recalled ? "✓ Memory found" : "✗ Not found"}\n`,
    );

    // Second task - agent uses learned context
    console.log("[2/2] Second task: Improve module based on patterns");
    const r2 = await agent.run(
      "Improve the utility module following best patterns",
    );
    console.log(`Result: ${r2.success ? "✓" : "✗"}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 5: Custom Tools via ToolRegistry ───────────────────────────────

async function example5_customToolsToolRegistry() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 5: ToolRegistry + Auto Validation                ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const toolRegistry = new ToolRegistry();

  // Register chatSend tool
  toolRegistry.registerTool(
    "chatSend",
    {
      description: "Send a message to a chat channel",
      category: "integration",
      tags: ["communication", "chat"],
      params: {
        channel: {
          type: "string",
          description: "Chat channel name (e.g., #general, #dev)",
          required: true,
          pattern: "^#[a-zA-Z0-9_-]+$",
        },
        message: {
          type: "string",
          description: "Message content",
          required: true,
          minLength: 1,
          maxLength: 2000,
        },
        threadId: {
          type: "string",
          description: "Optional thread ID for replies",
          required: false,
        },
        mention: {
          type: "boolean",
          description: "Whether to mention channel members",
          required: false,
          default: false,
        },
      },
    },
    async (args, config) => {
      console.log(` [chatSend] Sending to ${args.channel}: "${args.message}"`);
      return {
        tool: "chatSend",
        success: true,
        output: `Message sent to ${args.channel} (ID: msg_${Date.now()})`,
      };
    },
  );

  // Register httpRequest tool
  toolRegistry.registerTool(
    "httpRequest",
    {
      description:
        "Use this tool to make ANY HTTP API requests. " +
        "Always prefer this over curl or runCommand " +
        "for all HTTP calls including GET, POST, PUT, DELETE.",
      category: "integration",
      tags: ["api", "http"],
      params: {
        method: {
          type: "string",
          description: "HTTP method",
          required: true,
          enum: ["GET", "POST", "PUT", "DELETE"],
        },
        url: {
          type: "string",
          description: "API endpoint URL",
          required: true,
          pattern: "^https?://",
        },
        body: {
          type: "string",
          description: "Request body (JSON)",
          required: false,
        },
      },
    },
    async (args, config) => {
      console.log(` [httpRequest] ${args.method} ${args.url}`);
      return {
        tool: "httpRequest",
        success: true,
        output: `Response: {"status": 200, "data": "ok"}`,
      };
    },
  );

  // ── Test auto-validation directly ──────────────────────────────

  console.log("\n Testing Auto-Validation:\n");

  // Test 1: Valid args → should pass
  console.log("[1] Valid chatSend args:");
  try {
    toolRegistry.validateArguments("chatSend", {
      channel: "#general",
      message: "Hello team",
    });
    console.log("Passed\n");
  } catch (err) {
    console.log(`Failed: ${(err as Error).message}\n`);
  }

  // Test 2: Missing required field → should fail
  console.log("[2] Missing required 'channel':");
  try {
    toolRegistry.validateArguments("chatSend", {
      message: "Hello team",
    });
    console.log("Passed\n");
  } catch (err) {
    console.log(`Caught: ${(err as Error).message}\n`);
  }

  // Test 3: Invalid pattern → should fail
  console.log("[3] Invalid channel pattern (no # prefix):");
  try {
    toolRegistry.validateArguments("chatSend", {
      channel: "general", // ← missing # !
      message: "Hello",
    });
    console.log("Passed\n");
  } catch (err) {
    console.log(`Caught: ${(err as Error).message}\n`);
  }

  // Test 4: Invalid enum → should fail
  console.log("[4] Invalid HTTP method enum:");
  try {
    toolRegistry.validateArguments("httpRequest", {
      method: "PATCH", // ← not in enum!
      url: "https://api.example.com",
    });
    console.log("Passed\n");
  } catch (err) {
    console.log(`Caught: ${(err as Error).message}\n`);
  }

  // Test 5: Invalid URL pattern → should fail
  console.log("[5] Invalid URL pattern:");
  try {
    toolRegistry.validateArguments("httpRequest", {
      method: "GET",
      url: "not-a-url", // ← no https://
    });
    console.log("Passed\n");
  } catch (err) {
    console.log(`Caught: ${(err as Error).message}\n`);
  }

  // Test 6: Message too long → should fail
  console.log("[6] Message exceeds maxLength:");
  try {
    toolRegistry.validateArguments("chatSend", {
      channel: "#general",
      message: "x".repeat(2001), // ← exceeds 2000!
    });
    console.log("Passed\n");
  } catch (err) {
    console.log(`Caught: ${(err as Error).message}\n`);
  }

  // ── NEW: Test agent auto-corrects on invalid tool call ──────────────

  console.log("\nTesting Agent Auto-Correction:\n");

  const { agent, abort } = createAgent({
    provider: "codestral",
    apiKey: process.env.CODESTRAL_API_KEY || "",
    model: "codestral-latest",
    baseUrl: "https://api.mistral.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "general",
    toolRegistry,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentTool") console.log(` Tool: ${msg.text}`);
      if (msg.type === "agentError") console.log(` Error: ${msg.text}`);
      if (msg.type === "agentPlan") console.log(` Plan: ${msg.text}`);
    },
  });

  try {
    console.log("Registered tools:");
    toolRegistry.getAllDefinitions().forEach((tool) => {
      console.log(`  • ${tool.name}: ${tool.description}`);
    });

    console.log("\nTask 1: Valid request");
    const r1 = await agent.run(
      "Send a message to #general saying 'Hello team'",
    );
    console.log(`Result: ${r1.success ? "✓" : "✗"}\n`);

    console.log("Task 2: Agent must self-correct");
    // Agent might try wrong method first
    // validation catches it,  agent retries
    const r2 = await agent.run(
      "Use the httpRequest tool to make a GET request " +
        "to https://api.example.com/users",
    );
    console.log(`Result: ${r2.success ? "✓" : "✗"}\n`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 6: Error Handling (Custom ErrorHandler) ──────────────────────────

async function example6_errorHandling() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 6: Error Handling (Custom Strategies)║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  // Custom error handler with retry logic
  class ExponentialBackoffHandler implements ErrorHandler {
    private retryCount = 0;
    private readonly maxRetries = 3;

    handleError(context: ErrorContext): ErrorAction {
      this.retryCount++;
      console.log(`Error in turn ${context.turn}: ${context.error.message}`);

      if (this.retryCount <= this.maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, this.retryCount - 1) * 1000;
        console.log(
          `🔄 Retry ${this.retryCount}/${this.maxRetries} (delay: ${delay}ms)`,
        );
        return {
          type: "retry",
          delay,
          maxRetries: 1,
          message: `Retry attempt ${this.retryCount}`,
        };
      }

      console.log(` Max retries exceeded, falling back to skip`);
      return {
        type: "skip",
        message: "Skipping this step due to repeated failures",
      };
    }
  }

  const { agent, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentDone") console.log(`${msg.text.slice(0, 60)}...`);
    },
  });

  try {
    console.log("Error Recovery Strategies:\n");

    console.log("[1] DefaultErrorHandler (retry 3x with 1s delay)");
    const h1 = new DefaultErrorHandler({
      maxRetries: 3,
      delayMs: 1000,
    });
    const action1 = h1.handleError({
      turn: 1,
      error: new Error("Tool not found"),
      tool: "readFile",
      provider: "cerebras",
      currentTask: "read file",
    });
    console.log(` Action: ${action1.type}, delay: ${action1.delay}ms\n`);

    console.log("[2] StrictErrorHandler (abort immediately)");
    const h2 = new StrictErrorHandler();
    const action2 = h2.handleError({
      turn: 1,
      error: new Error("API rate limit"),
      provider: "cerebras",
      currentTask: "make API call",
    });
    console.log(` Action: ${action2.type}\n`);

    console.log("[3] ResilientErrorHandler (continue despite error)");
    const h3 = new ResilientErrorHandler();
    const action3 = h3.handleError({
      turn: 1,
      error: new Error("Tool execution failed"),
      tool: "runCommand",
      currentTask: "execute script",
    });
    console.log(` Action: ${action3.type}\n`);

    console.log("[4] ExponentialBackoffHandler (custom)");
    const h4 = new ExponentialBackoffHandler();
    const action4 = h4.handleError({
      turn: 1,
      error: new Error("Connection timeout"),
      provider: "cerebras",
      currentTask: "call AI",
    });
    console.log(` Action: ${action4.type}, delay: ${action4.delay}ms\n`);

    const result = await agent.run("Create a test file");
    console.log(`Task result: ${result.success ? "✓" : "✗"}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 7: Checkpoint & Resume ──────────────────────────────────────────

async function example7_checkpointResume() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 7: Checkpoint & Resume (Interruption Handling) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const { agent, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    maxTurns: 10,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentTool")
        console.log(` Turn ${msg.turn}: ${msg.text.slice(0, 50)}`);
    },
  });

  try {
    console.log("📌 Checkpoint Management:\n");

    // Simulate a long-running task
    const userTask = "Create a comprehensive multi-file module with tests";
    const taskPromise = agent.run(userTask);

    // Simulate interrupt after 100ms
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log("Simulating interrupt...");

    // In real scenario, would call: agent.getCheckpoint(task)
    // For demo, we'll just complete the task
    const result = await taskPromise;

    console.log("\n Execution Summary:");
    console.log(`Status: ${result.success ? "✓ Complete" : "✗ Interrupted"}`);
    console.log(`Turns: ${result.turnsUsed}/10`);
    console.log(`Tools: ${result.toolsUsed.join(", ")}`);
    console.log(`Files changed: ${result.filesChanged.length}`);

    // In production:
    const checkpoint: ExecutorCheckpoint | undefined =
      await agent.getCheckpoint(userTask);
    // // ... save checkpoint to disk/DB ...
    // // Later:
    if (checkpoint) {
      const resume = await agent.resumeFromCheckpoint(checkpoint);
    }
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 8: Provider Fallback on Error ──────────────────────────────────

async function example8_providerFallback() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 8: Provider Fallback (Error-Based Switching)║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  // Custom handler that triggers provider switch
  class ProviderFallbackHandler implements ErrorHandler {
    private providers = ["cerebras", "groq", "ollama"];
    private currentIndex = 0;

    handleError(context: ErrorContext): ErrorAction {
      if (this.currentIndex < this.providers.length - 1) {
        const nextProvider = this.providers[this.currentIndex + 1];
        this.currentIndex++;
        console.log(`${context.provider} failed, switching to ${nextProvider}`);
        return {
          type: "fallback",
          provider: nextProvider,
          delay: 1000,
          message: `Falling back to ${nextProvider}`,
        };
      }
      return { type: "abort", message: "All providers exhausted" };
    }
  }

  const { agent, providerEngine, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    providers: {
      codestral: {
        apiKey: process.env.CODESTRAL_API_KEY || "",
        model: "codestral-latest",
        baseUrl: "https://api.mistral.ai/v1",
      },
      groq: {
        apiKey: process.env.GROQ_API_KEY || "",
        model: "llama-3.1-8b-instant",
        baseUrl: "https://api.groq.com/openai/v1",
      },
    },
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentStart") {
        const active = providerEngine.getActiveProvider();
        console.log(`🤖 Using: ${active}`);
      }
    },
  });

  try {
    console.log("🔄 Provider Fallback Strategy:\n");

    const handler = new ProviderFallbackHandler();
    const errorCtx: ErrorContext = {
      turn: 1,
      error: new Error("Rate limit exceeded"),
      provider: "cerebras",
    };

    console.log("[1] Primary fails → Fallback to Codestral");
    const action1 = handler.handleError(errorCtx);
    console.log(` Action: ${action1.type} to ${action1.provider}\n`);

    console.log("[2] Codestral fails → Fallback to Gorq");
    const action2 = handler.handleError({
      ...errorCtx,
      provider: "groq",
    });
    console.log(` Action: ${action2.type} to ${action2.provider}\n`);

    console.log("[3] All providers exhausted → Abort");
    const action3 = handler.handleError({
      ...errorCtx,
      provider: "gorq",
    });
    console.log(` Action: ${action3.type}\n`);

    const result = await agent.run("Analyze code");
    console.log(`Task result: ${result.success ? "✓" : "✗"}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 9: Pipeline Execution ──────────────────────────────────────────

async function example9_pipelineExecution() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 9: Pipeline (Multi-Step with Provider Overrides)║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY || !process.env.GROQ_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY or GROQ_API_KEY not set");
    return;
  }

  const { agent, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    providers: {
      groq: {
        apiKey: process.env.GROQ_API_KEY,
        model: "llama-3.1-8b-instant",
        baseUrl: "https://api.groq.com/openai/v1",
      },
    },
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "pipelineStart")
        console.log(`\n🔀 ${msg.text} starting...`);
      if (msg.type === "pipelineStep") console.log(`▶ ${msg.text}`);
      if (msg.type === "pipelineStepDone") console.log(`${msg.text}`);
      if (msg.type === "pipelineDone") console.log(`🎉 ${msg.text}`);
    },
  });

  try {
    console.log(" Pipeline: Analysis → Planning → Implementation\n");

    // Note: runPipeline is a method on agent
    // const pipelineSteps = [
    //{ task: "Analyze code structure", provider: "cerebras" },
    //{ task: "Create improvement plan", provider: "cerebras" },
    //{ task: "Implement improvements", provider: "groq", profile: "code" },
    //{ task: "Review for quality", provider: "cerebras", profile: "research" }
    // ];
    // const result = await agent.runPipeline(pipelineSteps);

    // For now, simulate with sequential runs
    const r1 = await agent.run("Analyze project structure");
    console.log(`\n[1] Analysis: ${r1.success ? "✓" : "✗"}`);

    const r2 = await agent.run("Create improvement plan");
    console.log(`[2] Planning: ${r2.success ? "✓" : "✗"}`);

    const r3 = await agent.run("Implement improvements");
    console.log(`[3] Implementation: ${r3.success ? "✓" : "✗"}`);

    console.log(
      `\n Total turns: ${r1.turnsUsed + r2.turnsUsed + r3.turnsUsed}`,
    );
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 10: Loop Detection ──────────────────────────────────────────────

async function example10_loopDetection() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 10: Loop Detection (Prevent Infinite Loops) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const loopDetector = new LoopDetector(3); // Max 3 consecutive identical calls

  console.log("🔄 Testing Loop Detection:\n");

  // Test 1: Identical consecutive calls
  console.log("[1] Identical consecutive calls:");
  let isLoop = loopDetector.detectToolLoop("readFile", { path: "main.ts" });
  console.log(`Call 1: Loop detected = ${isLoop}`);

  isLoop = loopDetector.detectToolLoop("readFile", { path: "main.ts" });
  console.log(`Call 2: Loop detected = ${isLoop}`);

  isLoop = loopDetector.detectToolLoop("readFile", { path: "main.ts" });
  console.log(`Call 3: Loop detected = ${isLoop} ← Triggers at threshold\n`);

  loopDetector.reset();

  // Test 2: Alternating pattern loop
  console.log(
    "[2] Alternating pattern (readFile → editFile → readFile → editFile):",
  );
  loopDetector.detectToolLoop("readFile", { path: "main.ts" });
  loopDetector.detectToolLoop("editFile", { path: "main.ts", content: "..." });
  loopDetector.detectToolLoop("readFile", { path: "main.ts" });
  isLoop = loopDetector.detectToolLoop("editFile", {
    path: "main.ts",
    content: "...",
  });
  console.log(`Loop detected = ${isLoop} ← Detects cycling pattern\n`);

  loopDetector.reset();

  // Test 3: Different tools (no loop)
  console.log("[3] Different tools (no loop):");
  loopDetector.detectToolLoop("readFile", { path: "main.ts" });
  loopDetector.detectToolLoop("editFile", { path: "main.ts", content: "new" });
  isLoop = loopDetector.detectToolLoop("searchFiles", { query: "import" });
  console.log(`Loop detected = ${isLoop} ← No pattern, safe to continue\n`);

  console.log("Loop detection working correctly");
}

// ── EXAMPLE 11: Lifecycle Hooks ─────────────────────────────────────────────

async function example11_lifecycleHooks() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 11: Lifecycle Hooks (Turn-Based Monitoring) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const hooks = composeHooks(
    new LoggingHooks(),
    new TokenBudgetHooks({ maxTokens: 10000 }),
    new TurnLimitHooks(2),
  );

  const { agent, abort } = createAgent({
    provider: "cerebras",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama-3.1-8b",
    baseUrl: "https://api.cerebras.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    hooks,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentDone") console.log(`${msg.text.slice(0, 50)}`);
    },
  });

  try {
    console.log(" Hooks Configuration:");
    console.log("• LoggingHooks: Log every turn");
    console.log("• TokenBudgetHooks: Max 10,000 tokens");
    console.log("• TurnLimitHooks: Max 3 turns\n");

    const result = await agent.run("Analyze and improve code");

    console.log("\n📈 Execution Summary:");
    console.log(`Turns used: ${result.turnsUsed}/3 (limited)`);
    console.log(`Success: ${result.success ? "✓" : "✗"}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 12: Research Profile (Read-Only) ───────────────────────────────

async function example12_researchProfile() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 12: Research Profile (Read-Only Analysis)║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const { agent, abort } = createAgent({
    // provider: "cerebras",
    // apiKey: process.env.CEREBRAS_API_KEY,
    // model: "llama-3.1-8b",
    // baseUrl: "https://api.cerebras.ai/v1",
    provider: "codestral",
    apiKey: process.env.CODESTRAL_API_KEY || "",
    model: "codestral-latest",
    baseUrl: "https://api.mistral.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "research", // Read-only
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentTool") console.log(` ${msg.text}`);
    },
  });

  try {
    console.log(" Research Profile (Read-Only):");
    console.log("Allowed tools: readFile, listFiles, searchFiles");
    console.log("Blocked tools: editFile, deleteFile, runCommand\n");

    const result = await agent.run(
      "Analyze code structure and identify patterns",
    );
    console.log(
      `\nResult: ${result.success ? "✓ Analysis complete" : "✗ Failed"}`,
    );
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 13: Custom Profiles ─────────────────────────────────────────────

async function example13_customProfiles() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 13: Custom Profiles (Specialized Workflows) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const { agent, abort } = createAgent({
    provider: "codestral",
    apiKey: process.env.CODESTRAL_API_KEY || "",
    model: "codestral-latest",
    baseUrl: "https://api.mistral.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "securityAudit",
    customProfiles: {
      securityAudit: {
        description: "Read-only security vulnerability scanning",
        systemPrompt:
          "You are a security auditor. Analyze code for vulnerabilities, hardcoded secrets, and security issues.",
        planningPrompt:
          "Create a security audit plan: scan for vulnerabilities, check for hardcoded credentials, review access control.",
        allowedTools: ["readFile", "listFiles", "searchFiles"],
        safetyRules: [
          "Never modify files",
          "Always reference specific lines with issues",
        ],
      },
      testing: {
        description: "Write and run tests",
        systemPrompt:
          "You are a testing expert. Create comprehensive test suites and run tests.",
        planningPrompt:
          "Plan test strategy: unit tests, integration tests, edge cases.",
        allowedTools: ["readFile", "editFile", "runCommand"],
        safetyRules: ["Always run tests before committing"],
      },
    },
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentDone") console.log(`${msg.text.slice(0, 50)}`);
    },
  });

  try {
    console.log("Custom Profile Workflow:\n");

    console.log("[1] Security Audit (read-only)");
    const r1 = await agent.run("Scan for security vulnerabilities");
    console.log(` Result: ${r1.success ? "✓" : "✗"}`);

    console.log("\n[2] Switch to Testing");
    agent.setProfile("testing");
    const r2 = await agent.run("Create unit tests for main module");
    console.log(` Result: ${r2.success ? "✓" : "✗"}`);

    console.log("\nProfile switching works correctly");
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 14: DevOps Profile (Git-Only) ───────────────────────────────────

async function example14_devopsProfile() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 14: DevOps Profile (Git-Only Operations) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const { agent, abort } = createAgent({
    provider: "codestral",
    apiKey: process.env.CODESTRAL_API_KEY || "",
    model: "codestral-latest",
    baseUrl: "https://api.mistral.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "devops", // Git-only
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentTool") console.log(` ${msg.text}`);
    },
  });

  try {
    console.log(" DevOps Profile (Git-Only):");
    console.log("Allowed: getGitStatus, getGitLog, runCommand");
    console.log("Blocked: editFile, deleteFile, readFile\n");

    const result = await agent.run("Check git status and recent commits");
    console.log(`\nResult: ${result.success ? "✓ Complete" : "✗ Failed"}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 15: Tool Parameter Validation ───────────────────────────────────

async function example15_toolValidation() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 15: Tool Validation (ToolRegistry Parameters)║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const toolRegistry = new ToolRegistry();

  // Register email tool with strict parameter validation
  toolRegistry.registerTool(
    "sendEmail",
    {
      description: "Send email with validation",
      params: {
        to: {
          type: "string",
          description: "Email address",
          required: true,
          pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
        },
        subject: {
          type: "string",
          description: "Subject line",
          required: true,
          minLength: 5,
          maxLength: 100,
        },
        body: {
          type: "string",
          description: "Email body",
          required: true,
          minLength: 10,
        },
        priority: {
          type: "string",
          description: "Email priority",
          required: false,
          enum: ["low", "normal", "high", "urgent"],
        },
      },
    },
    async (args, config) => {
      return {
        tool: "sendEmail",
        success: true,
        output: `Email sent to ${args.to}`,
      };
    },
  );

  console.log("Email Tool Validation Tests:\n");

  // Test 1: Valid arguments
  console.log("[1] Valid email:");
  try {
    toolRegistry.validateArguments("sendEmail", {
      to: "user@example.com",
      subject: "Hello World",
      body: "This is a test email",
      priority: "normal",
    });
    console.log(" ✓ Validation passed\n");
  } catch (err) {
    console.log(` ✗ ${(err as Error).message}\n`);
  }

  // Test 2: Invalid email pattern
  console.log("[2] Invalid email pattern:");
  try {
    toolRegistry.validateArguments("sendEmail", {
      to: "invalid-email",
      subject: "Hello",
      body: "Test",
    });
    console.log(" ✓ Validation passed\n");
  } catch (err) {
    console.log(` ✓ Caught error: ${(err as Error).message}\n`);
  }

  // Test 3: Subject too short
  console.log("[3] Subject too short:");
  try {
    toolRegistry.validateArguments("sendEmail", {
      to: "user@example.com",
      subject: "Hi",
      body: "Test message body",
    });
    console.log(" ✓ Validation passed\n");
  } catch (err) {
    console.log(` ✓ Caught error: ${(err as Error).message}\n`);
  }

  // Test 4: Invalid priority enum
  console.log("[4] Invalid priority enum:");
  try {
    toolRegistry.validateArguments("sendEmail", {
      to: "user@example.com",
      subject: "Hello World",
      body: "Test message",
      priority: "critical",
    });
    console.log(" ✓ Validation passed\n");
  } catch (err) {
    console.log(` ✓ Caught error: ${(err as Error).message}\n`);
  }

  console.log("Tool validation working correctly");
}

// ── EXAMPLE 16: Custom Error Recovery ───────────────────────────────────────

async function example16_customErrorRecovery() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 16: Custom Error Recovery (Retry + Fallback)║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  class AdaptiveErrorHandler implements ErrorHandler {
    private toolFailures: Map<string, number> = new Map();
    private readonly maxFailuresPerTool = 2;

    handleError(context: ErrorContext): ErrorAction {
      const tool = context.tool || "unknown";
      const failures = (this.toolFailures.get(tool) || 0) + 1;
      this.toolFailures.set(tool, failures);

      console.log(
        `Tool '${tool}' failed (${failures}/${this.maxFailuresPerTool})`,
      );

      if (failures < this.maxFailuresPerTool) {
        return {
          type: "retry",
          delay: 500 * failures,
          message: `Retry with backoff`,
        };
      } else if (context.provider !== "groq") {
        return {
          type: "fallback",
          provider: "groq",
          message: "Switching provider after repeated failures",
        };
      } else {
        return {
          type: "skip",
          message: "Skipping this tool, continuing with other strategies",
        };
      }
    }
  }

  console.log(" Adaptive Error Recovery:\n");

  const handler = new AdaptiveErrorHandler();
  const errorCtx: ErrorContext = {
    turn: 1,
    error: new Error("Timeout"),
    tool: "readFile",
    provider: "cerebras",
  };

  console.log("[1] First failure → Retry");
  const action1 = handler.handleError(errorCtx);
  console.log(` Action: ${action1.type}, delay: ${action1.delay}ms\n`);

  console.log("[2] Second failure → Provider fallback");
  const action2 = handler.handleError(errorCtx);
  console.log(` Action: ${action2.type} to ${action2.provider}\n`);

  console.log("[3] Tool exhausted → Skip");
  const action3 = handler.handleError(errorCtx);
  console.log(` Action: ${action3.type}\n`);

  console.log("Adaptive error recovery working");
}

// ── EXAMPLE 17: Real-World Workflow ─────────────────────────────────────────

async function example17_realWorldWorkflow() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 17: Real-World (Analysis → Planning → Code) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const memory = new MemoryEngine(process.cwd());

  const { agent, abort } = createAgent({
    provider: "codestral",
    apiKey: process.env.CODESTRAL_API_KEY || "",
    model: "codestral-latest",
    baseUrl: "https://api.mistral.ai/v1",
    workspaceRoot: WORKSPACE,
    profile: "code",
    memory,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentDone") console.log(`${msg.text.slice(0, 50)}...`);
    },
  });

  try {
    console.log("Real-World Development Workflow:\n");

    console.log("[Phase 1] Analysis");
    const analysis = await agent.run("Analyze current project structure");
    console.log(`Status: ${analysis.success ? "✓" : "✗"}\n`);

    console.log("[Phase 2] Planning");
    const planning = await agent.run(
      "Create a detailed improvement plan based on analysis",
    );
    console.log(`Status: ${planning.success ? "✓" : "✗"}\n`);

    console.log("[Phase 3] Implementation");
    const implementation = await agent.run(
      "Implement the first improvement from the plan",
    );
    console.log(`Status: ${implementation.success ? "✓" : "✗"}\n`);

    console.log("[Phase 4] Review");
    agent.setProfile("research");
    const review = await agent.run(
      "Review the implemented changes for quality",
    );
    console.log(`Status: ${review.success ? "✓" : "✗"}\n`);

    const totalTurns =
      analysis.turnsUsed +
      planning.turnsUsed +
      implementation.turnsUsed +
      review.turnsUsed;
    console.log(`Total turns: ${totalTurns}`);
    console.log(
      `Total tools used: ${
        [
          ...new Set([
            ...analysis.toolsUsed,
            ...planning.toolsUsed,
            ...implementation.toolsUsed,
            ...review.toolsUsed,
          ]),
        ].length
      }`,
    );
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    abort();
  }
}

// ── EXAMPLE 18: Advanced Error Context ──────────────────────────────────────

async function example18_advancedErrorContext() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 18: Advanced Error Context (Full Diagnosis) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  console.log("Comprehensive Error Diagnostics:\n");

  const errorCtx: ErrorContext = {
    turn: 3,
    error: new Error("Tool execution failed: file not found"),
    tool: "readFile",
    provider: "cerebras",
    currentTask: "Analyze main.ts",
    lastMessages: [
      { role: "system", content: "You are a code analyst" },
      { role: "user", content: "Analyze main.ts" },
      { role: "assistant", content: "I'll analyze main.ts for you" },
    ],
  };

  console.log("[Turn Information]");
  console.log(`Turn: ${errorCtx.turn}`);
  console.log(`Task: ${errorCtx.currentTask}\n`);

  console.log("[Tool Information]");
  console.log(`Tool: ${errorCtx.tool}`);
  console.log(`Provider: ${errorCtx.provider}\n`);

  console.log("[Error Details]");
  console.log(`Error: ${errorCtx.error.message}`);
  console.log(`Stack: ${errorCtx.error.stack?.split("\n")[0]}\n`);

  console.log("[Message Context]");
  console.log(`Recent messages: ${errorCtx.lastMessages?.length || 0}`);
  errorCtx.lastMessages?.slice(-2).forEach((msg) => {
    console.log(`${msg.role}: ${msg.content.slice(0, 40)}...`);
  });

  console.log("\nFull diagnostic context available for error handling");
}
async function example19_usingRagToolKit() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ Example 19: Using RAG Toolkit                            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const rag = RAGToolkit.create({
    embedding: {
      provider: "ollama",
      model: "bge-m3",
      url: "http://172.27.33.69:11434",
    },
    vectorDb: {
      provider: "pgvector",
      searchFn: async (embedding, limit, threshold) => {
        const result = await pool.query(
          `
    SELECT id, title,
      1 - (embedding <=> $1::vector) as similarity
    FROM job
    WHERE 1 - (embedding <=> $1::vector) > $2::float
    AND embedding IS NOT NULL
    ORDER BY similarity DESC
    LIMIT $3::int
    `,
          [`[${embedding.join(",")}]`, threshold, limit],
        );
        return result.rows;
      },
    },
  });

  if (!process.env.CODESTRAL_API_KEY) {
    console.log("Skipping: CODESTRAL_API_KEY not set");
    return;
  }

  const { agent } = createAgent({
    provider: "codestral",
    apiKey: process.env.CODESTRAL_API_KEY || "",
    model: "codestral-latest",
    baseUrl: "https://api.mistral.ai/v1",
    workspaceRoot: WORKSPACE,
    // profile: "rag"  ← auto detected! ✅
    toolRegistry: rag.registry,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentStart") console.log(` Task: ${msg.text}`);
      if (msg.type === "agentPlan") console.log(` Plan:\n${msg.text}`);
      if (msg.type === "agentTool") console.log(` Tool: ${msg.text}`);
      if (msg.type === "agentDone") console.log(` Done: ${msg.text}`);
      if (msg.type === "agentError") console.log(` Error: ${msg.text}`);
    },
  });

  try {
    const result = await agent.run("Find software related jobs");
    console.log(`\nSuccess: ${result.success ? "✓" : "✗"}`);
    console.log(`Turns: ${result.turnsUsed}`);
    console.log(`Tools: ${result.toolsUsed.join(", ")}`);
    console.log(`Summary: ${result.summary}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    await pool.end();
  }
}
async function example20customProfileWithRagToolKit() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log(
    "║ Example 20: Custom Profile with RAG Toolkit                            ║",
  );
  console.log("╚══════════════════════════════════════════════════════════╝");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const rag = RAGToolkit.create({
    embedding: {
      provider: "ollama",
      model: "bge-m3",
      url: "http://172.27.33.69:11434",
    },
    vectorDb: {
      provider: "pgvector",
      searchFn: async (embedding, limit, threshold) => {
        const result = await pool.query(
          `
    SELECT id, title,
      1 - (embedding <=> $1::vector) as similarity
    FROM job
    WHERE 1 - (embedding <=> $1::vector) > $2::float
    AND embedding IS NOT NULL
    ORDER BY similarity DESC
    LIMIT $3::int
    `,
          [`[${embedding.join(",")}]`, threshold, limit],
        );
        return result.rows;
      },
    },
  });

  if (!process.env.CEREBRAS_API_KEY) {
    console.log("Skipping: CEREBRAS_API_KEY not set");
    return;
  }

  const { agent } = createAgent({
    provider: "groq",
    apiKey: process.env.GROQ_API_KEY || "",
    model: "llama-3.1-8b-instant",
    baseUrl: "https://api.groq.com/openai/v1",

    workspaceRoot: WORKSPACE,

    // Custom profile!
    profile: "jobSearch",
    customProfiles: {
      jobSearch: {
        systemPrompt:
          "You are a job search assistant. " +
          "You have ONE tool available: vectorSearch. " +
          "ALWAYS respond with ONLY this exact JSON format: " +
          '[{"tool":"vectorSearch","args":{"query":"YOUR QUERY HERE"}}]' +
          "NOTHING else. No code. No explanation. Just JSON.",
        planningPrompt:
          "Respond with ONLY this JSON: " +
          '[{"tool":"vectorSearch","args":{"query":"<user query>"}}]',
        allowedTools: ["vectorSearch", "done"],
        safetyRules: [
          "Always respond with JSON array only",
          "Never write code",
          "Never explain",
        ],
      },
    },
    toolRegistry: rag.registry,
    onMessage: (msg: AgentMessage) => {
      if (msg.type === "agentStart") console.log(` Task: ${msg.text}`);
      if (msg.type === "agentPlan") console.log(` Plan:\n${msg.text}`);
      if (msg.type === "agentTool") console.log(` Tool: ${msg.text}`);
      if (msg.type === "agentDone") console.log(` Done: ${msg.text}`);
      if (msg.type === "agentError") console.log(` Error: ${msg.text}`);
    },
  });

  try {
    const result = await agent.run("Find software related jobs");
    console.log(`\nSuccess: ${result.success ? "✓" : "✗"}`);
    console.log(`Turns: ${result.turnsUsed}`);
    console.log(`Tools: ${result.toolsUsed.join(", ")}`);
    console.log(`Summary: ${result.summary}`);
  } catch (err) {
    console.error("Error:", (err as Error).message);
  } finally {
    await pool.end();
  }
}

// ── MAIN ENTRY POINT ────────────────────────────────────────────────────────

// ── Entry Point ───────────────────────────────────────────────────────────────
//
// Usage:
//npx ts-node examples/ComprehensiveClientExamples [example_number]
//
//npx ts-node examples/ComprehensiveClientExamples 1 → run example 1
//npx ts-node examples/ComprehensiveClientExamples 0→ run all examples
//npx ts-node examples/ComprehensiveClientExamples→ defaults to example 1

const EXAMPLES = [
  { num: 1, name: "Basic Agent", fn: example1_basicAgent },
  { num: 2, name: "Multi-Provider", fn: example2_multiProvider },
  { num: 3, name: "Chat Mode", fn: example3_chatMode },
  { num: 4, name: "Memory with Recall", fn: example4_memoryWithRecall },
  { num: 5, name: "Custom Tools", fn: example5_customToolsToolRegistry },
  { num: 6, name: "Error Handling", fn: example6_errorHandling },
  { num: 7, name: "Checkpoint & Resume", fn: example7_checkpointResume },
  { num: 8, name: "Provider Fallback", fn: example8_providerFallback },
  { num: 9, name: "Pipeline Execution", fn: example9_pipelineExecution },
  { num: 10, name: "Loop Detection", fn: example10_loopDetection },
  { num: 11, name: "Lifecycle Hooks", fn: example11_lifecycleHooks },
  { num: 12, name: "Research Profile", fn: example12_researchProfile },
  { num: 13, name: "Custom Profiles", fn: example13_customProfiles },
  { num: 14, name: "DevOps Profile", fn: example14_devopsProfile },
  { num: 15, name: "Tool Validation", fn: example15_toolValidation },
  { num: 16, name: "Error Recovery", fn: example16_customErrorRecovery },
  { num: 17, name: "Real-World Workflow", fn: example17_realWorldWorkflow },
  { num: 18, name: "Error Context", fn: example18_advancedErrorContext },
  { num: 19, name: "Rag Toolkit", fn: example19_usingRagToolKit },
  { num: 20, name: "Rag Toolkit", fn: example20customProfileWithRagToolKit },
];

async function main() {
  console.log("\n" + "=".repeat(80));
  console.log(" @saroj/myai-core EXAMPLES");
  console.log("=".repeat(80));

  setupWorkspace();

  EXAMPLES.forEach((ex) => console.log(`${ex.num}. ${ex.name}`));
  console.log("0. Run all");

  const exampleNum = process.argv[2] ? parseInt(process.argv[2]) : 1;

  if (exampleNum === 0) {
    for (const ex of EXAMPLES) {
      try {
        await ex.fn();
      } catch (err) {
        console.error(`Example ${ex.num} failed:`, (err as Error).message);
      }
    }
  } else {
    const example = EXAMPLES.find((ex) => ex.num === exampleNum);
    if (example) await example.fn();
  }
}

main().catch(console.error);
