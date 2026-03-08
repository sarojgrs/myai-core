# Error Handling Guide

Error handling in MyAI Core provides **client access and control** over how errors are managed during agent execution. This guide explains the architecture and how to use error handlers effectively.

## Purpose of Error Handling

Error handlers give clients the ability to:

1. **Detect Error Conditions** - Identify what went wrong (rate limits, timeouts, tool failures, etc.)
2. **Decide on Recovery** - Choose how to recover (retry, fallback, skip, abort, continue)
3. **Central Error Management** - Apply consistent error policies across all agents
4. **Client-Controlled Resilience** - Let the client decide acceptable risk levels
5. **Provider Failover** - Switch to backup providers automatically
6. **Tool Fallback** - Use alternative tools when primary tool fails

## Architecture Overview

```
Agent Execution
     ↓
   Error Occurs
     ↓
Error Handler.handle(ErrorContext)
     ↓
Returns ErrorAction: { type, delay, provider, message, ... }
     ↓
Agent Acts on Decision:
  • retry     → Wait, then retry
  • fallback  → Switch provider/tool, retry
  • abort     → Stop, throw error
  • skip      → Skip this tool, continue
  • continue  → Ignore error, keep going
```

## Error Handler Interface

```typescript
interface ErrorHandler {
  handle(context: ErrorContext): Promise<ErrorAction>;
}

interface ErrorContext {
  turn: number; // Which turn (1..N)
  tool?: string; // Which tool failed
  provider?: string; // Which provider failed
  error: Error; // The error object
  lastMessages?: Message[]; // Context messages
  currentTask?: string; // Current task
}

type ErrorActionType = "retry" | "fallback" | "abort" | "skip" | "continue";

interface ErrorAction {
  type: ErrorActionType;
  delay?: number; // For retry: delay in ms
  maxRetries?: number; // For retry: max attempts
  provider?: string; // For fallback: fallback provider
  tool?: string; // For fallback: fallback tool
  message?: string; // Reason for this action
}
```

## Built-in Error Handlers

### 1. DefaultErrorHandler (Most Common)

Provides sensible defaults for typical scenarios:

```typescript
import { DefaultErrorHandler } from "@saroj/myai-core";

const agent = createAgent({
  provider: "cerebras",
  apiKey: process.env.CEREBRAS_API_KEY,
  model: "llama3.1-8b",
  baseUrl: "https://api.cerebras.ai/v1",
  workspaceRoot: "/path/to/project",
  onMessage: (msg) => console.log(msg.text),
  confirm: async () => true,
});

// Create error handler with custom options
const errorHandler = new DefaultErrorHandler({
  maxRetries: 3,
  baseDelayMs: 1000,
  fallbackProvider: "groq", // If cerebras fails
});

// Wire the error handler to the agent
agent.setErrorHandler?.(errorHandler);
```

**Default Behavior:**

- **HTTP 429** (Rate Limited): Retry with exponential backoff (max 3 attempts)
- **HTTP 5xx** (Server Error): Retry with backoff
- **Timeout/Connection**: Fallback to `fallbackProvider`
- **Tool Not Allowed**: Skip tool, continue
- **Other Errors**: Abort

### 2. StrictErrorHandler

Fails fast on any error:

```typescript
import { StrictErrorHandler } from "@saroj/myai-core";

const errorHandler = new StrictErrorHandler({
  message: "Fail fast on any error",
});

// Any error → immediately abort and throw
agent.setErrorHandler?.(errorHandler);
```

**Behavior:**

- All errors → Abort immediately
- No retries or fallbacks
- Useful for CI/CD pipelines where failure is critical

### 3. ResilientErrorHandler

Retries aggressively with multiple fallbacks:

```typescript
import { ResilientErrorHandler } from "@saroj/myai-core";

const errorHandler = new ResilientErrorHandler({
  maxRetries: 5,
  backoffMultiplier: 2,
  fallbackProviders: ["groq", "openai", "cerebras"],
  fallbackTools: ["readFileSync", "readFile", "searchFiles"],
});

// All errors → Try to recover through retries and fallbacks
agent.setErrorHandler?.(errorHandler);
```

**Behavior:**

- Retries with exponential backoff (5 max attempts)
- Falls back through provider list if primary fails
- Falls back through tool list
- Only aborts after exhausting all options

## Creating Custom Error Handlers

### Example 1: Logging Error Handler

```typescript
import type { ErrorHandler, ErrorContext, ErrorAction } from "@saroj/myai-core";

class LoggingErrorHandler implements ErrorHandler {
  private logFile = "errors.log";

  async handle(context: ErrorContext): Promise<ErrorAction> {
    const timestamp = new Date().toISOString();
    const logEntry = `
