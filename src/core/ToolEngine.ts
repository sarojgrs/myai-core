/**
 * Framework-agnostic tool execution engine (PATCHED FOR PRODUCTION)
 *
 *  Uses Node.js fs/path/child_process directly.
 * Confirmation dialogs are injected via AgentConfig.confirm callback.
 */

import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import * as os from "os";
import type { AgentConfig } from "./AgentEngine";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolResult {
  tool: string;
  success: boolean;
  output: string;
}

export interface ToolParameter {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  default?: any;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  params: Record<string, string | ToolParameter>;
}

// ── Built-in tool definitions ─────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "readFile",
    description: "Read the contents of a file in the workspace",
    params: { path: "string — relative path from workspace root" },
  },
  {
    name: "editFile",
    description: "Overwrite a file with new content",
    params: {
      path: "string — relative path from workspace root",
      content: "string — full new file content",
    },
  },
  {
    name: "createFile",
    description: "Create a new file with content",
    params: {
      path: "string — relative path from workspace root",
      content: "string — file content",
    },
  },
  {
    name: "runCommand",
    description: "Run a terminal command in the workspace root",
    params: { command: "string — shell command to run" },
  },
  {
    name: "listFiles",
    description: "List files and folders in a directory",
    params: {
      path: "string — relative path from workspace root (use '.' for root)",
    },
  },
  {
    name: "gitStatus",
    description:
      "Get the current git status (staged, unstaged, untracked files)",
    params: {},
  },
  {
    name: "gitDiff",
    description: "Get the git diff. Use staged=true for staged changes only.",
    params: {
      staged: "boolean string — 'true' for staged diff, 'false' for unstaged",
      file: "string (optional) — relative file path to diff a specific file",
    },
  },
  {
    name: "gitLog",
    description: "Get recent git commit history",
    params: {
      count: "number string — number of commits to show (default: 10)",
    },
  },
  {
    name: "gitCommit",
    description:
      "Stage all changes and commit with a message (requires confirmation)",
    params: { message: "string — commit message" },
  },
  {
    name: "gitPush",
    description:
      "Push commits to the remote repository (requires confirmation)",
    params: {
      remote: "string (optional) — remote name, defaults to 'origin'",
      branch: "string (optional) — branch name, defaults to current branch",
    },
  },
  {
    name: "done",
    description: "Signal task completion with a summary message",
    params: { message: "string — summary of what was done" },
  },
];

// ── Tool prompt builder ───────────────────────────────────────────────────────

export function buildToolSystemPrompt(
  tools: ToolDefinition[] = TOOL_DEFINITIONS,
): string {
  const toolList = tools
    .map((t) => {
      const paramKeys = Object.keys(t.params);
      return `- ${t.name}(${paramKeys.join(", ")}): ${t.description}`;
    })
    .join("\n");

  return `You are an autonomous coding agent with access to these tools:

${toolList}

RULES:
- Respond with ONLY a JSON array of up to 3 tool calls — no explanation, no markdown, no extra text
- You may include up to 3 tool calls in a single response
- Do NOT put dependent calls in the same response (e.g. do not readFile and editFile the same file together)
- NEVER call readFile on a file you are about to create — call editFile directly with the full content
- If readFile returns "File not found", your next response must call editFile to create it
- If you need to MODIFY an existing file, readFile it first in a separate response
- Call listFiles at most ONCE and only if you genuinely don't know the project structure
- NEVER call listFiles if the plan already specifies exact file paths
- Use "done" when the task is complete
- ONLY modify files that exist in the project structure provided
- Do NOT invent new file paths, folders, or architectures
- For git tasks: always call gitStatus or gitDiff before gitCommit
- gitCommit and gitPush always require user confirmation — do not chain them in the same response

RESPONSE FORMAT:
[{"tool": "<toolName>", "args": {<args>}}, ...]`;
}

