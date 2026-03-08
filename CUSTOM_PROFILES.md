# Custom Profiles Guide

Custom profiles allow you to define domain-specific agent behavior without creating new classes. This guide shows how to create and use custom profiles.

## What Are Profiles?

Profiles define:

- **System Prompt**: Agent personality and instructions
- **Planning Prompt**: How the agent should plan tasks
- **User Prompt**: Additional rules for every task
- **Allowed Tools**: Which tools the agent can use
- **Style Rules**: Code style and formatting preferences
- **Safety Rules**: Behavioral constraints

## Built-in Profiles

MyAI Core includes 6 built-in profiles:

- **code** (default) - General coding tasks
- **devops** - Git and deployment operations
- **research** - Read-only code analysis
- **support** - Conversational assistance
- **general** - No restrictions on tools
- **automation** - Batch operations and automation

## Creating Custom Profiles

### Basic Example: Security Auditor

```typescript
import { createAgent, CustomProfileDefinition } from "@saroj/myai-core";

const agent = createAgent({
  provider: "cerebras",
  apiKey: process.env.CEREBRAS_API_KEY,
  model: "llama3.1-8b",
  baseUrl: "https://api.cerebras.ai/v1",
  workspaceRoot: "/path/to/project",
  profile: "securityAudit", // Use custom profile
  maxTurns: 10,

  // Define the custom profile
  customProfiles: {
    securityAudit: {
      description: "Security auditor for vulnerability scanning",
      systemPrompt: `You are a security auditor specializing in code vulnerability analysis.
Your responsibilities:
- Scan code for security vulnerabilities
- Check for insecure dependencies
- Review authentication and authorization
- Identify exposed secrets or API keys
- Provide detailed security recommendations`,

      planningPrompt: `Create a read-only security audit plan:
1. Scan all source files for vulnerability patterns
2. Check for hardcoded secrets
3. Review dependency security
4. Identify access control issues
Only use readFile and listFiles - no modifications allowed.`,

      allowedTools: ["readFile", "listFiles", "searchFiles"],

      safetyRules: [
        "Never modify code - read-only analysis only",
        "Always cite specific line numbers for vulnerabilities",
        "Provide CWE references when applicable",
        "Suggest concrete fixes for each issue",
      ],

      styleRules: [
        "Output findings in severity order (critical → info)",
        "Use structured format for each finding",
        "Include risk assessment",
      ],
    },
  },

  onMessage: (msg) => {
    if (msg.type === "agentStart") console.log(`${msg.text}`);
    if (msg.type === "agentTool") console.log(`${msg.text}`);
    if (msg.type === "agentDone") console.log(`${msg.text}`);
  },

  confirm: async () => true,
});

// Run security audit
const result = await agent.run("Perform a security audit on all files");
```

## Advanced Example: Multiple Custom Profiles

```typescript
const agent = createAgent({
  provider: "cerebras",
  apiKey: process.env.CEREBRAS_API_KEY,
  model: "llama3.1-8b",
  baseUrl: "https://api.cerebras.ai/v1",
  workspaceRoot: "/path/to/project",
  profile: "compliance",

  customProfiles: {
    compliance: {
      description: "GDPR/HIPAA/PCI-DSS compliance checker",
      systemPrompt: `You are a compliance auditor checking code for data protection regulations.
Verify compliance with GDPR, HIPAA, and PCI-DSS requirements.`,
      planningPrompt: `Create a compliance audit plan:
1. Identify all data handling code
2. Map data flows
3. Review encryption and access control
4. Check third-party integrations`,
      allowedTools: ["readFile", "listFiles", "searchFiles"],
      safetyRules: [
        "Focus only on regulatory requirements",
        "Document evidence for each gap",
      ],
      styleRules: [
        "Structure by regulation",
        "Mark severity levels",
        "Include remediation timeline",
      ],
    },

    performanceOptimizer: {
      description: "Performance analysis and optimization",
      systemPrompt: `You are a performance optimization expert.
