/**
 * Planning logic for agent tasks
 */

import { AgentConfig, Message, CallAIResult } from "../AgentEngine";

export interface PlannerContext {
  task: string;
  projectContext: string;
  config: AgentConfig;
  overrides?: Partial<AgentConfig>;
}

export class Planner {
  private callAIFn?: (
    messages: Message[],
    provider: string,
  ) => Promise<CallAIResult>;
  private profileSystemPromptFn?: () => string;
  private profilePlanningPromptFn?: () => string;

  setCallAI(
    fn: (messages: Message[], provider: string) => Promise<CallAIResult>,
  ) {
    this.callAIFn = fn;
  }

  setProfileSystemPrompt(fn: () => string) {
    this.profileSystemPromptFn = fn;
  }

  setProfilePlanningPrompt(fn: () => string) {
    this.profilePlanningPromptFn = fn;
  }

  private _resolveSystemPrompt(
    projectContext: string,
    config: AgentConfig,
    overrides?: Partial<AgentConfig>,
  ): string {
    const cfg = overrides ? { ...config, ...overrides } : config;
    const persona =
      cfg.systemPrompt ??
      (this.profileSystemPromptFn ? this.profileSystemPromptFn() : null);
    return persona ? `${persona}\n\n${projectContext}` : projectContext;
  }

  private _resolvePlanningPrompt(
    config: AgentConfig,
    overrides?: Partial<AgentConfig>,
  ): string {
    const cfg = overrides ? { ...config, ...overrides } : config;
    if (cfg.planningPrompt) return cfg.planningPrompt;
    if (this.profilePlanningPromptFn) return this.profilePlanningPromptFn();
    return "Output a short numbered plan (max 6 steps). No explanation, no intro. Just the numbered steps.";
  }

  async plan(
    ctx: PlannerContext,
  ): Promise<{ plan: string; tokensUsed: number }> {
    if (!this.callAIFn) throw new Error("Planner: callAI not set");

    const { task, projectContext, config, overrides } = ctx;
    const { provider } = config;

    const planMessages: Message[] = [
      {
        role: "system",
        content: this._resolveSystemPrompt(projectContext, config, overrides),
      },
      {
        role: "user",
        content: `${config.userPrompt ? config.userPrompt + "\n\n" : ""}Task: "${task}"\n\n${this._resolvePlanningPrompt(config, overrides)}`,
      },
    ];

    const planResult = await this.callAIFn(planMessages, provider);
    return {
      plan: planResult.content,
      tokensUsed: planResult.usage?.total_tokens || 0,
    };
  }
}