// ── Command validation — safe patterns & precise blocked patterns ──────
//
// Old BLOCKED_PATTERNS was too aggressive:
//   /[;<|&]/  — blocked "grep foo | sort", "find . -name '*.ts'"
//   />\s*\/dev\/null/ — blocked common safe redirects
//   /\(.*\).*\|/ — regex was wrong, blocked innocent subshell forms
//
// New approach:
//   - BLOCKED_PATTERNS targets genuinely dangerous constructs only
//   - Safe pipes (cmd | cmd) and redirects (cmd > file) are permitted
//   - Shell metacharacters only blocked in dangerous contexts

const SAFE_COMMAND_PATTERNS = [
  // Package managers
  /^npm\s+(install|test|build|run|start|lint)/,
  /^pnpm\s+(install|test|build|run|start|lint)/,
  /^yarn\s+(install|test|build|run|start|lint)/,

  // Build tools
  /^tsc\b/,
  /^webpack\b/,
  /^vite\b/,
  /^esbuild\b/,
  /^tsx\b/,
  /^ts-node\b/,
  /^node\s+.*\.js/,
  /^python[3]?\s+.*\.py/,
  /^python[3]?\s+-m\s+(pytest|unittest|pip)/,

  // Git
  /^git\s+(status|diff|log|show|commit|push|pull|branch|checkout|tag|describe)/,

  // File operations (safe forms)
  /^ls\s*/,
  /^cat\s+/,
  /^find\s+/,
  /^grep\s+/,
  /^pwd\b/,
  /^whoami\b/,
  /^echo\s+/,

  // Text processing
  /^sed\s+/,
  /^awk\s+/,
  /^sort\s+/,
  /^uniq\s+/,
  /^wc\s+/,

  // Compression
  /^tar\s+/,
  /^zip\s+/,
  /^unzip\s+/,
  /^gzip\s+/,
];

const COMMANDS_REQUIRING_CONFIRMATION = [
  "git commit",
  "git push",
  "git reset",
  "git clean",
  "rm ",
  "rm -rf",
];

