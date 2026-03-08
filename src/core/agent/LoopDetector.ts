export class LoopDetector {
  private toolCallHistory: string[] = [];
  private maxConsecutiveSameCalls: number;

  /**
   * @param maxConsecutiveSameCalls - How many identical consecutive calls
   *   trigger a loop. Also used as the cycle-length bound for alternating
   *   loop detection. Default: 3.
   */
  constructor(maxConsecutiveSameCalls: number = 3) {
    // expose as constructor parameter instead of hardcoding 3
    this.maxConsecutiveSameCalls = maxConsecutiveSameCalls;
  }

  detectToolLoop(toolName: string, args: Record<string, unknown>): boolean {
    const signature = this.createToolSignature(toolName, args);

    this.toolCallHistory.push(signature);

    // Keep a window of maxConsecutiveSameCalls * 4 entries so we can detect
    // cycles up to maxConsecutiveSameCalls calls long without unbounded growth.
    const maxHistory = this.maxConsecutiveSameCalls * 4;
    if (this.toolCallHistory.length > maxHistory) {
      this.toolCallHistory = this.toolCallHistory.slice(-maxHistory);
    }

    // ── Check 1: N identical consecutive calls (original behaviour) ─────────
    const recentCalls = this.toolCallHistory.slice(
      -this.maxConsecutiveSameCalls,
    );
    if (
      recentCalls.length >= this.maxConsecutiveSameCalls &&
      recentCalls.every((call) => call === signature)
    ) {
      return true;
    }

    // ── Check 2:  alternating / cycling loops ────────────────────
    // Detect a repeating pattern of length cycleLen in the recent history.
    // Example: [readFile(a), editFile(a), readFile(a), editFile(a)] → cycleLen=2
    // We check cycle lengths from 2 up to maxConsecutiveSameCalls (inclusive),
    // requiring at least 2 full repetitions to be confident it's a real loop.
    const history = this.toolCallHistory;
    const minRepetitions = 2;
    for (
      let cycleLen = 2;
      cycleLen <= this.maxConsecutiveSameCalls;
      cycleLen++
    ) {
      const needed = cycleLen * minRepetitions;
      if (history.length < needed) continue;

      const tail = history.slice(-needed);
      const pattern = tail.slice(0, cycleLen);
      let isLoop = true;
      for (let rep = 1; rep < minRepetitions; rep++) {
        for (let i = 0; i < cycleLen; i++) {
          if (tail[rep * cycleLen + i] !== pattern[i]) {
            isLoop = false;
            break;
          }
        }
        if (!isLoop) break;
      }
      if (isLoop) return true;
    }

    return false;
  }

  private createToolSignature(
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    const normalizedArgs: Record<string, unknown> = {};

    const sortedKeys = Object.keys(args).sort();

    for (const key of sortedKeys) {
      const value = args[key];

      if (typeof value === "string" && value.length > 100) {
        normalizedArgs[key] = this.simpleHash(value);
      } else {
        normalizedArgs[key] = value;
      }
    }

    return `${toolName}:${JSON.stringify(normalizedArgs)}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;

    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }

    return hash.toString();
  }

  reset(): void {
    this.toolCallHistory = [];
  }
}