[${timestamp}] Turn ${context.turn}
Tool: ${context.tool || "N/A"}
Provider: ${context.provider || "N/A"}
Error: ${context.error.message}
Stack: ${context.error.stack}
Task: ${context.currentTask || "N/A"}
---`;

    // Append to log file
    fs.appendFileSync(this.logFile, logEntry);

    // Default behavior: retry on transient errors
    if (context.error.message.includes("timeout")) {
      return { type: "retry", delay: 2000, maxRetries: 3 };
    }
    if (context.error.message.includes("429")) {
      return { type: "retry", delay: 5000, maxRetries: 2 };
    }

    // Abort on others
    return { type: "abort", message: "Error logged and aborted" };
  }
}

const agent = createAgent({
  /* ... */
});
agent.setErrorHandler?.(new LoggingErrorHandler());
```

### Example 2: Slack Notification Error Handler

```typescript
import type { ErrorHandler, ErrorContext, ErrorAction } from "@saroj/myai-core";
import axios from "axios";

class SlackNotifyErrorHandler implements ErrorHandler {
  private slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

  async handle(context: ErrorContext): Promise<ErrorAction> {
    // Send error to Slack
    await axios.post(this.slackWebhookUrl, {
      text: `🚨 Agent Error in Turn ${context.turn}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Error:* ${context.error.message}\n*Tool:* ${context.tool}\n*Task:* ${context.currentTask}`,
          },
        },
      ],
    });

    // Retry with backoff
    return {
      type: "retry",
      delay: 3000,
      maxRetries: 2,
      message: "Error notified to Slack, retrying...",
    };
  }
}

const agent = createAgent({
  /* ... */
});
agent.setErrorHandler?.(new SlackNotifyErrorHandler());
```

### Example 3: Metrics Collection Error Handler

```typescript
import type { ErrorHandler, ErrorContext, ErrorAction } from "@saroj/myai-core";

class MetricsErrorHandler implements ErrorHandler {
  private metrics = {
    errorCount: 0,
    errorsByType: new Map<string, number>(),
    errorsByTool: new Map<string, number>(),
    retryCount: 0,
    fallbackCount: 0,
  };

  async handle(context: ErrorContext): Promise<ErrorAction> {
    // Track metrics
    this.metrics.errorCount++;

    const errorType = context.error.constructor.name;
    this.metrics.errorsByType.set(
      errorType,
      (this.metrics.errorsByType.get(errorType) || 0) + 1,
    );

    if (context.tool) {
      this.metrics.errorsByTool.set(
        context.tool,
        (this.metrics.errorsByTool.get(context.tool) || 0) + 1,
      );
    }

    // Decide action
    if (this.shouldRetry(context)) {
      this.metrics.retryCount++;
      return { type: "retry", delay: 2000, maxRetries: 3 };
    }

    if (this.shouldFallback(context)) {
      this.metrics.fallbackCount++;
      return {
        type: "fallback",
        provider: "groq",
        message: "Falling back to Groq",
      };
    }

    return { type: "abort" };
  }

  private shouldRetry(context: ErrorContext): boolean {
    const msg = context.error.message.toLowerCase();
    return (
      msg.includes("timeout") || msg.includes("429") || msg.includes("503")
    );
  }

  private shouldFallback(context: ErrorContext): boolean {
    return context.error.message.includes("provider");
  }

  getMetrics() {
    return this.metrics;
  }
}

const handler = new MetricsErrorHandler();
const agent = createAgent({
  /* ... */
});
agent.setErrorHandler?.(handler);

// Later, get metrics
console.log(handler.getMetrics());
```

## Error Recovery Strategies

### 1. Retry Pattern

For transient errors (timeouts, temporary service unavailability):

```typescript
async handle(context: ErrorContext): Promise<ErrorAction> {
  if (context.error.message.includes("timeout")) {
    return {
      type: "retry",
      delay: 2000 * Math.pow(2, context.turn), // Exponential backoff
      maxRetries: 3,
      message: "Retrying after timeout...",
    };
  }
  return { type: "abort" };
}
```

### 2. Fallback Pattern

For permanent provider failures:

```typescript
async handle(context: ErrorContext): Promise<ErrorAction> {
  if (context.provider === "cerebras") {
    return {
      type: "fallback",
      provider: "groq", // Switch to Groq
      message: "Cerebras failed, switching to Groq",
    };
  }
  return { type: "abort" };
}
```

### 3. Skip Pattern

For tool failures (use different tool):

```typescript
async handle(context: ErrorContext): Promise<ErrorAction> {
  if (context.tool === "runCommand") {
    return {
      type: "skip",
      message: "runCommand failed, skipping this tool",
    };
  }
  return { type: "abort" };
}
```

### 4. Graceful Degradation

For non-critical failures:

```typescript
async handle(context: ErrorContext): Promise<ErrorAction> {
  // For read-only operations, continue even on error
  if (context.error.message.includes("permission denied")) {
    return {
      type: "continue",
      message: "Continuing despite permission error",
    };
  }
  return { type: "abort" };
}
```

## Real-World Example: Web Service Agent

