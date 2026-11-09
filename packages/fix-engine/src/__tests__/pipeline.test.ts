import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding, Severity } from '@sutura/common';

vi.mock('../pipeline/triage', () => ({ triage: vi.fn() }));
vi.mock('../pipeline/context', () => ({ retrieveContext: vi.fn() }));
vi.mock('../pipeline/prompt', () => ({ assemblePrompt: vi.fn() }));
vi.mock('../pipeline/generator', () => ({ generateFix: vi.fn() }));
vi.mock('../pipeline/submitter', () => ({ submitFix: vi.fn() }));

import { FixPipeline } from '../pipeline/index';
import { triage } from '../pipeline/triage';
import { retrieveContext } from '../pipeline/context';
import { assemblePrompt } from '../pipeline/prompt';
import { generateFix } from '../pipeline/generator';
import { submitFix } from '../pipeline/submitter';

function makeFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    externalId: 'finding-abc',
    scanner: 'snyk',
    title: 'SQL Injection',
    description: 'A SQL injection vulnerability',
    severity: 'high',
    repo: 'owner/repo',
    rawPayload: {},
    ...overrides,
  };
}

const baseConfig = {
  anthropicApiKey: 'anthropic-key',
  voyageApiKey: 'voyage-key',
  pineconeApiKey: 'pinecone-key',
  githubToken: 'gh-token',
};

const mockContext = {
  finding: makeFinding(),
  orgId: 'org-1',
  customPrompts: {},
  relevantCode: ['chunk1'],
  vulnerableFileContent: 'const x = 1;',
};

const mockGenerateResult = {
  diff: '--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1 +1 @@\n-old\n+new',
  model: 'claude-sonnet-4-20250514',
  tokensUsed: 1500,
  inputTokens: 1000,
  outputTokens: 500,
  promptSnapshot: 'assembled prompt text',
  responseText: 'mock response text',
};

const mockSubmitResult = {
  prUrl: 'https://github.com/owner/repo/pull/42',
  prStatus: 'open' as const,
  branchName: 'sutura/fix-findinab',
};

beforeEach(() => {
  vi.clearAllMocks();

  (triage as ReturnType<typeof vi.fn>).mockReturnValue({ finding: makeFinding(), shouldFix: true });
  (retrieveContext as ReturnType<typeof vi.fn>).mockResolvedValue(mockContext);
  (assemblePrompt as ReturnType<typeof vi.fn>).mockReturnValue('assembled prompt text');
  (generateFix as ReturnType<typeof vi.fn>).mockResolvedValue(mockGenerateResult);
  (submitFix as ReturnType<typeof vi.fn>).mockResolvedValue(mockSubmitResult);
});

