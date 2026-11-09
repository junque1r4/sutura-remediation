import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CLAUDE_MODEL } from '@sutura/common';

vi.mock('../../config', () => ({
  getConfig: vi.fn().mockReturnValue({
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    VOYAGE_API_KEY: 'test-voyage-key',
    PINECONE_API_KEY: 'test-pinecone-key',
    PINECONE_ENVIRONMENT: 'test-env',
  }),
}));

vi.mock('../../db/findings', () => ({
  getFinding: vi.fn(),
  updateFindingStatus: vi.fn(),
}));

vi.mock('../../db/organizations', () => ({
  getOrganization: vi.fn(),
}));

vi.mock('../../db/fix-attempts', () => ({
  createFixAttempt: vi.fn(),
  updateFixAttempt: vi.fn(),
}));

vi.mock('../../db/token-usage', () => ({
  createTokenUsage: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../db/audit-log', () => ({
  logAction: vi.fn(),
}));

vi.mock('@sutura/fix-engine', () => ({
  FixPipeline: vi.fn(),
}));

vi.mock('../connection', () => ({
  getRedisConnection: vi.fn().mockReturnValue({}),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
}));

import { startFixWorker } from '../workers/fix-worker';
import { Worker } from 'bullmq';
import { getFinding, updateFindingStatus } from '../../db/findings';
import { getOrganization } from '../../db/organizations';
import { createFixAttempt, updateFixAttempt } from '../../db/fix-attempts';
import { logAction } from '../../db/audit-log';
import { FixPipeline } from '@sutura/fix-engine';

const MockWorker = vi.mocked(Worker);

const mockDbFinding = {
  id: 'finding-1',
  org_id: 'org-1',
  scanner_source: 'aikido',
  external_id: 'ext-1',
  title: 'SQL Injection',
  description: 'A SQL injection vulnerability',
  severity: 'high',
  cvss_score: 8.5,
  epss_score: null,
  cwe_id: 'CWE-89',
  cve_id: null,
  file_path: '/src/app.ts',
  line_range: null,
  repo: 'org/repo',
  status: 'open',
  ingested_at: '2024-01-01T00:00:00Z',
  resolved_at: null,
};

const mockOrg = {
  id: 'org-1',
  name: 'Test Org',
  plan: 'pro',
  settings_json: { autoFixSeverityThreshold: 'high' },
  custom_prompts_json: { systemPrompt: 'Be helpful' },
  created_at: '2024-01-01T00:00:00Z',
};

const mockFixAttempt = {
  id: 'attempt-1',
  finding_id: 'finding-1',
  org_id: 'org-1',
  prompt_snapshot: '',
  generated_diff: null,
  test_result: null,
  pr_url: null,
  pr_status: null,
  claude_model: 'claude-sonnet-4-20250514',
  claude_tokens_used: 0,
  created_at: '2024-01-01T00:00:00Z',
  completed_at: null,
};

const mockPipelineResult = {
  skipped: false,
  reason: undefined,
  fixAttempt: {
    generatedDiff: '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-bad\n+good',
    testResult: 'passed',
    prUrl: 'https://github.com/org/repo/pull/1',
    prStatus: 'open',
    claudeTokensUsed: 1234,
  },
};

function getProcessor(): (job: any) => Promise<any> {
  startFixWorker();
  const workerCall = MockWorker.mock.calls[MockWorker.mock.calls.length - 1];
  return workerCall[1] as (job: any) => Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getFinding).mockResolvedValue(mockDbFinding as any);
  vi.mocked(getOrganization).mockResolvedValue(mockOrg as any);
  vi.mocked(createFixAttempt).mockResolvedValue(mockFixAttempt as any);
  vi.mocked(updateFixAttempt).mockResolvedValue(mockFixAttempt as any);
  vi.mocked(updateFindingStatus).mockResolvedValue(mockDbFinding as any);
  vi.mocked(logAction).mockResolvedValue(undefined as any);

  const mockExecute = vi.fn().mockResolvedValue(mockPipelineResult);
  vi.mocked(FixPipeline).mockImplementation(function () {
    return { execute: mockExecute } as any;
  });
});