```typescript
import { createAgent, DefaultErrorHandler } from "@saroj/myai-core";
import type { ErrorHandler, ErrorContext, ErrorAction } from "@saroj/myai-core";

// Custom error handler for web service context
class WebServiceErrorHandler implements ErrorHandler {
  async handle(context: ErrorContext): Promise<ErrorAction> {
    const { error, turn, tool, provider } = context;
    const msg = error.message.toLowerCase();

    // Rate limiting - be respectful
    if (msg.includes("429")) {
      const delay = 5000 * Math.pow(2, Math.min(turn, 3));
      return {
        type: "retry",
        delay,
        maxRetries: 3,
        message: "Rate limited, backing off exponentially",
      };
    }

    // Temporary service issues
    if (msg.includes("503") || msg.includes("timeout")) {
      return {
        type: "fallback",
        provider: "groq",
        message: `${provider} unavailable, using fallback`,
      };
    }

    // Tool not supported by provider
    if (msg.includes("not supported")) {
      return {
        type: "skip",
        message: `${tool} not supported, skipping`,
      };
    }

    // Authentication errors - don't retry
    if (msg.includes("unauthorized") || msg.includes("401")) {
      return {
        type: "abort",
        message: "Authentication failed - check credentials",
      };
    }

    // Unknown - try one retry then abort
    if (turn >= 3) {
      return { type: "abort", message: "Max retries exceeded" };
    }

    return {
      type: "retry",
      delay: 2000,
      maxRetries: 1,
      message: "Retrying due to unknown error",
    };
  }
}

// Setup agent
const agent = createAgent({
  provider: "cerebras",
  apiKey: process.env.CEREBRAS_API_KEY,
  model: "llama3.1-8b",
  baseUrl: "https://api.cerebras.ai/v1",
  workspaceRoot: "/path/to/project",
  onMessage: (msg) => {
    // Log all messages
    console.log(`[${msg.type}] ${msg.text}`);
  },
  confirm: async () => true,
});

// Attach custom error handler
agent.setErrorHandler?.(new WebServiceErrorHandler());

// Use agent - errors will be handled gracefully
try {
  const result = await agent.run("Create a new feature");
  console.log(`Success: ${result.success}`);
} catch (error) {
  console.error("Agent failed after error handling exhausted:", error);
}
```

## Error Handling with Custom Profiles

Combine error handling with custom profiles for domain-specific resilience:

```typescript
const agent = createAgent({
  provider: "cerebras",
  apiKey: process.env.CEREBRAS_API_KEY,
  model: "llama3.1-8b",
  baseUrl: "https://api.cerebras.ai/v1",
  workspaceRoot: "/path/to/project",
  profile: "securityAudit",

  customProfiles: {
    securityAudit: {
      description: "Security auditor",
      systemPrompt: "You are a security expert...",
      planningPrompt: "Plan security checks...",
      allowedTools: ["readFile", "listFiles"],
      safetyRules: ["Never modify code"],
    },
  },

  onMessage: (msg) => console.log(msg.text),
  confirm: async () => true,
});

// For read-only security audit, be very strict with errors
const errorHandler = new StrictErrorHandler({
  message: "Security audits must complete or fail-fast",
});

agent.setErrorHandler?.(errorHandler);
```

## Best Practices

### 1. Be Specific About Error Types

```typescript
// Good: specific error conditions
if (msg.includes("429")) {
  /* handle rate limit */
}
if (msg.includes("503")) {
  /* handle service unavail */
}
if (msg.includes("timeout")) {
  /* handle timeout */
}

//  Bad: too generic
if (error) {
  /* try to handle everything */
}
```

### 2. Use Exponential Backoff

```typescript
// Good: exponential backoff respects server health
const delay = baseDelay * Math.pow(2, Math.min(retryCount, 3));

//  Bad: linear retry hammers the server
const delay = baseDelay * retryCount;
```

### 3. Set Appropriate Retry Limits

```typescript
// Good: reasonable limits
maxRetries: 3; // Total of 4 attempts (initial + 3 retries)

//  Bad: infinite retries hang forever
maxRetries: 999;
```

### 4. Fallback to Different Providers

```typescript
// Good: diverse fallbacks
fallbackProviders: ["groq", "openai", "ollama"];

//  Bad: only one provider
fallbackProviders: ["cerebras"];
```

### 5. Log Errors for Debugging

```typescript
// Good: comprehensive error logging
async handle(context: ErrorContext): Promise<ErrorAction> {
  console.error(`Turn ${context.turn} Error:`, context.error.message);
  console.error(`Tool: ${context.tool}, Provider: ${context.provider}`);
  console.error(`Task: ${context.currentTask}`);
  // ... decide action ...
}

//  Bad: silent failures
async handle(context: ErrorContext): Promise<ErrorAction> {
  return { type: "retry" };
}
```

## Summary

Error handlers provide **client-controlled resilience**:

1. **Detect** - Identify error conditions
2. **Decide** - Choose recovery strategy (retry, fallback, skip, continue, abort)
3. **Act** - Apply the decision automatically
4. **Monitor** - Track error patterns for improvements
5. **Fallback** - Use alternative providers/tools when needed

Error handling gives clients the power to build **production-ready** agents that gracefully handle real-world failures.
