/**
 * Enhanced tool registration and management
 *
 * Extends ToolEngine with runtime tool registration capabilities.
 * Allows registering custom tools without modifying TOOL_DEFINITIONS.
 *
 * Built-in tools are immutable. Custom tools can be registered and unregistered.
 *
 * Usage:
 *   const toolRegistry = new ToolRegistry();
 *
 *   toolRegistry.registerTool(
 *     "sendEmail",
 *     {
 *       description: "Send email via SMTP",
 *       params: {
 *         to: { type: "string", description: "Recipient", required: true },
 *         subject: { type: "string", description: "Email subject", required: true },
 *         body: { type: "string", description: "Email body", required: true },
 *       },
 *     },
 *     async (args, config) => {
 *       // Implementation
 *       return { tool: "sendEmail", success: true, output: "Email sent" };
 *     },
 *   );
 */

import { validateToolDefinition } from "../../utils/Validation";
import type { AgentConfig } from "../AgentEngine";

// ── Enhanced tool definition with typed parameters ─────────────────────────────

export interface ToolParameter {
  /** Parameter type */
  type: "string" | "number" | "boolean" | "array";

  /** Human-readable description */
  description: string;

  /** Whether this parameter is required (default: false) */
  required?: boolean;

  /** For enum-like parameters: allowed values */
  enum?: string[];

  /** For string: minimum length */
  minLength?: number;

  /** For string: maximum length */
  maxLength?: number;

  /** For string: regex pattern (as string for serialization) */
  pattern?: string;

  /** For number: minimum value */
  min?: number;

  /** For number: maximum value */
  max?: number;

  /** Default value if not provided */
  default?: string | number | boolean;
}

export interface EnhancedToolDefinition {
  /** Tool name (used in tool calls) */
  name: string;

  /** Human-readable description */
  description: string;

  /** Tool parameters with type information */
  params: Record<string, ToolParameter>;

  /** Tool category for organization */
  category?: "builtin" | "file" | "git" | "shell" | "integration" | "custom";

  /** Tool version */
  version?: string;

  /** Tags for discovery/filtering */
  tags?: string[];

  /** Whether this is a built-in tool (cannot be unregistered) */
  isBuiltin?: boolean;
}

export interface ToolResult {
  tool: string;
  success: boolean;
  output: string;
}

export type ToolHandler = (
  args: Record<string, string>,
  config: AgentConfig,
) => Promise<ToolResult>;

// ── ToolRegistry class ────────────────────────────────────────────────────────

export class ToolRegistry {
  private toolDefinitions: Map<string, EnhancedToolDefinition> = new Map();
  private toolHandlers: Map<string, ToolHandler> = new Map();

  // ── Register a custom tool ────────────────────────────────────────────────

  /**
   * Register a custom tool at runtime.
   * Built-in tool names are reserved and cannot be overridden.
   *
   * @param name Tool name (must be unique)
   * @param definition Tool definition with parameters
   * @param handler Function to execute the tool
   * @throws Error if name conflicts with built-in tool
   */
  registerTool(
    name: string,
    definition: Omit<EnhancedToolDefinition, "name" | "isBuiltin">,
    handler: ToolHandler,
  ): void {
    if (this.isBuiltinTool(name)) {
      throw new Error(
        `Cannot register tool "${name}": conflicts with built-in tool. Choose a different name.`,
      );
    }

    if (this.toolDefinitions.has(name)) {
      console.warn(`[ToolRegistry] Re-registering custom tool: ${name}`);
    }

    // Validate tool schema
    validateToolDefinition({ ...definition, name, isBuiltin: false });

    this.toolDefinitions.set(name, {
      ...definition,
      name,
      isBuiltin: false,
      category: definition.category ?? "custom",
    });
    this.toolHandlers.set(name, handler);

    console.log(`[ToolRegistry] Registered custom tool: ${name}`);
  }

  /**
   * Unregister a custom tool.
   * Built-in tools cannot be unregistered.
   *
   * @param name Tool name
   * @returns true if tool was unregistered, false if not found or built-in
   */
  unregisterTool(name: string): boolean {
    if (this.isBuiltinTool(name)) {
      throw new Error(`Cannot unregister built-in tool "${name}".`);
    }

    const deleted = this.toolDefinitions.delete(name);
    this.toolHandlers.delete(name);

    if (deleted) {
      console.log(`[ToolRegistry] Unregistered custom tool: ${name}`);
    }

    return deleted;
  }

  // ── Query tools ──────────────────────────────────────────────────────────

