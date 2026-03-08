/**
 * Pipeline execution logic
 */

import {
  AgentConfig,
  PipelineStep,
  PipelineResult,
  PipelineStepResult,
  AgentResult,
} from "../AgentEngine";

export class PipelineRunner {
  private config: AgentConfig;
  private profile: string;
  private runFn: (
    task: string,
    overrides?: Partial<AgentConfig>,
  ) => Promise<AgentResult>;
  private switchProfileFn?: (name: string) => void;

  constructor(
    config: AgentConfig,
    profile: string,
    runFn: (
      task: string,
      overrides?: Partial<AgentConfig>,
    ) => Promise<AgentResult>,
  ) {
    this.config = config;
    this.profile = profile;
    this.runFn = runFn;
  }

  setSwitchProfile(fn: (name: string) => void) {
    this.switchProfileFn = fn;
  }

  async runPipeline(steps: PipelineStep[]): Promise<PipelineResult> {
    const { onMessage } = this.config;
    const stepResults: PipelineStepResult[] = [];
    const allFilesChanged: string[] = [];
    const allToolsUsed: string[] = [];
    let totalTurns = 0;
    const defaultProvider = this.config.provider;
    const defaultProfile = this.profile;

    const sharedContextLines: string[] = [];
    const buildSharedContext = (): string =>
      sharedContextLines.length
        ? `\n\n## Pipeline context (what previous steps did)\n${sharedContextLines.join("\n")}`
        : "";

    onMessage({
      type: "pipelineStart",
      text: `🔀 Pipeline: ${steps.length} steps`,
      totalSteps: steps.length,
    });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 1;
      const provider = step.provider ?? defaultProvider;
      const profile = step.profile ?? defaultProfile;

      onMessage({
        type: "pipelineStep",
        text: `▶ Step ${stepNum}/${steps.length}: ${step.task}`,
        step: stepNum,
        total: steps.length,
        provider,
        profile,
      });

      if (profile !== this.profile && this.switchProfileFn) {
        this.switchProfileFn(profile);
        this.profile = profile;
      }

      const stepOverrides: Partial<AgentConfig> = {
        provider,
        systemPrompt: step.systemPrompt ?? this.config.systemPrompt,
        planningPrompt: step.planningPrompt ?? this.config.planningPrompt,
        userPrompt:
          [
            step.userPrompt ?? this.config.userPrompt ?? "",
            buildSharedContext(),
          ]
            .filter(Boolean)
            .join("\n\n") || undefined,
      };

      let result: AgentResult;
      try {
        result = await this.runFn(step.task, stepOverrides);
      } catch (err: any) {
        // wrap profile restoration in its own try/catch.
        // Previously, if switchProfileFn threw (e.g. unknown profile name),
        // the error was unhandled and the active profile was permanently wrong.
        if (this.switchProfileFn && this.profile !== defaultProfile) {
          try {
            this.switchProfileFn(defaultProfile);
            this.profile = defaultProfile;
          } catch (profileErr) {
            console.error(
              `[Pipeline] Profile restore failed after step ${stepNum} error:`,
              profileErr,
            );
          }
        }
        const failResult: PipelineResult = {
          success: false,
          steps: stepResults,
          summary: `Pipeline failed at step ${stepNum}: ${err.message}`,
          totalTurnsUsed: totalTurns,
          totalFilesChanged: allFilesChanged,
          totalToolsUsed: allToolsUsed,
          failedAtStep: stepNum,
        };
        onMessage({ type: "pipelineError", text: failResult.summary });
        return failResult;
      }

      const cleanSummary = result.summary
        .replace(/\*\*/g, "")
        .replace(/||🔀|▶/g, "")
        .trim()
        .split("\n")[0]
        .slice(0, 200);

      sharedContextLines.push(
        `Step ${stepNum} [${provider}/${profile}]: ${step.task}`,
      );
      if (result.filesChanged.length) {
        sharedContextLines.push(
          `  Files changed: ${result.filesChanged.join(", ")}`,
        );
      }
      if (result.toolsUsed.length) {
        sharedContextLines.push(
          `  Tools used: ${result.toolsUsed.join(" → ")}`,
        );
      }
      sharedContextLines.push(`  Result: ${cleanSummary}`);

      stepResults.push({
        step: stepNum,
        task: step.task,
        provider,
        profile,
        result,
      });
      allFilesChanged.push(...result.filesChanged);
      allToolsUsed.push(...result.toolsUsed);
      totalTurns += result.turnsUsed;

      onMessage({
        type: "pipelineStepDone",
        text: ` Step ${stepNum} complete (${provider}/${profile})`,
        step: stepNum,
        success: result.success,
      });

      if (!result.success) {
        if (this.switchProfileFn && this.profile !== defaultProfile) {
          this.switchProfileFn(defaultProfile);
          this.profile = defaultProfile;
        }
        const failResult: PipelineResult = {
          success: false,
          steps: stepResults,
          summary: this._buildPipelineSummary(stepResults, false),
          totalTurnsUsed: totalTurns,
          totalFilesChanged: [...new Set(allFilesChanged)],
          totalToolsUsed: allToolsUsed,
          failedAtStep: stepNum,
        };
        onMessage({
          type: "pipelineError",
          text: `Pipeline stopped at step ${stepNum}`,
        });
        return failResult;
      }
    }

    if (this.switchProfileFn && this.profile !== defaultProfile) {
      this.switchProfileFn(defaultProfile);
      this.profile = defaultProfile;
    }

    const pipelineResult: PipelineResult = {
      success: true,
      steps: stepResults,
      summary: this._buildPipelineSummary(stepResults, true),
      totalTurnsUsed: totalTurns,
      totalFilesChanged: [...new Set(allFilesChanged)],
      totalToolsUsed: allToolsUsed,
      failedAtStep: -1,
    };

    onMessage({ type: "pipelineDone", text: pipelineResult.summary });
    return pipelineResult;
  }

  private _buildPipelineSummary(
    steps: PipelineStepResult[],
    success: boolean,
  ): string {
    const header = success
      ? ` **Pipeline complete** (${steps.length} steps)`
      : ` **Pipeline stopped** at step ${steps.findIndex((s) => !s.result.success) + 1}/${steps.length}`;

    const stepLines = steps
      .map((s) => {
        const icon = s.result.success ? "" : "";
        const clean = s.result.summary
          .replace(/\*\*/g, "")
          .replace(/|/g, "")
          .trim()
          .split("\n")[0]
          .slice(0, 120);
        return `${icon} Step ${s.step} [${s.provider}/${s.profile}]: ${clean}`;
      })
      .join("\n");

    return `${header}\n\n${stepLines}`;
  }
}
