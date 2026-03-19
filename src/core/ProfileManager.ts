/**
 * Domain profile system
 *
 * ProfileManager is a thin registry. It:
 *   - Registers and switches profiles
 *   - Exposes active profile capabilities to AgentEngine
 *
 * All profile definitions live in profiles/:
 *   profiles/code.ts        → CodeProfile
 *   profiles/devops.ts      → DevOpsProfile
 *   profiles/general.ts     → GeneralProfile
 *   profiles/research.ts    → ResearchProfile
 *   profiles/support.ts     → SupportProfile
 *   profiles/automation.ts  → AutomationProfile
 *
 * Adding a new profile:
 *   1. Create profiles/myprofile.ts extending BaseProfile
 *   2. Register: profileManager.register(new MyProfile())
 *   3. Switch:   profileManager.switch("myprofile")
 */

import type { ToolDefinition } from "./ToolEngine";
import { CodeProfile } from "./profiles/Code";
import { DevOpsProfile } from "./profiles/DevOps";
import { GeneralProfile } from "./profiles/General";
import { ResearchProfile } from "./profiles/Research";
import { SupportProfile } from "./profiles/Support";
import { AutomationProfile } from "./profiles/Automation";
import { BaseProfile } from "./profiles/Base";
import { RAGProfile } from "./profiles/RAG";

export type BuiltInProfile =
  | "code"
  | "devops"
  | "general"
  | "research"
  | "support"
  | "automation";

export type ProfileName = BuiltInProfile | (string & {});

// ── ProfileConfig — plain object representation ───────────────────────────────

export interface ProfileConfig {
  name: string;
  description: string;
  systemPrompt: string;
  planningPrompt: string;
  allowedTools: string[];
  styleRules: string[];
  safetyRules: string[];
}

// ── CustomProfileDefinition — for runtime profile creation ────────────────────

export interface CustomProfileDefinition {
  description?: string;
  systemPrompt: string;
  planningPrompt: string;
  userPrompt?: string;
  allowedTools: string[];
  styleRules?: string[];
  safetyRules?: string[];
}

// ── ProfileManager ────────────────────────────────────────────────────────────

export class ProfileManager {
  private profiles: Map<string, BaseProfile> = new Map();
  private _active: string = "code";

  constructor() {
    // Register all built-in profiles
    this.register(new RAGProfile());
    this.register(new CodeProfile());
    this.register(new DevOpsProfile());
    this.register(new GeneralProfile());
    this.register(new ResearchProfile());
    this.register(new SupportProfile());
    this.register(new AutomationProfile());
  }

  /** Register a profile — built-in or custom */
  register(profile: BaseProfile): this {
    this.profiles.set(profile.name, profile);
    return this;
  }

  /** Register custom profiles and switch to target profile atomically */
  registerCustomProfilesAndSwitch(
    customProfiles: Record<string, Omit<CustomProfileDefinition, "name">>,
    targetProfile: string,
    createProfileFn: (
      name: string,
      def: Omit<CustomProfileDefinition, "name">,
    ) => BaseProfile,
  ): BaseProfile {
    for (const [profileName, profileDef] of Object.entries(customProfiles)) {
      this.register(createProfileFn(profileName, profileDef));
    }
    return this.switch(targetProfile);
  }

  /** Switch active profile */
  switch(name: ProfileName): BaseProfile {
    const profile = this.get(name);
    this._active = name;
    console.log(`[ProfileManager] Switched to: ${name}`);
    return profile;
  }

  /** Get a profile by name */
  get(name: string): BaseProfile {
    const profile = this.profiles.get(name);
    if (!profile) {
      throw new Error(
        `ProfileManager: Unknown profile "${name}". Available: ${[...this.profiles.keys()].join(", ")}`,
      );
    }
    return profile;
  }

  /** Get active profile */
  getActive(): BaseProfile {
    return this.get(this._active);
  }

  getActiveName(): string {
    return this._active;
  }

  /** List all registered profile names */
  list(): string[] {
    return [...this.profiles.keys()];
  }

  /** Check if tool is allowed in active profile */
  isToolAllowed(toolName: string): boolean {
    return this.getActive().isToolAllowed(toolName);
  }

  /** Get allowed tools for active profile */
  getAllowedTools(allTools?: ToolDefinition[]): ToolDefinition[] {
    return this.getActive().getAllowedTools(allTools);
  }

  /** Build system prompt for active profile */
  buildSystemPrompt(baseContext: string = ""): string {
    return this.getActive().buildSystemPrompt(baseContext);
  }

  /** Get the planning prompt for the active profile */
  getPlanningPrompt(): string {
    return this.getActive().planningPrompt;
  }

  /** Ask the active profile whether to block file edits for this task */
  blocksFileEditsOnGit(task: string): boolean {
    return this.getActive().blocksFileEditsOnGit(task);
  }

  /** Add tools to the active profile's allowed tools list */
  addAllowedTools(toolNames: string[]): void {
    const activeProfile = this.getActive();
    const extendedProfile = Object.assign(
      Object.create(BaseProfile.prototype),
      {
        name: activeProfile.name,
        description: activeProfile.description,
        systemPrompt: activeProfile.systemPrompt,
        planningPrompt: activeProfile.planningPrompt,
        allowedTools: [...activeProfile.allowedTools, ...toolNames],
        styleRules: activeProfile.styleRules,
        safetyRules: activeProfile.safetyRules,
        userPrompt: (activeProfile as any).userPrompt,
      },
    );
    this.profiles.set(activeProfile.name, extendedProfile);
  }
}