  /**
   * Get all registered tool definitions (built-in + custom).
   */
  getAllDefinitions(): EnhancedToolDefinition[] {
    return Array.from(this.toolDefinitions.values());
  }

  /**
   * Get tool definition by name.
   */
  getDefinition(name: string): EnhancedToolDefinition | null {
    return this.toolDefinitions.get(name) ?? null;
  }

  /**
   * Get tool handler by name.
   */
  getHandler(name: string): ToolHandler | null {
    return this.toolHandlers.get(name) ?? null;
  }

  /**
   * Check if tool exists (built-in or custom).
   */
  hasTool(name: string): boolean {
    return this.toolDefinitions.has(name);
  }

  /**
   * Check if tool is built-in (cannot be modified/unregistered).
   */
  isBuiltinTool(name: string): boolean {
    return this.toolDefinitions.get(name)?.isBuiltin ?? false;
  }

  /**
   * Get custom tools only (excludes built-ins).
   */
  getCustomTools(): EnhancedToolDefinition[] {
    return Array.from(this.toolDefinitions.values()).filter(
      (t) => !t.isBuiltin,
    );
  }

  /**
   * Get built-in tools only.
   */
  getBuiltinTools(): EnhancedToolDefinition[] {
    return Array.from(this.toolDefinitions.values()).filter((t) => t.isBuiltin);
  }

  /**
   * Find tools by category.
   */
  getToolsByCategory(category: string): EnhancedToolDefinition[] {
    return Array.from(this.toolDefinitions.values()).filter(
      (t) => t.category === category,
    );
  }

  /**
   * Find tools by tag.
   */
  getToolsByTag(tag: string): EnhancedToolDefinition[] {
    return Array.from(this.toolDefinitions.values()).filter((t) =>
      t.tags?.includes(tag),
    );
  }

  /**
   * List all tool names.
   */
  listToolNames(): string[] {
    return Array.from(this.toolDefinitions.keys());
  }

  // ── Validation ─────────────────────────────────────────────────────────

  /**
   * Validate tool arguments against definition.
   * Throws Error if validation fails.
   */
  validateArguments(name: string, args: Record<string, string>): void {
    const def = this.getDefinition(name);
    if (!def) {
      throw new Error(`Unknown tool: "${name}"`);
    }

    // Check required parameters
    for (const [paramName, param] of Object.entries(def.params)) {
      if (param.required && !(paramName in args)) {
        throw new Error(`Tool "${name}" requires parameter "${paramName}".`);
      }
    }

    // Validate each provided argument
    for (const [argName, argValue] of Object.entries(args)) {
      const param = def.params[argName];
      if (!param) {
        throw new Error(
          `Tool "${name}" does not accept parameter "${argName}".`,
        );
      }

      this._validateParameter(name, argName, argValue, param);
    }
  }

  private _validateParameter(
    toolName: string,
    paramName: string,
    value: string,
    param: ToolParameter,
  ): void {
    // Type coercion and validation
    if (param.type === "number") {
      if (isNaN(Number(value))) {
        throw new Error(
          `Parameter "${paramName}" in "${toolName}" must be a number.`,
        );
      }
      const num = Number(value);
      if (param.min !== undefined && num < param.min) {
        throw new Error(`Parameter "${paramName}" must be >= ${param.min}.`);
      }
      if (param.max !== undefined && num > param.max) {
        throw new Error(`Parameter "${paramName}" must be <= ${param.max}.`);
      }
    }

    if (param.type === "boolean") {
      if (
        !["true", "false", "yes", "no", "1", "0"].includes(value.toLowerCase())
      ) {
        throw new Error(
          `Parameter "${paramName}" must be boolean (true/false).`,
        );
      }
    }

    if (param.type === "string") {
      if (param.minLength && value.length < param.minLength) {
        throw new Error(
          `Parameter "${paramName}" must be at least ${param.minLength} characters.`,
        );
      }
      if (param.maxLength && value.length > param.maxLength) {
        throw new Error(
          `Parameter "${paramName}" must be at most ${param.maxLength} characters.`,
        );
      }
      if (param.enum && !param.enum.includes(value)) {
        throw new Error(
          `Parameter "${paramName}" must be one of: ${param.enum.join(", ")}`,
        );
      }
      if (param.pattern) {
        const regex = new RegExp(param.pattern);
        if (!regex.test(value)) {
          throw new Error(
            `Parameter "${paramName}" does not match pattern: ${param.pattern}`,
          );
        }
      }
    }
  }
}
