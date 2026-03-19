import { BaseProfile } from "./Base";

export class RAGProfile extends BaseProfile {
  readonly name = "rag";
  readonly description =
    "Agent with custom tools — searches, integrates and answers";

  readonly systemPrompt =
    "You are a helpful assistant with access to custom tools. " +
    "Always use the available tools to complete tasks. " +
    "Base your answers on tool results only. " +
    "If a tool returns no results say so clearly.";

  readonly planningPrompt = `
    You have access to vectorSearch tool.
    Use it to search the knowledge base.

    For any search task:
    1. Call vectorSearch with the user query
    2. Return the results

    Use vectorSearch ONLY.
    Do NOT use search_files or search_code.
    No explanation. Just numbered steps.`;

  readonly allowedTools = [
    // Basic read operations
    "readFile", // might need context files
    "listFiles", // might need to explore
    // Always needed
    "done",
    // Custom tools added automatically! ✅
    // vectorSearch, chatSend, httpRequest etc
  ];

  readonly styleRules = [
    "Always use available tools to find information",
    "Base answers strictly on tool results",
    "If no results found say clearly",
    "Never make up information",
    "Cite tool results when answering",
  ];

  readonly safetyRules = [
    "Never modify or delete files",
    "Never run shell commands",
    "Never execute code",
    "Only use provided tools",
  ];

  blocksFileEditsOnGit(_task: string): boolean {
    return false;
  }
}