describe('startFixWorker', () => {
  it('creates a Worker on "fix-queue"', () => {
    startFixWorker();
    expect(MockWorker).toHaveBeenCalledWith('fix-queue', expect.any(Function), expect.any(Object));
  });

  it('returns the Worker instance', () => {
    const mockWorkerInstance = { id: 'worker-instance' };
    MockWorker.mockImplementation(function () {
      return mockWorkerInstance as any;
    });

    const result = startFixWorker();

    expect(result).toBe(mockWorkerInstance);
  });
});

describe('fix-worker processor', () => {
  it('fetches finding and org from DB', async () => {
    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(getFinding).toHaveBeenCalledWith('finding-1');
    expect(getOrganization).toHaveBeenCalledWith('org-1');
  });

  it('throws if finding not found', async () => {
    vi.mocked(getFinding).mockResolvedValue(null);

    const processor = getProcessor();

    await expect(processor({ data: { findingId: 'missing', orgId: 'org-1' } })).rejects.toThrow(
      'Finding missing not found',
    );
  });

  it('throws if organization not found', async () => {
    vi.mocked(getOrganization).mockResolvedValue(null);

    const processor = getProcessor();

    await expect(
      processor({ data: { findingId: 'finding-1', orgId: 'missing-org' } }),
    ).rejects.toThrow('Organization missing-org not found');
  });

  it('updates finding status to "fixing"', async () => {
    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(updateFindingStatus).toHaveBeenCalledWith('finding-1', 'fixing');
  });

  it('creates a fix attempt record', async () => {
    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(createFixAttempt).toHaveBeenCalledWith({
      finding_id: 'finding-1',
      org_id: 'org-1',
      prompt_snapshot: '',
      claude_model: DEFAULT_CLAUDE_MODEL,
    });
  });

  it('executes FixPipeline with finding, orgId, and org settings', async () => {
    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    const pipelineInstance = vi.mocked(FixPipeline).mock.results[0].value;
    expect(pipelineInstance.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'ext-1',
        scanner: 'aikido',
        title: 'SQL Injection',
        severity: 'high',
        repo: 'org/repo',
      }),
      'org-1',
      mockOrg.custom_prompts_json,
      mockOrg.settings_json?.autoFixSeverityThreshold,
    );
  });

  it('updates fix attempt with pipeline results', async () => {
    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(updateFixAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        generated_diff: mockPipelineResult.fixAttempt.generatedDiff,
        test_result: mockPipelineResult.fixAttempt.testResult,
        pr_url: mockPipelineResult.fixAttempt.prUrl,
        pr_status: mockPipelineResult.fixAttempt.prStatus,
        claude_tokens_used: mockPipelineResult.fixAttempt.claudeTokensUsed,
        completed_at: expect.any(String),
      }),
    );
  });

  it('updates finding status to "fixed" when not skipped', async () => {
    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    // Called twice: once with 'fixing', once with 'fixed'
    expect(updateFindingStatus).toHaveBeenCalledWith('finding-1', 'fixed');
  });

  it('updates finding status to "open" when pipeline skipped', async () => {
    const skippedResult = { ...mockPipelineResult, skipped: true, reason: 'Below threshold' };
    const mockExecute = vi.fn().mockResolvedValue(skippedResult);
    vi.mocked(FixPipeline).mockImplementation(function () {
      return { execute: mockExecute } as any;
    });

    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(updateFindingStatus).toHaveBeenCalledWith('finding-1', 'open');
  });

  it('logs audit action with fix.completed when not skipped', async () => {
    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: 'org-1',
        actor: 'fix-worker',
        action: 'fix.completed',
        resource_type: 'finding',
        resource_id: 'finding-1',
      }),
    );
  });

  it('logs audit action with fix.skipped when pipeline skipped', async () => {
    const skippedResult = { ...mockPipelineResult, skipped: true, reason: 'Below threshold' };
    const mockExecute = vi.fn().mockResolvedValue(skippedResult);
    vi.mocked(FixPipeline).mockImplementation(function () {
      return { execute: mockExecute } as any;
    });

    const processor = getProcessor();
    await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'fix.skipped' }));
  });

  it('returns fixAttemptId and skipped on success', async () => {
    const processor = getProcessor();
    const result = await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

    expect(result).toEqual({ fixAttemptId: 'attempt-1', skipped: false });
  });

  describe('error handling', () => {
    it('sets finding status to "failed" when pipeline throws', async () => {
      const mockExecute = vi.fn().mockRejectedValue(new Error('Pipeline exploded'));
      vi.mocked(FixPipeline).mockImplementation(function () {
        return { execute: mockExecute } as any;
      });

      const processor = getProcessor();

      await expect(processor({ data: { findingId: 'finding-1', orgId: 'org-1' } })).rejects.toThrow(
        'Pipeline exploded',
      );

      expect(updateFindingStatus).toHaveBeenCalledWith('finding-1', 'failed');
    });

    it('marks fix attempt as completed on error', async () => {
      const mockExecute = vi.fn().mockRejectedValue(new Error('Pipeline exploded'));
      vi.mocked(FixPipeline).mockImplementation(function () {
        return { execute: mockExecute } as any;
      });

      const processor = getProcessor();

      await expect(
        processor({ data: { findingId: 'finding-1', orgId: 'org-1' } }),
      ).rejects.toThrow();

      expect(updateFixAttempt).toHaveBeenCalledWith(
        'attempt-1',
        expect.objectContaining({ completed_at: expect.any(String) }),
      );
    });

    it('logs fix.failed audit action on error', async () => {
      const mockExecute = vi.fn().mockRejectedValue(new Error('Pipeline exploded'));
      vi.mocked(FixPipeline).mockImplementation(function () {
        return { execute: mockExecute } as any;
      });

      const processor = getProcessor();

      await expect(
        processor({ data: { findingId: 'finding-1', orgId: 'org-1' } }),
      ).rejects.toThrow();

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'fix.failed',
          metadata_json: expect.objectContaining({ error: 'Pipeline exploded' }),
        }),
      );
    });

    it('re-throws the original error after cleanup', async () => {
      const originalError = new Error('Original error');
      const mockExecute = vi.fn().mockRejectedValue(originalError);
      vi.mocked(FixPipeline).mockImplementation(function () {
        return { execute: mockExecute } as any;
      });

      const processor = getProcessor();

      await expect(processor({ data: { findingId: 'finding-1', orgId: 'org-1' } })).rejects.toBe(
        originalError,
      );
    });
  });

  describe('line_range parsing', () => {
    it('parses line_range from postgres int4range format', async () => {
      vi.mocked(getFinding).mockResolvedValue({
        ...mockDbFinding,
        line_range: '[10,20]',
      } as any);

      const processor = getProcessor();
      await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

      const pipelineInstance = vi.mocked(FixPipeline).mock.results[0].value;
      expect(pipelineInstance.execute).toHaveBeenCalledWith(
        expect.objectContaining({ lineRange: [10, 20] }),
        expect.any(String),
        expect.any(Object),
        expect.anything(),
      );
    });

    it('leaves lineRange undefined when line_range is null', async () => {
      vi.mocked(getFinding).mockResolvedValue({
        ...mockDbFinding,
        line_range: null,
      } as any);

      const processor = getProcessor();
      await processor({ data: { findingId: 'finding-1', orgId: 'org-1' } });

      const pipelineInstance = vi.mocked(FixPipeline).mock.results[0].value;
      expect(pipelineInstance.execute).toHaveBeenCalledWith(
        expect.objectContaining({ lineRange: undefined }),
        expect.any(String),
        expect.any(Object),
        expect.anything(),
      );
    });
  });
});
