/**
 * Tests loop detection, threshold behavior, reset, and signature normalization.
 * LoopDetector uses detectToolLoop() not record()/isLoop() — correct API used here.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LoopDetector } from "../src/core/agent/LoopDetector";

// ── Helpers ───────────────────────────────────────────────────────────────────

function callTimes(
  detector: LoopDetector,
  tool: string,
  args: Record<string, string>,
  n: number,
): boolean {
  let result = false;
  for (let i = 0; i < n; i++) {
    result = detector.detectToolLoop(tool, args);
  }
  return result;
}

// ── Basic detection ───────────────────────────────────────────────────────────

describe("LoopDetector — basic detection", () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  it("returns false on first call", () => {
    expect(detector.detectToolLoop("readFile", { path: "index.ts" })).toBe(
      false,
    );
  });

  it("returns false on second consecutive identical call", () => {
    detector.detectToolLoop("readFile", { path: "index.ts" });
    expect(detector.detectToolLoop("readFile", { path: "index.ts" })).toBe(
      false,
    );
  });

  it("detects loop after 3 identical consecutive calls (default threshold)", () => {
    detector.detectToolLoop("readFile", { path: "index.ts" });
    detector.detectToolLoop("readFile", { path: "index.ts" });
    const result = detector.detectToolLoop("readFile", { path: "index.ts" });
    expect(result).toBe(true);
  });

  it("different tools do not trigger loop", () => {
    detector.detectToolLoop("readFile", { path: "index.ts" });
    detector.detectToolLoop("editFile", { path: "index.ts" });
    const result = detector.detectToolLoop("readFile", { path: "index.ts" });
    expect(result).toBe(false);
  });

  it("same tool with different args does not trigger loop", () => {
    detector.detectToolLoop("readFile", { path: "a.ts" });
    detector.detectToolLoop("readFile", { path: "b.ts" });
    const result = detector.detectToolLoop("readFile", { path: "c.ts" });
    expect(result).toBe(false);
  });
});

// ── Threshold ─────────────────────────────────────────────────────────────────

describe("LoopDetector — threshold behavior", () => {
  it("detects loop exactly at threshold (3)", () => {
    const detector = new LoopDetector();
    // 2 calls — no loop yet
    detector.detectToolLoop("gitCommit", { msg: "fix" });
    expect(detector.detectToolLoop("gitCommit", { msg: "fix" })).toBe(false);
    // 3rd call — loop
    expect(detector.detectToolLoop("gitCommit", { msg: "fix" })).toBe(true);
  });

  it("continues returning true after loop threshold passed", () => {
    const detector = new LoopDetector();
    callTimes(detector, "gitCommit", { msg: "fix" }, 3);
    // 4th call — still a loop
    expect(detector.detectToolLoop("gitCommit", { msg: "fix" })).toBe(true);
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

describe("LoopDetector — reset()", () => {
  it("reset() clears detection state", () => {
    const detector = new LoopDetector();
    callTimes(detector, "readFile", { path: "index.ts" }, 3);
    expect(detector.detectToolLoop("readFile", { path: "index.ts" })).toBe(
      true,
    );

    detector.reset();
    // After reset, same calls start fresh
    expect(detector.detectToolLoop("readFile", { path: "index.ts" })).toBe(
      false,
    );
  });

  it("reset() allows fresh loop detection after reset", () => {
    const detector = new LoopDetector();
    callTimes(detector, "editFile", { path: "auth.ts" }, 3);
    detector.reset();

    // Need 3 fresh calls to trigger again
    detector.detectToolLoop("editFile", { path: "auth.ts" });
    expect(detector.detectToolLoop("editFile", { path: "auth.ts" })).toBe(
      false,
    );
    expect(detector.detectToolLoop("editFile", { path: "auth.ts" })).toBe(true);
  });
});

// ── Large content hashing ─────────────────────────────────────────────────────

describe("LoopDetector — large content normalization", () => {
  it("detects loop with large args (hashed for comparison)", () => {
    const detector = new LoopDetector();
    const largeContent = "x".repeat(200);
    detector.detectToolLoop("editFile", { content: largeContent });
    detector.detectToolLoop("editFile", { content: largeContent });
    const result = detector.detectToolLoop("editFile", {
      content: largeContent,
    });
    expect(result).toBe(true);
  });

  it("different large content does not trigger loop", () => {
    const detector = new LoopDetector();
    detector.detectToolLoop("editFile", { content: "a".repeat(200) });
    detector.detectToolLoop("editFile", { content: "b".repeat(200) });
    const result = detector.detectToolLoop("editFile", {
      content: "c".repeat(200),
    });
    expect(result).toBe(false);
  });
});

// ── Mixed call sequences ──────────────────────────────────────────────────────

describe("LoopDetector — mixed sequences", () => {
  it("interleaved different calls reset consecutive counter", () => {
    const detector = new LoopDetector();
    detector.detectToolLoop("readFile", { path: "a.ts" });
    detector.detectToolLoop("readFile", { path: "a.ts" });
    detector.detectToolLoop("editFile", { path: "a.ts" }); // breaks sequence
    // Only 1 consecutive readFile now — no loop
    expect(detector.detectToolLoop("readFile", { path: "a.ts" })).toBe(false);
  });
});
