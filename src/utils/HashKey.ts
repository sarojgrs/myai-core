/**
 * djb2-style hash for cache key construction.
 * Not cryptographic — only needs to cheaply distinguish different strings.
 *
 * Accepts one or more segments; joins with \x00 (null byte) before hashing
 * so callers never build composite strings themselves, and a segment
 * containing "|" never collides with two separate segments.
 *
 * Usage:
 *   hashKey("fix login bug")                    → ContextEngine: taskSensitive key
 *   hashKey("/workspace/proj", "fix login bug") → AgentEngine: context cache key
 */
export function hashKey(...parts: string[]): string {
  const str = parts.join("\x00");
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
