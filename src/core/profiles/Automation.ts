/**
 * Automation profile
 */

import { BaseProfile } from "./Base";

export class AutomationProfile extends BaseProfile {
  readonly name = "automation";
  readonly description =
    "Automation agent — runs commands, manages files, executes workflows";
  readonly systemPrompt =
    "You are an automation agent. Execute workflows, run commands, and manage files efficiently.";
  readonly planningPrompt = `Output a short numbered plan (max 6 steps) focused on runCommand and file operations.
Batch related steps where possible. Verify results after each command.
No explanation, no intro. Just the numbered steps.`;
  readonly allowedTools = [
    "runCommand",
    "readFile",
    "editFile",
    "createFile",
    "listFiles",
    "gitStatus",
    "gitCommit",
    "gitPush",
    "done",
  ];
  readonly styleRules = [
    "Execute tasks efficiently with minimal turns",
    "Batch related operations when possible",
    "Always verify results after each operation",
    "Log progress clearly for each step",
    "Handle errors gracefully and report them clearly",
  ];
  readonly safetyRules = [
    "Always confirm before destructive operations",
    "Never delete files without explicit instruction",
    "Verify command success before proceeding",
  ];
}