Identify bottlenecks and suggest concrete improvements.`,
      planningPrompt: `Create a performance analysis plan:
1. Profile critical paths
2. Identify hot spots
3. Analyze memory usage
4. Review database queries`,
      allowedTools: ["readFile", "listFiles", "searchFiles", "runCommand"],
      safetyRules: [
        "Benchmark before and after",
        "Consider maintainability trade-offs",
      ],
      styleRules: [
        "Include metrics and benchmarks",
        "Provide % improvement estimates",
      ],
    },
  },

  onMessage: (msg) => {
    if (msg.type === "agentStart") console.log(`${msg.text}`);
    if (msg.type === "agentTool") console.log(`${msg.text}`);
    if (msg.type === "agentDone") console.log(`${msg.text}`);
  },

  confirm: async () => true,
});

// Run compliance check
const result1 = await agent.run("Check GDPR compliance");

// Switch to performance optimizer
agent.setProfile("performanceOptimizer");
const result2 = await agent.run("Analyze performance bottlenecks");
```

## Profile Interface

```typescript
interface CustomProfileDefinition {
  // Unique profile name
  name?: string;

  // Profile description for documentation
  description?: string;

  // System prompt defining agent behavior and expertise
  systemPrompt: string;

  // Planning-specific prompt
  planningPrompt: string;

  // Optional user prompt prepended to every task
  userPrompt?: string;

  // Array of allowed tool names
  // Common tools: readFile, listFiles, editFile, createFile, runCommand, etc.
  allowedTools: string[];

  // Optional style/quality preferences
  styleRules?: string[];

  // Optional safety constraints
  safetyRules?: string[];
}
```

## Tool Restrictions

Every name in `allowedTools` must be a valid tool:

```typescript
allowedTools: [
  // File operations
  "readFile", // Read file contents
  "listFiles", // List directory contents
  "editFile", // Edit existing file
  "createFile", // Create new file
  "deleteFile", // Delete file
  "renameFile", // Rename/move file

  // Search
  "searchFiles", // Search file contents

  // Execution
  "runCommand", // Execute shell commands

  // Git
  "gitAdd", // Stage changes
  "gitCommit", // Commit changes
  "gitPush", // Push to remote

  // Done signal
  "done", // Mark task complete
];
```

## Switching Profiles at Runtime

```typescript
const agent = createAgent({
  /* ... */
});

// Switch to different profile
agent.setProfile("securityAudit");
const auditResult = await agent.run("Scan for vulnerabilities");

// Switch back to default
agent.setProfile("code");
const codeResult = await agent.run("Implement a feature");
```

## Real-World Use Cases

### 1. Security Auditor Profile

```typescript
securityAudit: {
  systemPrompt: "You are a security expert...",
  allowedTools: ["readFile", "listFiles"],
  safetyRules: [
    "Never modify code - read-only only",
    "Focus on CWE and OWASP vulnerabilities",
    "Include proof-of-concept risk",
  ],
}
```

### 2. Compliance Checker Profile

```typescript
compliance: {
  systemPrompt: "You are a compliance auditor...",
  allowedTools: ["readFile", "listFiles", "searchFiles"],
  safetyRules: [
    "Check GDPR, HIPAA, PCI-DSS compliance",
    "Document regulatory gaps",
    "Suggest remediation timeline",
  ],
}
```

### 3. Performance Optimizer Profile

```typescript
performanceOptimizer: {
  systemPrompt: "You are a performance expert...",
  allowedTools: ["readFile", "listFiles", "searchFiles", "runCommand"],
  safetyRules: [
    "Always benchmark improvements",
    "Balance performance vs maintainability",
    "Provide migration strategy",
  ],
}
```

### 4. Documentation Writer Profile

```typescript
documentationWriter: {
  systemPrompt: "You are a technical writer...",
  allowedTools: ["readFile", "listFiles", "createFile"],
  styleRules: [
    "Use markdown formatting",
    "Include code examples",
    "Add table of contents",
  ],
}
```

### 5. Refactoring Profile

