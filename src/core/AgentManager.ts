/**
 * Simple multi-agent orchestrator
 *
 * Lightweight registry for multiple AgentEngine instances. Intended as a
 * convenience layer for applications that want to:
 *   - Create and name multiple agents (e.g. "coder", "reviewer", "devops")
 *   - Run tasks or pipelines on specific agents
 *   - Implement basic multi-agent flows at the app level
 *
 * This class does not impose a specific multi-agent protocol. Instead it
 * provides a small API that anyone can build higher-level patterns on top of.
 */

import type {
  AgentEngine,
  AgentResult,
  PipelineResult,
  PipelineStep,
} from "./AgentEngine";

export interface ManagedAgent {
  /** Unique identifier for this agent within the manager. */
  id: string;
  /** Human-friendly role or description (optional). */
  role?: string;
  /** Underlying AgentEngine instance. */
  agent: AgentEngine;
  // store abort function so abortAll() can actually reach each agent
  abort?: () => void;
}

export class AgentManager {
  private agents = new Map<string, ManagedAgent>();

  /**
   * Register an agent with a unique id. If an agent with the same id already
   * exists, it will be overwritten.
   *
   * Pass the abort() function returned by createAgent() so that
   * abortAll() can actually cancel running agents.
   *
   * Example:
   *   const { agent, abort } = createAgent(options);
   *   manager.registerAgent("coder", agent, "code", abort);
   */
  registerAgent(
    id: string,
    agent: AgentEngine,
    role?: string,
    abort?: () => void,
  ): void {
    this.agents.set(id, { id, role, agent, abort });
  }

  /** Remove an agent from the manager. Returns true if it existed. */
  removeAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  /** Get a managed agent by id, or undefined if not found. */
  getAgent(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  /** List all registered agents. */
  listAgents(): ManagedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Abort all registered agents.
   * Calls the abort() function stored at registration time for each agent.
   * Agents registered without an abort function are silently skipped.
   */
  abortAll(): void {
    for (const entry of this.agents.values()) {
      try {
        entry.abort?.();
      } catch (err) {
        console.error(
          `[AgentManager] abortAll: error aborting agent "${entry.id}":`,
          err,
        );
      }
    }
  }

  /**
   * Run a single task on the specified agent.
   */
  async runOnAgent(
    id: string,
    task: string,
    overrides?: Parameters<AgentEngine["run"]>[1],
  ): Promise<AgentResult> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`AgentManager: no agent registered with id "${id}"`);
    }
    return entry.agent.run(task, overrides);
  }

  /**
   * Run a pipeline on the specified agent.
   */
  async runPipelineOnAgent(
    id: string,
    steps: PipelineStep[],
  ): Promise<PipelineResult> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`AgentManager: no agent registered with id "${id}"`);
    }
    return entry.agent.runPipeline(steps);
  }

  /**
   * Broadcast the same task to all agents and collect results.
   *
   * Useful for simple comparison or fan-out patterns.
   *
   * Rejected parallel agents are no longer silently dropped.
   * Failed entries are returned with result: null and a non-null error field
   * so callers know which agents failed and why.
   */
  async broadcast(
    task: string,
    overrides?: Parameters<AgentEngine["run"]>[1],
    options: { parallel?: boolean } = {},
  ): Promise<
    { id: string; role?: string; result: AgentResult | null; error?: string }[]
  > {
    const entries = Array.from(this.agents.values());

    if (options.parallel) {
      // Isolated agents — research, comparison, fan-out
      const settled = await Promise.allSettled(
        entries.map(async (a: ManagedAgent) => ({
          id: a.id,
          role: a.role,
          result: await a.agent.run(task),
          error: undefined as string | undefined,
        })),
      );

      // return both successes AND failures so caller is never surprised
      return settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        const entry = entries[i];
        const errMsg =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(
          `[AgentManager] broadcast: agent "${entry.id}" failed:`,
          errMsg,
        );
        return { id: entry.id, role: entry.role, result: null, error: errMsg };
      });
    }

    // Sequential — shared workspace/memory (default, safe)
    const results: {
      id: string;
      role?: string;
      result: AgentResult | null;
      error?: string;
    }[] = [];
    for (const entry of entries) {
      try {
        const result = await entry.agent.run(task, overrides);
        results.push({ id: entry.id, role: entry.role, result });
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[AgentManager] broadcast: agent "${entry.id}" failed:`,
          errMsg,
        );
        results.push({
          id: entry.id,
          role: entry.role,
          result: null,
          error: errMsg,
        });
      }
    }
    return results;
  }
}