describe('FixPipeline', () => {
  describe('happy path', () => {
    it('runs full pipeline and returns PipelineResult with fixAttempt data', async () => {
      const pipeline = new FixPipeline(baseConfig);
      const finding = makeFinding();
      const result = await pipeline.execute(finding, 'org-1');

      expect(result.skipped).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(result.fixAttempt).toMatchObject({
        findingId: 'finding-abc',
        orgId: 'org-1',
        promptSnapshot: 'assembled prompt text',
        generatedDiff: mockGenerateResult.diff,
        prUrl: mockSubmitResult.prUrl,
        prStatus: 'open',
        claudeModel: 'claude-sonnet-4-20250514',
        claudeTokensUsed: 1500,
      });
    });

    it('calls all pipeline steps in order', async () => {
      const pipeline = new FixPipeline(baseConfig);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1');

      expect(triage).toHaveBeenCalled();
      expect(retrieveContext).toHaveBeenCalled();
      expect(assemblePrompt).toHaveBeenCalled();
      expect(generateFix).toHaveBeenCalled();
      expect(submitFix).toHaveBeenCalled();
    });
  });

  describe('triage returns shouldFix=false', () => {
    it('returns skipped=true with reason and skips all subsequent steps', async () => {
      (triage as ReturnType<typeof vi.fn>).mockReturnValue({
        finding: makeFinding(),
        shouldFix: false,
        reason: 'Severity low is below auto-fix threshold medium',
      });

      const pipeline = new FixPipeline(baseConfig);
      const result = await pipeline.execute(makeFinding(), 'org-1');

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('Severity low is below auto-fix threshold medium');
      expect(retrieveContext).not.toHaveBeenCalled();
      expect(assemblePrompt).not.toHaveBeenCalled();
      expect(generateFix).not.toHaveBeenCalled();
      expect(submitFix).not.toHaveBeenCalled();
    });

    it('returns fixAttempt with empty values when skipped', async () => {
      (triage as ReturnType<typeof vi.fn>).mockReturnValue({
        finding: makeFinding(),
        shouldFix: false,
        reason: 'below threshold',
      });

      const pipeline = new FixPipeline(baseConfig);
      const result = await pipeline.execute(makeFinding(), 'org-1');

      expect(result.fixAttempt).toMatchObject({
        findingId: 'finding-abc',
        orgId: 'org-1',
        promptSnapshot: '',
        generatedDiff: '',
        testResult: 'skip',
        claudeModel: '',
        claudeTokensUsed: 0,
      });
    });
  });

  describe('submit fails', () => {
    it('still returns result with fixAttempt but no prUrl', async () => {
      (submitFix as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GitHub API error'));

      const pipeline = new FixPipeline(baseConfig);
      const result = await pipeline.execute(makeFinding(), 'org-1');

      expect(result.skipped).toBe(false);
      expect(result.fixAttempt.prUrl).toBeUndefined();
      expect(result.fixAttempt.prStatus).toBeUndefined();
      // But diff and model should still be recorded
      expect(result.fixAttempt.generatedDiff).toBe(mockGenerateResult.diff);
      expect(result.fixAttempt.claudeModel).toBe('claude-sonnet-4-20250514');
      expect(result.fixAttempt.claudeTokensUsed).toBe(1500);
    });

    it('does not throw when submit fails', async () => {
      (submitFix as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      const pipeline = new FixPipeline(baseConfig);
      await expect(pipeline.execute(makeFinding(), 'org-1')).resolves.not.toThrow();
    });
  });

  describe('config forwarding', () => {
    it('forwards githubToken, voyageApiKey, pineconeApiKey to retrieveContext', async () => {
      const config = {
        ...baseConfig,
        voyageApiKey: 'my-voyage',
        pineconeApiKey: 'my-pinecone',
        githubToken: 'my-gh-token',
      };
      const pipeline = new FixPipeline(config);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1');

      expect(retrieveContext).toHaveBeenCalledWith(
        finding,
        'org-1',
        expect.anything(),
        {
          voyageApiKey: 'my-voyage',
          pineconeApiKey: 'my-pinecone',
          githubToken: 'my-gh-token',
        },
      );
    });

    it('forwards anthropicApiKey to generateFix', async () => {
      const config = { ...baseConfig, anthropicApiKey: 'my-anthropic-key' };
      const pipeline = new FixPipeline(config);
      await pipeline.execute(makeFinding(), 'org-1');

      expect(generateFix).toHaveBeenCalledWith(expect.any(String), 'my-anthropic-key');
    });

    it('forwards targetBranch to submitFix', async () => {
      const config = { ...baseConfig, targetBranch: 'develop' };
      const pipeline = new FixPipeline(config);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1');

      expect(submitFix).toHaveBeenCalledWith(
        finding.repo,
        expect.any(String),
        finding.externalId,
        finding.title,
        finding.severity,
        expect.any(String),
        baseConfig.githubToken,
        'develop',
        undefined,
      );
    });

    it('forwards reviewers to submitFix', async () => {
      const config = { ...baseConfig, reviewers: ['alice', 'bob'] };
      const pipeline = new FixPipeline(config);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1');

      expect(submitFix).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        undefined,
        ['alice', 'bob'],
      );
    });
  });

  describe('custom prompts', () => {
    it('forwards custom prompts to retrieveContext', async () => {
      const customPrompts = { systemPrompt: 'Be thorough.' };
      const pipeline = new FixPipeline(baseConfig);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1', customPrompts);

      expect(retrieveContext).toHaveBeenCalledWith(
        finding,
        'org-1',
        customPrompts,
        expect.any(Object),
      );
    });

    it('uses empty object as default for customPrompts', async () => {
      const pipeline = new FixPipeline(baseConfig);
      await pipeline.execute(makeFinding(), 'org-1');

      expect(retrieveContext).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {},
        expect.anything(),
      );
    });
  });

  describe('auto-fix threshold', () => {
    it('forwards autoFixThreshold to triage', async () => {
      const pipeline = new FixPipeline(baseConfig);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1', {}, 'critical' as Severity);

      expect(triage).toHaveBeenCalledWith(finding, 'critical');
    });

    it('forwards undefined autoFixThreshold to triage when not provided', async () => {
      const pipeline = new FixPipeline(baseConfig);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1');

      expect(triage).toHaveBeenCalledWith(finding, undefined);
    });
  });

  describe('token usage tracking', () => {
    it('records tokensUsed from generateFix result', async () => {
      (generateFix as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockGenerateResult,
        tokensUsed: 9999,
      });

      const pipeline = new FixPipeline(baseConfig);
      const result = await pipeline.execute(makeFinding(), 'org-1');

      expect(result.fixAttempt.claudeTokensUsed).toBe(9999);
    });

    it('records model from generateFix result', async () => {
      (generateFix as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockGenerateResult,
        model: 'claude-opus-4',
      });

      const pipeline = new FixPipeline(baseConfig);
      const result = await pipeline.execute(makeFinding(), 'org-1');

      expect(result.fixAttempt.claudeModel).toBe('claude-opus-4');
    });
  });

  describe('diff from generateFix', () => {
    it('includes diff from generateFix in fixAttempt.generatedDiff', async () => {
      const diff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y';
      (generateFix as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockGenerateResult,
        diff,
      });

      const pipeline = new FixPipeline(baseConfig);
      const result = await pipeline.execute(makeFinding(), 'org-1');

      expect(result.fixAttempt.generatedDiff).toBe(diff);
    });

    it('skips submitFix when generateFix returns empty diff', async () => {
      (generateFix as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockGenerateResult,
        diff: '',
      });

      const pipeline = new FixPipeline(baseConfig);
      await pipeline.execute(makeFinding(), 'org-1');

      expect(submitFix).not.toHaveBeenCalled();
    });

    it('passes diff from generateFix to submitFix', async () => {
      const diff = '--- a/bar.ts\n+++ b/bar.ts\n@@ -2 +2 @@\n-bad\n+good';
      (generateFix as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockGenerateResult,
        diff,
      });

      const pipeline = new FixPipeline(baseConfig);
      const finding = makeFinding();
      await pipeline.execute(finding, 'org-1');

      expect(submitFix).toHaveBeenCalledWith(
        finding.repo,
        diff,
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        // targetBranch and reviewers are undefined when not set in config
        undefined,
        undefined,
      );
    });

    it('passes promptSnapshot from assemblePrompt to fixAttempt', async () => {
      (assemblePrompt as ReturnType<typeof vi.fn>).mockReturnValue('my custom assembled prompt');
      (generateFix as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockGenerateResult,
        promptSnapshot: 'my custom assembled prompt',
      });

      const pipeline = new FixPipeline(baseConfig);
      const result = await pipeline.execute(makeFinding(), 'org-1');

      expect(result.fixAttempt.promptSnapshot).toBe('my custom assembled prompt');
    });
  });

  describe('context passed to assemblePrompt', () => {
    it('passes context returned from retrieveContext to assemblePrompt', async () => {
      const ctx = { ...mockContext, relevantCode: ['special chunk'] };
      (retrieveContext as ReturnType<typeof vi.fn>).mockResolvedValue(ctx);

      const pipeline = new FixPipeline(baseConfig);
      await pipeline.execute(makeFinding(), 'org-1');

      expect(assemblePrompt).toHaveBeenCalledWith(ctx);
    });

    it('passes assembled prompt to generateFix', async () => {
      (assemblePrompt as ReturnType<typeof vi.fn>).mockReturnValue('the final prompt');

      const pipeline = new FixPipeline(baseConfig);
      await pipeline.execute(makeFinding(), 'org-1');

      expect(generateFix).toHaveBeenCalledWith('the final prompt', expect.any(String));
    });
  });
});
