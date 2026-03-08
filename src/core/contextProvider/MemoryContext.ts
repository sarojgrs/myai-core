/**
 * Wraps MemoryEngine as a ContextProvider so it plugs into ContextEngine.
 * Recalls relevant past tasks and learned preferences for the current task.
 */

import { BaseContextProvider } from "./Base";
import { MemoryEngine } from "../MemoryEngine";

export class MemoryContextProvider extends BaseContextProvider {
  readonly name = "memory";

  private memory: MemoryEngine;

  constructor(memory: MemoryEngine) {
    super();
    this.memory = memory;
  }

  async buildContext(task: string): Promise<string> {
    if (!task) return "";
    return this.memory.buildMemoryContext(task) ?? "";
  }
}
