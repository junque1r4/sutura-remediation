import type { NormalizedFinding, FixAttempt, CustomPrompts, Severity } from '@sutura/common';
import { triage } from './triage';
import { retrieveContext } from './context';
import { assemblePrompt } from './prompt';
import { generateFix } from './generator';
import { submitFix } from './submitter';

export interface PipelineConfig {
  anthropicApiKey: string;
  voyageApiKey: string;
  pineconeApiKey: string;
  githubToken: string;
  targetBranch?: string;
  reviewers?: string[];
}

export interface PipelineTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  prompt: string;
  response: string;
}

export interface PipelineResult {
  fixAttempt: Omit<FixAttempt, 'id' | 'createdAt'>;
  skipped: boolean;
  reason?: string;
  tokenUsage?: PipelineTokenUsage;
}

export class FixPipeline {
  constructor(private config: PipelineConfig) {}

  async execute(
    finding: NormalizedFinding,
    orgId: string,
    customPrompts: CustomPrompts = {},
    autoFixThreshold?: Severity,
  ): Promise<PipelineResult> {
    // 1. Triage
    const triageResult = triage(finding, autoFixThreshold);
    if (!triageResult.shouldFix) {
      return {
        fixAttempt: {
          findingId: finding.externalId,
          orgId,
          promptSnapshot: '',
          generatedDiff: '',
          testResult: 'skip',
          claudeModel: '',
          claudeTokensUsed: 0,
        },
        skipped: true,
        reason: triageResult.reason,
      };
    }

    // 2. Retrieve context
    const ctx = await retrieveContext(finding, orgId, customPrompts, {
      voyageApiKey: this.config.voyageApiKey,
      pineconeApiKey: this.config.pineconeApiKey,
      githubToken: this.config.githubToken,
    });

    // 3. Assemble prompt
    const prompt = assemblePrompt(ctx);

    // 4. Generate fix
    const generated = await generateFix(prompt, this.config.anthropicApiKey);

    // 5. Submit as PR (non-fatal on failure)
    let prUrl: string | undefined;
    let prStatus: 'open' | undefined;

    if (generated.diff) {
      try {
        const submitResult = await submitFix(
          finding.repo,
          generated.diff,
          finding.externalId,
          finding.title,
          finding.severity,
          generated.model,
          this.config.githubToken,
          this.config.targetBranch,
          this.config.reviewers,
        );
        prUrl = submitResult.prUrl;
        prStatus = submitResult.prStatus;
      } catch {
        // non-fatal: record fix attempt even if PR submission fails
      }
    }

    // 6. Return PipelineResult
    return {
      fixAttempt: {
        findingId: finding.externalId,
        orgId,
        promptSnapshot: generated.promptSnapshot,
        generatedDiff: generated.diff,
        testResult: 'skip',
        prUrl,
        prStatus,
        claudeModel: generated.model,
        claudeTokensUsed: generated.tokensUsed,
      },
      skipped: false,
      tokenUsage: {
        model: generated.model,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        prompt: generated.promptSnapshot,
        response: generated.responseText,
      },
    };
  }
}

export type { TriageResult } from './triage';
export type { FixContext } from './context';
export type { GenerateResult } from './generator';
export type { SubmitResult } from './submitter';
