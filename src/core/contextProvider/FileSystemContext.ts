import * as fs from "fs";
import * as path from "path";
import { BaseContextProvider } from "./Base";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MyAIConfig {
  project?: {
    name?: string;
    description?: string;
    language?: string;
    stack?: string[];
    frameworks?: string[];
    testFramework?: string;
    packageManager?: string;
  };
  conventions?: {
    namingStyle?: string;
    quotes?: string;
    semicolons?: boolean;
    indentStyle?: string;
    indentSize?: number;
    notes?: string;
  };
  ai?: {
    tokenBudget?: number;
    alwaysInclude?: string[];
  };
}

export interface FileSystemContextOptions {
  /** Max depth for directory traversal (default: 3) */
  maxDepth?: number;
  /** Max files per directory (default: 25) */
  maxFilesPerDir?: number;
  /** Folders to ignore (default: node_modules, .git, dist, etc.) */
  ignoreFolders?: string[];
  /** Include file contents for alwaysInclude files (default: true) */
  includeAlwaysInclude?: boolean;
  /** TTL in ms for the directory structure cache (default: 10000) */
  structureCacheTtlMs?: number;
  /** Config file name to look for (default: "myai.config.json") */
  configFile?: string;
  /** Instructions markdown file name to look for (default: "myai.md") */
  instructionsFile?: string;
}

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".next",
  "build",
  "__pycache__",
  ".vscode",
  "obj",
  "bin",
  ".myai",
]);

// ── FileSystemContextProvider ─────────────────────────────────────────────────

export class FileSystemContextProvider extends BaseContextProvider {
  readonly name = "filesystem";

  readonly invalidateOn = [
    "createFile",
    "editFile",
    "deleteFile",
    "renameFile",
  ];

  private workspaceRoot: string;
  private options: Required<FileSystemContextOptions>;
  private _config: MyAIConfig | null = null;
  private _myaiMd: string | null = null;

  // Structure cache — avoids readdirSync walk on every buildContext() call
  private _structureCache: { value: string; timestamp: number } | null = null;
  private _structureCacheTtlMs: number;

  //  alwaysInclude cache — files rarely change during a session
  private _alwaysIncludeCache:
    | { path: string; lang: string; content: string }[]
    | null = null;
  private _alwaysIncludeCachedPaths: string[] | null = null;