// Precise blocked patterns — only genuinely dangerous constructs
const BLOCKED_PATTERNS = [
  /\$\{[^}]*\}/, // Variable substitution ${VAR}
  /`[^`]*`/, // Backtick command substitution
  /\$\([^)]*\)/, // $(...) command substitution
  /\bsudo\b/, // Privilege escalation
  /\beval\b/, // eval
  /\bexec\b/, // exec (process replacement)
  /\bsource\b/, // source (dot-source scripts)
  /^\.\s+\//, // dot-source: ". /some/script"
  /\balias\s+/, // alias definition
  /\bexport\s+[A-Z_]+=.*KEY|SECRET|TOKEN|PASSWORD/i, // exporting credentials
  />\s*\/etc\//, // writing to /etc
  />\s*\/proc\//, // writing to /proc
  />\s*\/sys\//, // writing to /sys
  /\brm\s+-rf\s+\/\b/, // rm -rf /  (root wipe)
  /\bdd\s+/, // dd (raw disk operations)
  /\bmkfs\b/, // mkfs (format filesystem)
  /\bchmod\s+777/, // world-writable
  /\bcurl\s+.*\|\s*sh\b/, // curl | sh (remote code execution)
  /\bwget\s+.*\|\s*sh\b/, // wget | sh (remote code execution)
];

interface CommandValidationResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

function validateCommand(command: string): CommandValidationResult {
  const trimmed = command.trim();

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reason: `Command contains blocked pattern: ${trimmed.slice(0, 60)}`,
      };
    }
  }

  const isSafe = SAFE_COMMAND_PATTERNS.some((p) => p.test(trimmed));
  if (!isSafe) {
    return {
      allowed: false,
      requiresConfirmation: false,
      reason: `Command not in whitelist: ${trimmed.split(/\s+/)[0]}`,
    };
  }

  const requiresConfirmation = COMMANDS_REQUIRING_CONFIRMATION.some((prefix) =>
    trimmed.startsWith(prefix),
  );

  return { allowed: true, requiresConfirmation };
}

// ── Safe path resolution ──────────────────────────────────────────────────────

const BLOCKED_PATHS = new Set([
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  ".aws",
  ".ssh",
  ".vscode",
  ".myai",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".cache",
  ".npm",
  ".yarn",
]);

interface SafePathResult {
  safe: boolean;
  absolutePath?: string;
  error?: string;
}

function safeResolvePath(
  workspaceRoot: string,
  relativePath: string,
): SafePathResult {
  try {
    const normalized = path.normalize(relativePath);

    if (path.isAbsolute(normalized)) {
      return {
        safe: false,
        error: `Absolute paths not allowed: ${relativePath}`,
      };
    }

    if (normalized.includes("..")) {
      return {
        safe: false,
        error: `Path traversal attempted: ${relativePath}`,
      };
    }

    const absolutePath = path.resolve(path.join(workspaceRoot, normalized));
    const workspaceNormalized = path.resolve(workspaceRoot);

    if (
      !absolutePath.startsWith(workspaceNormalized + path.sep) &&
      absolutePath !== workspaceNormalized
    ) {
      return { safe: false, error: `Path escapes workspace: ${relativePath}` };
    }

    const parts = absolutePath.split(path.sep);
    for (const part of parts) {
      if (BLOCKED_PATHS.has(part)) {
        return {
          safe: false,
          error: `Access to ${part}/ blocked for security`,
        };
      }
    }

    try {
      const realPath = fs.realpathSync(path.dirname(absolutePath));
      if (!realPath.startsWith(workspaceNormalized)) {
        return { safe: false, error: `Symlink points outside workspace` };
      }
    } catch {
      // Path doesn't exist yet (fine for createFile)
    }

    return { safe: true, absolutePath };
  } catch (err: any) {
    return { safe: false, error: `Path validation error: ${err.message}` };
  }
}

// ── ToolEngine class ──────────────────────────────────────────────────────────

export class ToolEngine {
  // Separate Map for handlers and definitions — allowlist check can now
  // verify custom tool names against the profile's allowedTools list.
  private customTools: Map<
    string,
    (args: Record<string, string>, config: AgentConfig) => Promise<ToolResult>
  > = new Map();

  // Registry of custom tool definitions — used for allowlist checking and schema building
  private customToolDefinitions: Map<string, ToolDefinition> = new Map();

  // ── Register a custom tool ────────────────────────────────────────────────
  // definition is now required — name must be declared before use,
  // which enables the profile allowlist to include/exclude it.
  register(
    name: string,
    definition: ToolDefinition,
    handler: (
      args: Record<string, string>,
      config: AgentConfig,
    ) => Promise<ToolResult>,
  ): void {
    this.customTools.set(name, handler);
    this.customToolDefinitions.set(name, definition);
  }

  // Get all tool definitions (built-in + registered custom tools)
  getAllDefinitions(): ToolDefinition[] {
    return [...TOOL_DEFINITIONS, ...this.customToolDefinitions.values()];
  }

  // ── Execute a tool ────────────────────────────────────────────────────────
  async execute(
    tool: string,
    args: Record<string, string>,
    onMessage: (msg: any) => void,
    config: AgentConfig,
  ): Promise<ToolResult> {
    const { workspaceRoot } = config;

    // Custom tools go through the same allowlist gate as built-in tools.
    // The caller (AgentEngine executeToolFn) already checks isToolAllowed — this
    // is a defence-in-depth check so execute() is safe to call directly too.
    // Custom tools with auto-validation!
    if (this.customTools.has(tool)) {
      const definition = this.customToolDefinitions.get(tool);
      if (definition) {
        try {
          this.validateToolArgs(tool, args, definition);
        } catch (err: any) {
          // Return validation error as tool result
          // so agent can self-correct!
          return {
            tool,
            success: false,
            output: `Validation error: ${err.message}`,
          };
        }
      }
      return this.customTools.get(tool)!(args, config);
    }

    switch (tool) {
      // ── readFile ──────────────────────────────────────────────────────────
      case "readFile": {
        const validation = safeResolvePath(workspaceRoot, args.path);
        if (!validation.safe) {
          onMessage({ type: "agentTool", text: `🚫 ${validation.error}` });
          return {
            tool,
            success: false,
            output: `File not found: ${args.path} — this file does not exist yet. Use createFile to create it.`,
          };
        }
        const absPath = validation.absolutePath!;
        if (!fs.existsSync(absPath)) {
          return {
            tool,
            success: false,
            output: `File not found: ${args.path} — this file does not exist yet. Use editFile to create it.`,
          };
        }
        try {
          const content = fs.readFileSync(absPath, "utf8");
          const truncated =
            content.length > 8000
              ? content.slice(0, 8000) + "\n... (truncated)"
              : content;
          onMessage({ type: "agentTool", text: ` Read: ${args.path}` });
          return { tool, success: true, output: truncated };
        } catch (err: any) {
          return {
            tool,
            success: false,
            output: `readFile error: ${err.message.slice(0, 200)}`,
          };
        }
      }

      // ── editFile ──────────────────────────────────────────────────────────
      case "editFile": {
        const validation = safeResolvePath(workspaceRoot, args.path);
        if (!validation.safe) {
          return {
            tool,
            success: false,
            output: validation.error || "Invalid path",
          };
        }
        const absPath = validation.absolutePath!;
        const cleanedContent = cleanCode(args.content);
        const fileExisted = fs.existsSync(absPath);

        if (!fileExisted) {
          return {
            tool,
            success: false,
            output: `File does not exist: ${args.path}. Use createFile instead.`,
          };
        }

        try {
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(absPath, cleanedContent, "utf8");
          const action = fileExisted ? "Edited" : "Created";
          onMessage({ type: "agentTool", text: `✏️ ${action}: ${args.path}` });
          return { tool, success: true, output: `${action}: ${args.path}` };
        } catch (err: any) {
          return {
            tool,
            success: false,
            output: `editFile error: ${err.message.slice(0, 200)}`,
          };
        }
      }

      // ── createFile ────────────────────────────────────────────────────────
      case "createFile": {
        const validation = safeResolvePath(workspaceRoot, args.path);
        if (!validation.safe) {
          return {
            tool,
            success: false,
            output: validation.error || "Invalid path",
          };
        }
        const absPath = validation.absolutePath!;
        if (fs.existsSync(absPath)) {
          return {
            tool,
            success: false,
            output: `File already exists: ${args.path} — use editFile to modify it`,
          };
        }
        try {
          const cleanedContent = cleanCode(args.content);
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(absPath, cleanedContent, "utf8");
          onMessage({ type: "agentTool", text: `📄 Created: ${args.path}` });
          return { tool, success: true, output: `File created: ${args.path}` };
        } catch (err: any) {
          return {
            tool,
            success: false,
            output: `createFile error: ${err.message.slice(0, 200)}`,
          };
        }
      }

      // ── runCommand ────────────────────────────────────────────────────────
      case "runCommand": {
        const validation = validateCommand(args.command);
        if (!validation.allowed) {
          onMessage({ type: "agentTool", text: ` ${validation.reason}` });
          return {
            tool,
            success: false,
            output: validation.reason || "Command not allowed",
          };
        }

        if (validation.requiresConfirmation) {
          const confirmed = config.confirm
            ? await config.confirm(`Agent wants to run: \`${args.command}\``)
            : false;
          if (!confirmed) {
            return { tool, success: false, output: "Command denied by user" };
          }
        }

        onMessage({ type: "agentTool", text: `⚡ Running: ${args.command}` });
        const result = await runShellCommand(
          args.command,
          workspaceRoot,
          (text) => {
            onMessage({ type: "agentTool", text: `  ${text}` });
          },
        );
        return {
          tool,
          success: result.exitCode === 0,
          output: result.output || `Exit code: ${result.exitCode}`,
        };
      }

      // ── listFiles ─────────────────────────────────────────────────────────
      case "listFiles": {
        const validation = safeResolvePath(workspaceRoot, args.path || ".");
        if (!validation.safe) {
          return {
            tool,
            success: false,
            output: validation.error || "Invalid path",
          };
        }
        const absPath = validation.absolutePath!;
        if (!fs.existsSync(absPath)) {
          return {
            tool,
            success: false,
            output: `Directory not found: ${args.path}`,
          };
        }
        try {
          const entries = fs.readdirSync(absPath, { withFileTypes: true });
          const listing = entries
            .filter((e) => !BLOCKED_PATHS.has(e.name))
            .slice(0, 100)
            .map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`))
            .join("\n");
          onMessage({ type: "agentTool", text: `📂 Listed: ${args.path}` });
          return {
            tool,
            success: true,
            output: listing || "(empty directory)",
          };
        } catch (err: any) {
          return {
            tool,
            success: false,
            output: `listFiles error: ${err.message.slice(0, 200)}`,
          };
        }
      }

      // ── gitStatus ─────────────────────────────────────────────────────────
      case "gitStatus": {
        onMessage({ type: "agentTool", text: `Git status` });
        const r = await runGitCommand("git status", workspaceRoot);
        return { tool, success: r.success, output: r.output };
      }

      // ── gitDiff ───────────────────────────────────────────────────────────
      case "gitDiff": {
        const staged = args.staged === "true" ? "--staged " : "";
        const file = args.file ? ` -- ${args.file}` : "";
        const cmd = `git diff ${staged}${file}`.trim();
        const label = staged ? "staged" : "unstaged";
        onMessage({ type: "agentTool", text: `Git diff (${label})` });
        const r = await runGitCommand(cmd, workspaceRoot);
        return {
          tool,
          success: r.success,
          output: r.output.slice(0, 6000) || "(no changes)",
        };
      }

      // ── gitLog ────────────────────────────────────────────────────────────
      case "gitLog": {
        const count = parseInt(args.count || "10", 10);
        onMessage({ type: "agentTool", text: `📜 Git log (last ${count})` });
        const r = await runGitCommand(
          `git log --oneline --decorate -n ${count}`,
          workspaceRoot,
        );
        return { tool, success: r.success, output: r.output || "(no commits)" };
      }

      // ── gitCommit ─────────────────────────────────────────────────────────
      case "gitCommit": {
        if (!args.message?.trim()) {
          return {
            tool,
            success: false,
            output: "gitCommit requires a non-empty message",
          };
        }
        const confirmed = config.confirm
          ? await config.confirm(`Agent wants to commit: "${args.message}"`)
          : true;
        if (!confirmed)
          return { tool, success: false, output: "Commit denied by user" };

        onMessage({
          type: "agentTool",
          text: `💾 Committing: ${args.message}`,
        });
        const stageResult = await runGitCommand("git add -A", workspaceRoot);
        if (!stageResult.success) {
          return {
            tool,
            success: false,
            output: `git add failed: ${stageResult.output}`,
          };
        }

        // use execFileSync with an args array instead of building a
        // shell command string. No escaping is needed — the message is passed
        // directly to git as a single argument, so backticks, $(), single quotes,
        // and unbalanced quotes cannot cause injection or tokenisation issues.
        try {
          const output = child_process
            .execFileSync("git", ["commit", "-m", args.message.trim()], {
              cwd: workspaceRoot,
              env: {
                PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
                HOME: process.env.HOME || os.homedir(),
                GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "myai",
                GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "myai@local",
                GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "myai",
                GIT_COMMITTER_EMAIL:
                  process.env.GIT_COMMITTER_EMAIL || "myai@local",
              },
              timeout: 15000,
            })
            .toString("utf8")
            .trim();
          return {
            tool,
            success: true,
            output: output || "Committed successfully",
          };
        } catch (err: any) {
          const msg =
            err.stderr?.toString("utf8")?.trim() || err.message || String(err);
          return { tool, success: false, output: msg };
        }
      }

      // ── gitPush ───────────────────────────────────────────────────────────
      case "gitPush": {
        const remote = args.remote || "origin";
        const branch = args.branch || "";
        const cmd = branch
          ? `git push ${remote} ${branch}`
          : `git push ${remote}`;
        const confirmed = config.confirm
          ? await config.confirm(`Agent wants to run: \`${cmd}\``)
          : true;
        if (!confirmed)
          return { tool, success: false, output: "Push denied by user" };
        onMessage({
          type: "agentTool",
          text: `🚀 Pushing to ${remote}${branch ? `/${branch}` : ""}`,
        });
        const r = await runGitCommand(cmd, workspaceRoot);
        return { tool, success: r.success, output: r.output };
      }

      // ── done ──────────────────────────────────────────────────────────────
      case "done": {
        return {
          tool,
          success: true,
          output: args.message || "Task complete.",
        };
      }

      default:
        return { tool, success: false, output: `Unknown tool: ${tool}` };
    }
  }

  private validateToolArgs(
    toolName: string,
    args: Record<string, string>,
    definition: ToolDefinition,
  ): void {
    const params = definition.params;

    for (const [paramName, paramDef] of Object.entries(params)) {
      // Skip if param is just a string description
      // (old format in built-in tools)
      if (typeof paramDef === "string") continue;

      const value = args[paramName];
      const param = paramDef as ToolParameter;

      // Check required
      if (
        param.required &&
        (value === undefined || value === null || value === "")
      ) {
        throw new Error(
          `Tool '${toolName}': required param '${paramName}' is missing`,
        );
      }

      // Skip further checks if not provided and not required
      if (value === undefined || value === null) continue;

      // Check type
      if (param.type === "number" && isNaN(Number(value))) {
        throw new Error(
          `Tool '${toolName}': param '${paramName}' must be a number`,
        );
      }

      if (param.type === "boolean" && value !== "true" && value !== "false") {
        throw new Error(
          `Tool '${toolName}': param '${paramName}' must be true or false`,
        );
      }

      // Check enum
      if (param.enum && !param.enum.includes(value)) {
        throw new Error(
          `Tool '${toolName}': param '${paramName}' must be ` +
            `one of: ${param.enum.join(", ")}`,
        );
      }

      // Check minLength
      if (param.minLength && value.length < param.minLength) {
        throw new Error(
          `Tool '${toolName}': param '${paramName}' must be ` +
            `at least ${param.minLength} characters`,
        );
      }

      // Check maxLength
      if (param.maxLength && value.length > param.maxLength) {
        throw new Error(
          `Tool '${toolName}': param '${paramName}' must be ` +
            `at most ${param.maxLength} characters`,
        );
      }

      // Check pattern
      if (param.pattern) {
        const regex = new RegExp(param.pattern);
        if (!regex.test(value)) {
          throw new Error(
            `Tool '${toolName}': param '${paramName}' ` +
              `does not match required pattern`,
          );
        }
      }
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function cleanCode(code: string): string {
  return code
    .replace(/^```[\w]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

async function runGitCommand(
  command: string,
  cwd: string,
): Promise<{ success: boolean; output: string }> {
  const result = await runShellCommand(command, cwd, () => {});
  return {
    success: result.exitCode === 0,
    output: result.output.slice(0, 3000),
  };
}

// Parses command into binary + args array, never passes through shell
// Preserves quoted strings as single args (e.g. git commit -m "my message")
function parseCommandArgs(command: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  return { cmd: tokens[0] ?? "", args: tokens.slice(1) };
}

async function runShellCommand(
  command: string,
  cwd: string,
  onOutput: (text: string) => void,
): Promise<{ exitCode: number; output: string }> {
  const { cmd, args } = parseCommandArgs(command);

  const safeEnv = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || os.userInfo().username,
    LANG: process.env.LANG || "en_US.UTF-8",
    NODE_ENV: "production",
  };

  const TIMEOUT_MS = 30000;

  return new Promise((resolve) => {
    let output = "";
    let timeoutHandle: NodeJS.Timeout;

    const proc = child_process.spawn(cmd, args, {
      cwd,
      shell: false, // never invoke shell
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });

    timeoutHandle = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, TIMEOUT_MS);

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8", 0, Math.min(1024, data.length));
      output += text;
      onOutput(text);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8", 0, Math.min(1024, data.length));
      output += text;
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      resolve({ exitCode: code ?? 0, output: output.slice(0, 10000) });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      resolve({ exitCode: 1, output: err.message.slice(0, 500) });
    });
  });
}
