/**
 * Provides active file, cursor position, open tabs, and imported files context.
 * This is the VS Code specific provider — used only by VSCodeAdapter.
 * Zero vscode imports here — adapter injects EditorState.
 */

import * as fs from "fs";
import * as path from "path";
import { getLanguageFromPath } from "./FileSystemContext";
import { BaseContextProvider } from "./Base";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  language: string;
  content: string;
}

/** Injected by VSCodeAdapter — all VS Code specific state */
export interface EditorState {
  activeFilePath: string;
  activeFileContent: string;
  language: string;
  cursorLine: number;
  selectedText: string;
  openTabs: FileEntry[];
  workspaceRoot: string;
}

export type ContextLevel = "file" | "tabs" | "project" | "auto" | "completion";

export interface EditorContextOptions {
  level?: ContextLevel;
  maxTabTokens?: number;
  maxImportTokens?: number;
  maxImportedFiles?: number;
}

// ── EditorContextProvider ─────────────────────────────────────────────────────

export class EditorContextProvider extends BaseContextProvider {
  readonly name = "editor";

  private state: EditorState;
  private options: Required<EditorContextOptions>;

  constructor(state: EditorState, options: EditorContextOptions = {}) {
    super();
    this.state = state;
    this.options = {
      level: options.level ?? "auto",
      maxTabTokens: options.maxTabTokens ?? 2000,
      maxImportTokens: options.maxImportTokens ?? 300,
      maxImportedFiles: options.maxImportedFiles ?? 1,
    };
  }

  /** Update editor state — call this when active file changes */
  updateState(state: EditorState): void {
    this.state = state;
  }

  async buildContext(task: string): Promise<string> {
    const {
      activeFilePath,
      activeFileContent,
      language,
      cursorLine,
      selectedText,
      openTabs,
    } = this.state;
    const parts: string[] = [];

    if (!activeFilePath) return "";

    // ── Active file ───────────────────────────────────────────────────────────
    const fileContext = this._buildFileContext(
      activeFilePath,
      activeFileContent,
      language,
      cursorLine,
    );

    if (selectedText?.trim()) {
      parts.push(
        `## Selected code\n\`\`\`${language}\n${selectedText}\n\`\`\``,
      );
    } else if (fileContext) {
      parts.push(
        `## Current file: ${activeFilePath}\n\`\`\`${language}\n${fileContext}\n\`\`\``,
      );
    }

    parts.push(
      `- Active file: ${activeFilePath} (${language})\n- Cursor: line ${cursorLine}`,
    );

    // ── Imported files ────────────────────────────────────────────────────────
    if (activeFileContent && this.options.level !== "file") {
      const imported = this._resolveImports(
        activeFilePath,
        activeFileContent,
        language,
      );
      if (imported.length) {
        const block = imported
          .map(
            (f) => `### ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\``,
          )
          .join("\n\n");
        parts.push(`## Imported files\n${block}`);
      }
    }

    // ── Open tabs ─────────────────────────────────────────────────────────────
    if (
      openTabs?.length &&
      (this.options.level === "tabs" ||
        this.options.level === "project" ||
        this.options.level === "auto")
    ) {
      let tabTokens = 0;
      const tabBlocks: string[] = [];

      for (const tab of openTabs) {
        if (tab.path === activeFilePath) continue;
        const truncated = this.truncate(tab.content, 400);
        const tokens = this.estimateTokens(truncated);
        if (tabTokens + tokens > this.options.maxTabTokens) break;
        tabTokens += tokens;
        tabBlocks.push(
          `### ${tab.path}\n\`\`\`${tab.language}\n${truncated}\n\`\`\``,
        );
      }

      if (tabBlocks.length) {
        parts.push(`## Other open files\n${tabBlocks.join("\n\n")}`);
      }
    }

    return parts.join("\n\n");
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _buildFileContext(
    filePath: string,
    content: string,
    language: string,
    cursorLine: number,
  ): string {
    const lines = content.split("\n");

    // Small file — send full
    if (lines.length <= 120) return content;

    // Large file — send cursor window
    const radius = 20;
    const start = Math.max(0, cursorLine - radius - 1);
    const end = Math.min(lines.length, cursorLine + radius);
    return lines.slice(start, end).join("\n");
  }

  private _resolveImports(
    fromFile: string,
    content: string,
    language: string,
  ): FileEntry[] {
    const importPaths = this._parseImports(content, language);
    const results: FileEntry[] = [];
    let totalTokens = 0;

    for (const importPath of importPaths.slice(
      0,
      this.options.maxImportedFiles,
    )) {
      const resolved = this._resolveImportPath(importPath, fromFile);
      if (!resolved) continue;
      try {
        const fileContent = fs.readFileSync(resolved, "utf8");
        const lang = getLanguageFromPath(resolved);
        const truncated = this.truncate(
          fileContent,
          this.options.maxImportTokens,
        );
        const tokens = this.estimateTokens(truncated);
        if (
          totalTokens + tokens >
          this.options.maxImportTokens * this.options.maxImportedFiles
        )
          break;
        totalTokens += tokens;
        results.push({ path: resolved, language: lang, content: truncated });
      } catch (err: any) {
        console.warn(
          "[EditorContext] Failed to read imported file:",
          resolved,
          err?.message || String(err),
        );
      }
    }

    return results;
  }

  private _parseImports(content: string, language: string): string[] {
    const imports: string[] = [];
    if (
      [
        "typescript",
        "javascript",
        "typescriptreact",
        "javascriptreact",
      ].includes(language)
    ) {
      const esImport = /from\s+["'](.[^"']+)["']/g;
      const requireImport = /require\s*\(\s*["'](.[^"']+)["']\s*\)/g;
      let m;
      while ((m = esImport.exec(content)) !== null) imports.push(m[1]);
      while ((m = requireImport.exec(content)) !== null) imports.push(m[1]);
    }
    if (language === "python") {
      const py = /from\s+(\.[^\s]+)\s+import/g;
      let m;
      while ((m = py.exec(content)) !== null) imports.push(m[1]);
    }
    return [...new Set(imports)];
  }

  private _resolveImportPath(
    importPath: string,
    fromFile: string,
  ): string | null {
    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, importPath);
    const exts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".cs"];
    if (fs.existsSync(resolved)) return resolved;
    for (const ext of exts) {
      if (fs.existsSync(resolved + ext)) return resolved + ext;
    }
    for (const ext of exts) {
      const idx = path.join(resolved, `index${ext}`);
      if (fs.existsSync(idx)) return idx;
    }
    return null;
  }
}