  constructor(workspaceRoot: string, options: FileSystemContextOptions = {}) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.options = {
      maxDepth: options.maxDepth ?? 3,
      maxFilesPerDir: options.maxFilesPerDir ?? 25,
      ignoreFolders: options.ignoreFolders ?? [],
      includeAlwaysInclude: options.includeAlwaysInclude ?? true,
      structureCacheTtlMs: options.structureCacheTtlMs ?? 10_000,
      configFile: options.configFile ?? "myai.config.json",
      instructionsFile: options.instructionsFile ?? "MYAI.md",
    };
    this._structureCacheTtlMs = this.options.structureCacheTtlMs;
    this._loadProjectFiles();
  }

  async buildContext(task: string): Promise<string> {
    const parts: string[] = [];
    const cfg = this._config;

    // ── Project identity ──────────────────────────────────────────────────
    if (cfg?.project) {
      const p = cfg.project;
      const lines: string[] = [];
      if (p.name) lines.push(`Project: ${p.name}`);
      if (p.description) lines.push(`Description: ${p.description}`);
      if (p.language) lines.push(`Language: ${p.language}`);
      if (p.stack?.length) lines.push(`Stack: ${p.stack.join(", ")}`);
      if (p.frameworks?.length)
        lines.push(`Frameworks: ${p.frameworks.join(", ")}`);
      if (p.testFramework) lines.push(`Test framework: ${p.testFramework}`);
      if (p.packageManager) lines.push(`Package manager: ${p.packageManager}`);
      if (lines.length) {
        parts.push(`## Project\n${lines.map((l) => `- ${l}`).join("\n")}`);
      }
    }

    // ── Conventions ───────────────────────────────────────────────────────
    if (cfg?.conventions) {
      const c = cfg.conventions;
      const lines: string[] = [];
      if (c.namingStyle) lines.push(`Naming: ${c.namingStyle}`);
      if (c.quotes) lines.push(`Quotes: ${c.quotes}`);
      if (c.semicolons !== undefined) lines.push(`Semicolons: ${c.semicolons}`);
      if (c.indentStyle)
        lines.push(`Indent: ${c.indentSize ?? 2} ${c.indentStyle}`);
      if (c.notes) lines.push(`Notes: ${c.notes}`);
      if (lines.length) {
        parts.push(`## Conventions\n${lines.map((l) => `- ${l}`).join("\n")}`);
      }
    }

    // ── MYAI.md instructions ──────────────────────────────────────────────
    if (this._myaiMd) {
      const match = this._myaiMd.match(
        /## AI Instructions([\s\S]*?)(?=\n## |$)/,
      );
      if (match) {
        const instructions = match[1].replace(/<!--[\s\S]*?-->/g, "").trim();
        if (instructions)
          parts.push(`## Project instructions\n${instructions}`);
      }
    }

    // ──  Cached project structure ───────────────────────────────────
    const structure = this._getCachedStructure();
    if (structure) {
      parts.push(`## Project structure\n\`\`\`\n${structure}\n\`\`\``);
    }

    // ──Cached alwaysInclude files ─────────────────────────────────
    if (this.options.includeAlwaysInclude && cfg?.ai?.alwaysInclude?.length) {
      const alwaysFiles = this._getCachedAlwaysInclude(cfg.ai.alwaysInclude);
      if (alwaysFiles.length) {
        const block = alwaysFiles
          .map((f) => `### ${f.path}\n\`\`\`${f.lang}\n${f.content}\n\`\`\``)
          .join("\n\n");
        parts.push(`## Always-include files\n${block}`);
      }
    }

    return parts.join("\n\n");
  }

  // ── Public getters ────────────────────────────────────────────────────────

  get projectConfig(): MyAIConfig | null {
    return this._config;
  }

  get workspaceRootPath(): string {
    return this.workspaceRoot;
  }

  //  Call this after file writes to invalidate caches
  invalidateCache(type: "structure" | "alwaysInclude" | "all" = "all"): void {
    if (type === "structure" || type === "all") this._structureCache = null;
    if (type === "alwaysInclude" || type === "all") {
      this._alwaysIncludeCache = null;
      this._alwaysIncludeCachedPaths = null;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _loadProjectFiles(): void {
    const configPath = this._findFile(this.options.configFile);
    if (configPath) {
      try {
        this._config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (err: any) {
        console.warn(
          "[FileSystemContext] Failed to parse config file:",
          configPath,
          err?.message || String(err),
        );
      }
    }

    const mdPath = this._findFile(this.options.instructionsFile);
    if (mdPath) {
      try {
        this._myaiMd = fs.readFileSync(mdPath, "utf8");
      } catch (err: any) {
        console.warn(
          "[FileSystemContext] Failed to read instructions file:",
          mdPath,
          err?.message || String(err),
        );
      }
    }
  }

  private _findFile(filename: string): string | null {
    try {
      const lower = filename.toLowerCase();
      const entries = fs.readdirSync(this.workspaceRoot);
      const match = entries.find((e) => e.toLowerCase() === lower);
      return match ? path.join(this.workspaceRoot, match) : null;
    } catch {
      return null;
    }
  }

  // Return cached structure or rebuild and cache
  private _getCachedStructure(): string {
    const now = Date.now();
    if (
      this._structureCache &&
      now - this._structureCache.timestamp < this._structureCacheTtlMs
    ) {
      return this._structureCache.value;
    }
    const value = this._buildStructure();
    this._structureCache = { value, timestamp: now };
    return value;
  }

  private _buildStructure(): string {
    const ignore = new Set([...DEFAULT_IGNORE, ...this.options.ignoreFolders]);

    const walk = (dir: string, depth = 0): string => {
      if (depth > this.options.maxDepth) return "";
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => !ignore.has(e.name) && !e.name.startsWith("."))
          .slice(0, this.options.maxFilesPerDir)
          .map((e) => {
            const indent = "  ".repeat(depth);
            return e.isDirectory()
              ? `${indent}${e.name}/\n${walk(path.join(dir, e.name), depth + 1)}`
              : `${indent}${e.name}`;
          })
          .filter(Boolean)
          .join("\n");
      } catch {
        return "";
      }
    };

    return walk(this.workspaceRoot);
  }

  //  Return cached alwaysInclude files or read and cache
  // Cache is invalidated when the paths list changes or invalidateCache() is called.
  private _getCachedAlwaysInclude(
    paths: string[],
  ): { path: string; lang: string; content: string }[] {
    const pathsKey = paths.join("|");
    const cachedKey = this._alwaysIncludeCachedPaths?.join("|");
    if (this._alwaysIncludeCache && cachedKey === pathsKey) {
      return this._alwaysIncludeCache;
    }
    const result = this._loadAlwaysIncludeFiles(paths);
    this._alwaysIncludeCache = result;
    this._alwaysIncludeCachedPaths = paths;
    return result;
  }

  private _loadAlwaysIncludeFiles(
    paths: string[],
  ): { path: string; lang: string; content: string }[] {
    const result: { path: string; lang: string; content: string }[] = [];
    let totalTokens = 0;
    const maxTokens = 300;

    for (const relPath of paths) {
      if (totalTokens >= maxTokens) break;
      if (relPath === "MYAI.md") continue;
      const absPath = path.join(this.workspaceRoot, relPath);
      if (!fs.existsSync(absPath)) continue;
      try {
        const content = fs.readFileSync(absPath, "utf8");
        const lang = getLanguageFromPath(absPath);
        const truncated = this.truncate(content, 300);
        const tokens = this.estimateTokens(truncated);
        if (totalTokens + tokens > maxTokens) break;
        totalTokens += tokens;
        result.push({ path: relPath, lang, content: truncated });
      } catch (err: any) {
        console.warn(
          "[FileSystemContext] Failed to read file in tree:",
          relPath,
          err?.message || String(err),
        );
      }
    }

    return result;
  }
}

// ── Language helper ───────────────────────────────────────────────────────────

export function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".go": "go",
    ".cs": "csharp",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "c",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".sql": "sql",
    ".sh": "shellscript",
    ".json": "json",
    ".md": "markdown",
  };
  return map[ext] ?? ext.slice(1) ?? "plaintext";
}