```typescript
refactoring: {
  systemPrompt: "You are a refactoring expert...",
  allowedTools: ["readFile", "editFile", "createFile", "runCommand"],
  safetyRules: [
    "Maintain 100% test coverage",
    "Preserve public API",
    "No breaking changes",
  ],
}
```

## Best Practices

### 1. Clear Prompts

```typescript
// Good: specific and actionable
systemPrompt: `You are a security auditor.
- Identify OWASP Top 10 vulnerabilities
- Check for hardcoded credentials
- Verify encryption implementation
- Provide CWE references`,

//  Bad: vague
systemPrompt: "You check code for security issues"
```

### 2. Appropriate Tool Access

```typescript
// Good: read-only for security audit
allowedTools: ["readFile", "listFiles"],

//  Bad: too permissive
allowedTools: ["readFile", "editFile", "deleteFile", "runCommand"]
```

### 3. Clear Safety Rules

```typescript
// Good: specific constraints
safetyRules: [
  "Never modify files in node_modules/",
  "Never commit changes without tests",
  "Never share API keys or secrets",
],

//  Bad: vague
safetyRules: ["Be careful"]
```

## Error Handling in Custom Profiles

When a tool is not in the allowed list, the agent gets an error:

```
Tool "deleteFile" not allowed in profile "securityAudit".
Allowed: readFile, listFiles, searchFiles
```

This is handled automatically—the agent will adapt and use only allowed tools.

## Example: End-to-End Security Audit

```typescript
import { createAgent } from "@saroj/myai-core";

const agent = createAgent({
  provider: "cerebras",
  apiKey: process.env.CEREBRAS_API_KEY,
  model: "llama3.1-8b",
  baseUrl: "https://api.cerebras.ai/v1",
  workspaceRoot: "/path/to/project",
  profile: "securityAudit",

  customProfiles: {
    securityAudit: {
      description: "Security vulnerability scanner",
      systemPrompt: `You are a senior security auditor.
Your expertise:
- OWASP Top 10 vulnerabilities
- CWE (Common Weakness Enumeration)
- Secure coding practices
- Dependency security analysis
- Secret detection

Format findings as:
[CRITICAL] Vulnerability: Description
Evidence: Line numbers and code snippets
CWE: CWE-XXX
Risk: Potential impact
Fix: Recommended remediation`,

      planningPrompt: `Create a comprehensive security audit:
1. Scan all source files for known patterns
2. Check dependencies for vulnerabilities
3. Review authentication/authorization
4. Identify data exposure risks
5. Check for secrets in code
Use only readFile and listFiles.`,

      allowedTools: ["readFile", "listFiles", "searchFiles"],

      safetyRules: [
        "Never modify files",
        "Cite specific line numbers",
        "Include CWE references",
        "Provide concrete fixes",
        "Assess real-world impact",
      ],

      styleRules: [
        "Order by severity (critical → info)",
        "Include risk probability",
        "Provide effort estimate for fixes",
        "Group by vulnerability category",
      ],
    },
  },

  onMessage: (msg) => {
    if (msg.type === "agentStart") console.log(`${msg.text}`);
    if (msg.type === "agentPlan")
      console.log(`\n📋 Security Audit Plan:\n${msg.text}\n`);
    if (msg.type === "agentTool") console.log(`✓ ${msg.text}`);
    if (msg.type === "agentDone") console.log(`\n🎯 ${msg.text}`);
  },

  confirm: async () => true,
});

// Run the audit
const result = await agent.run(
  "Perform a comprehensive security audit of the entire codebase",
);

console.log(`\n📊 Results:`);
console.log(`Success: ${result.success}`);
console.log(`📝 Turns: ${result.turnsUsed}`);
console.log(` Tools: ${result.toolsUsed.join(", ")}`);
```

## See Also

- [Error Handling Guide](./ERROR_HANDLING.md)
- [Profile Manager API](./src/core/ProfileManager.ts)
- [Example: Custom Profiles](./src/example/comprehensive-client-example.ts#example18)
