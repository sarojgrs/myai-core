/**
 * Research profile
 */

import { BaseProfile } from "./Base";

export class ResearchProfile extends BaseProfile {
  readonly name = "research";
  readonly description =
    "Research agent — reads and analyzes files, produces reports";
  readonly systemPrompt =
    "You are a research and analysis agent. Read, analyze, and summarize information from files.";
  readonly planningPrompt = `Output a short numbered plan (max 6 steps) using only readFile and listFiles.
End with a createFile step for your output report in markdown format.
NEVER plan editFile or runCommand steps.
No explanation, no intro. Just the numbered steps.`;

  // Research profile never runs git commands — no need to block file edits
  blocksFileEditsOnGit(_task: string): boolean {
    return false;
  }

  readonly allowedTools = ["readFile", "listFiles", "createFile", "done"];
  readonly styleRules = [
    "Always cite the source file when referencing content",
    "Summarize findings clearly and concisely",
    "Create output files in markdown format",
    "Never modify source files — only read them",
    "Structure reports with clear headings and sections",
  ];
  readonly safetyRules = [
    "Read-only access to source files",
    "Never run shell commands",
    "Never edit existing files",
  ];
}
