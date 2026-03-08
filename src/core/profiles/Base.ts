// ── BaseProfile — extend this for any domain ──────────────────────────────────

import { ProfileConfig } from "..//ProfileManager";
import { TOOL_DEFINITIONS, ToolDefinition } from "../ToolEngine";

export abstract class BaseProfile {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly systemPrompt: string;
  abstract readonly planningPrompt: string;
  abstract readonly allowedTools: string[];
  abstract readonly styleRules: string[];
  abstract readonly safetyRules: string[];

  /** Build the full system prompt with all rules injected */
  buildSystemPrompt(baseContext: string = ""): string {
    const rules = [...this.styleRules, ...this.safetyRules]
      .map((r) => `- ${r}`)
      .join("\n");

    return [
      baseContext,
      this.systemPrompt,
      rules ? `BEHAVIOR RULES:\n${rules}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Filter tool definitions to only allowed tools for this profile */
  getAllowedTools(allTools?: ToolDefinition[]): ToolDefinition[] {
    const toolDefs = allTools || TOOL_DEFINITIONS;

    const builtIn = toolDefs.filter((t) => this.allowedTools.includes(t.name));

    const custom = this.allowedTools
      .filter((name) => !toolDefs.some((t) => t.name === name))
      .map(
        (name) =>
          ({
            name,
            description: `Custom tool: ${name}`,
            params: {},
          }) as ToolDefinition,
      );

    return [...builtIn, ...custom];
  }

  /** Check if a specific tool is allowed */
  isToolAllowed(toolName: string): boolean {
    return this.allowedTools.includes(toolName);
  }

  /**
   * Returns true if the agent should block file edits when the task looks like a git operation.
   * Override in profiles that never touch git (research, support) → return false
   * Override in profiles that are git-focused (devops) → return true always
   */
  blocksFileEditsOnGit(task: string): boolean {
    return /\b(commit|push|pull|merge|rebase|stash|status|diff|log)\b/i.test(
      task,
    );
  }

  /** Convert to plain config object */
  toConfig(): ProfileConfig {
    return {
      name: this.name,
      description: this.description,
      systemPrompt: this.systemPrompt,
      planningPrompt: this.planningPrompt,
      allowedTools: this.allowedTools,
      styleRules: this.styleRules,
      safetyRules: this.safetyRules,
    };
  }
}
