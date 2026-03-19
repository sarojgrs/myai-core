# myai-core

> TypeScript runtime for building autonomous AI agents and multi‑agent systems.

[![npm version](https://img.shields.io/npm/v/@sarojgrs/myai-core)](https://www.npmjs.com/package/@sarojgrs/myai-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org/)

`myai-core` is a **TypeScript‑first library for building autonomous AI agents** that can plan, act, remember, and collaborate.

The goal is to make AI agents **easy to embed inside real applications** without heavy frameworks.

---

# Installation

```bash
npm install @sarojgrs/myai-core
```

---

# Quick Start

```ts
import { createAgent } from "@sarojgrs/myai-core";

const { agent } = createAgent({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o-mini",
  workspaceRoot: process.cwd(),
  profile: "code",
  onMessage: (msg) => console.log(msg.text),
});

const result = await agent.run("fix all TypeScript errors in src/");

console.log(result.summary);
```

`createAgent()` returns:

```ts
{
  (agent, abort, providerEngine, profileManager, toolEngine);
}
```

---

# Core Features

## Persistent Memory

Agents use a **three‑layer memory system**.

```
Short‑term  → runtime memory
Mid‑term    → session memory
Long‑term   → persistent memory
```

Agents can remember:

- previous tasks
- files modified
- tool usage
- outcomes

Memory can persist across sessions.

---

## Profile‑Based Safety Boundaries

Agents run under **profiles** that control capabilities.

| Profile    | Purpose                  |
| ---------- | ------------------------ |
| code       | coding and file editing  |
| devops     | CI/CD workflows          |
| research   | analysis and exploration |
| support    | conversational tasks     |
| automation | batch operations         |
| general    | unrestricted             |

Profiles enforce **tool restrictions** so agents cannot perform unsafe actions.

---

## Multi‑Agent Orchestration

Agents can collaborate through an **AgentManager**.

Example workflow:

```
planner → coder → reviewer → devops
```

Example:

```ts
const plan = await manager.runOnAgent(
  "planner",
  "identify security vulnerabilities",
);

const fixes = await manager.runOnAgent("coder", plan.summary);

const review = await manager.runOnAgent("reviewer", "verify the fixes");

await manager.runOnAgent("devops", "commit and push changes");
```

---

## Pipeline Workflows

Run complex workflows across multiple providers.

```ts
await agent.runPipeline([
  { task: "analyse the codebase", provider: "openai" },
  { task: "implement fixes", provider: "codestral" },
  { task: "write tests", provider: "openai" },
  { task: "commit and push", profile: "groq" },
]);
```

Each step automatically receives context from previous steps.

---

## Pluggable LLM Providers

Supported providers include:

- Cerebras
- Groq
- OpenAI
- Gemini
- Codestral
- Ollama (local models)

Any **OpenAI‑compatible endpoint** can also be used.

Custom providers can be added easily.

---

## Checkpoint and Resume

Agent runs automatically checkpoint progress.

```
Turn 1
Turn 2
Turn 3
Crash
```

Next run:

```
Resuming from turn 3
```

This prevents wasted tokens and repeated planning.

---

# Example Use Cases

`myai-core` can power:

- AI coding assistants
- autonomous code review bots
- DevOps automation agents
- documentation generation agents
- CI/CD repair bots
- research assistants
- security auditing agents

---

# Why myai-core?

AI models are **stateless** by default.

Turning them into reliable agents requires solving several problems.

| Problem               | Solution                  |
| --------------------- | ------------------------- |
| Stateless models      | persistent memory         |
| Unsafe tool execution | profile‑based boundaries  |
| No coordination       | multi‑agent orchestration |
| Provider lock‑in      | pluggable provider system |

`myai-core` focuses on **simple architecture and real production workflows**.

---

# Architecture

The framework is composed of several independent engines.

```
createAgent()
    │
    ├── AgentEngine
    ├── MemoryEngine
    ├── ContextEngine
    ├── ProviderEngine
    ├── ProfileManager
    └── ToolEngine
```

Responsibilities:

| Engine         | Role                   |
| -------------- | ---------------------- |
| AgentEngine    | planning and execution |
| MemoryEngine   | memory management      |
| ContextEngine  | prompt construction    |
| ProviderEngine | LLM abstraction        |
| ProfileManager | capability enforcement |
| ToolEngine     | tool execution         |

Each component is **loosely coupled** using dependency injection.

---

# Comparison

| Capability                | myai-core | LangChain.js | CrewAI     |
| ------------------------- | --------- | ------------ | ---------- |
| TypeScript native         | ✅        | ⚠️ partial   | ❌         |
| Multi‑agent orchestration | ✅        | ⚠️ complex   | ✅         |
| Safety boundaries         | ✅        | ⚠️ limited   | ⚠️ limited |
| Persistent memory         | ✅        | ⚠️ limited   | ⚠️ limited |
| Checkpoint resume         | ✅        | ❌           | ❌         |
| Embeddable architecture   | ✅        | ⚠️ heavy     | ⚠️ heavy   |

---

# When to Use

Use `myai-core` if:

- you build in **TypeScript / Node.js**
- you want **multi‑agent workflows**
- you need **persistent memory**
- you want **tool safety boundaries**
- you want **flexible provider support**

---

# Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

Bug reports and feature requests are encouraged.

---

# License

Copyright (c) 2026 Saroj

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files to deal in the Software
without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies.

---

Built by **Saroj**
