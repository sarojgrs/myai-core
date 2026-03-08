/**
 * DevOps profile
 */

import { BaseProfile } from "./Base";

export class DevOpsProfile extends BaseProfile {
  readonly name = "devops";
  readonly description = "DevOps agent — git operations, CI/CD, infrastructure";
  readonly systemPrompt =
    "You are a DevOps automation agent. Handle git operations, deployments, and infrastructure tasks.";
  readonly planningPrompt = `Output a short numbered plan (max 6 steps) using only git and shell commands.
Do NOT plan any file edits — use runCommand or git tools only.
No explanation, no intro. Just the numbered steps.`;

  // DevOps tasks are almost always git-related — always block accidental file edits
  blocksFileEditsOnGit(_task: string): boolean {
    return true;
  }

  readonly allowedTools = [
    "runCommand",
    "gitStatus",
    "gitDiff",
    "gitLog",
    "gitCommit",
    "gitPush",
    "readFile",
    "listFiles",
    "done",
  ];
  readonly styleRules = [
    "Always check git status before committing",
    "Always check git diff before pushing",
    "Use conventional commit format: type(scope): description",
    "Prefer atomic commits — one logical change per commit",
    "Never force push to main or master branches",
  ];
  readonly safetyRules = [
    "Always require confirmation before git commit",
    "Always require confirmation before git push",
    "Never run destructive commands without explicit instruction",
    "Never modify source files — only run commands",
  ];
}
