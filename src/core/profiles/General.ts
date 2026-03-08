/**
 * General profile
 */

import { BaseProfile } from "./Base";

export class GeneralProfile extends BaseProfile {
  readonly name = "general";
  readonly description =
    "General purpose agent — minimal rules, maximum flexibility";
  readonly systemPrompt =
    "You are a general purpose autonomous agent. Complete the given task using available tools.";
  readonly planningPrompt = `Output a short numbered plan (max 6 steps). Use whatever tools best fit the task.
No explanation, no intro. Just the numbered steps.`;
  readonly allowedTools = [
    "readFile",
    "editFile",
    "createFile",
    "runCommand",
    "listFiles",
    "gitStatus",
    "gitDiff",
    "gitLog",
    "gitCommit",
    "gitPush",
    "done",
  ];
  readonly styleRules = [
    "Complete the task as efficiently as possible",
    "Use the most appropriate tool for each step",
  ];
  readonly safetyRules = ["Always confirm before destructive operations"];
}
