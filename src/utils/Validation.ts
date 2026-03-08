/**
 * Input validation utilities
 *
 * All validation functions throw ValidationError on invalid input.
 * ValidationError is exported publicly so consumers can catch it specifically.
 *
 * These functions are NOT part of the public API — only ValidationError is exported
 * from index.ts. The validate* functions are called internally by the factories.
 */

import { CreateAgentOptions, CreateChatOptions, ProviderEntry } from "..";
import { EnhancedToolDefinition } from "../core/registry/ToolRegistry";

// ── ValidationError ───────────────────────────────────────────────────────────

/**
 * Thrown when factory options fail validation.
 * Exported publicly so consumers can distinguish misconfiguration
 * from runtime errors:
 *
 *   try {
 *     const agent = createAgent({ ... });
 *   } catch (err) {
 *     if (err instanceof ValidationError) {
 *       // bad config — show to user
 *     }
 *   }
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ── Primitive helpers ─────────────────────────────────────────────────────────

/**
 * Throws if value is not a non-empty string.
 */
export function validateRequiredString(
  value: unknown,
  fieldName: string,
): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`"${fieldName}" must be a non-empty string`);
  }
}

/**
 * Throws if value is not a function.
 */
export function validateRequiredFunction(
  value: unknown,
  fieldName: string,
): void {
  if (typeof value !== "function") {
    throw new ValidationError(`"${fieldName}" must be a function`);
  }
}

// ── Factory validators ────────────────────────────────────────────────────────

/**
 * Validates options passed to createAgent() and createCustomAgent().
 * Called as the first line of buildAgentInternals().
 */
export function validateAgentOptions(options: CreateAgentOptions): void {
  validateRequiredString(options.provider, "provider");
  validateRequiredString(options.apiKey, "apiKey");
  validateRequiredString(options.model, "model");
  validateRequiredString(options.baseUrl, "baseUrl");
  validateRequiredString(options.workspaceRoot, "workspaceRoot");
  validateRequiredFunction(options.onMessage, "onMessage");

  // Validate additional providers if supplied
  if (options.providers) {
    for (const [name, entry] of Object.entries(options.providers) as [
      string,
      ProviderEntry,
    ][]) {
      validateRequiredString(entry.apiKey, `providers.${name}.apiKey`);
      validateRequiredString(entry.model, `providers.${name}.model`);
      validateRequiredString(entry.baseUrl, `providers.${name}.baseUrl`);
    }
  }
}

/**
 * Validates options passed to createChat().
 * If any provider field is supplied, all four must be present together.
 */
export function validateChatOptions(options: CreateChatOptions): void {
  validateRequiredString(options.workspaceRoot, "workspaceRoot");

  // Provider fields are optional, but must all be present together
  const chatProviderFields = [
    options.provider,
    options.apiKey,
    options.model,
    options.baseUrl,
  ];
  const definedCount = chatProviderFields.filter(Boolean).length;
  if (definedCount > 0 && definedCount < 4) {
    throw new ValidationError(
      "createChat: provider, apiKey, model, and baseUrl must all be provided together",
    );
  }
}

export function validateToolDefinition(def: EnhancedToolDefinition): void {
  if (!def.name || def.name.trim() === "") {
    throw new Error("Tool must have a non-empty name.");
  }

  if (!def.description || def.description.trim() === "") {
    throw new Error(`Tool "${def.name}" must have a description.`);
  }

  // Validate tool name format
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
    throw new Error(
      `Tool name "${def.name}" must start with letter, contain only alphanumerics and underscores.`,
    );
  }

  // Validate parameters
  for (const [paramName, param] of Object.entries(def.params)) {
    if (!param.type) {
      throw new Error(
        `Parameter "${paramName}" in tool "${def.name}" must have a type.`,
      );
    }

    if (!["string", "number", "boolean", "array"].includes(param.type)) {
      throw new Error(
        `Invalid parameter type "${param.type}" for ${def.name}.${paramName}`,
      );
    }
  }
}
