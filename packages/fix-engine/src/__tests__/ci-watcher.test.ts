import { describe, expect, it, vi, beforeEach } from 'vitest';
import { awaitCiVerdict } from '../pipeline/ci-watcher';

// Mock @octokit/rest before importing ci-watcher; vi.mock is hoisted.
const checksListForRef = vi.fn();
const listWorkflowRunsForRepo = vi.fn();
const listJobsForWorkflowRun = vi.fn();
const downloadJobLogsForWorkflowRun = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      checks: { listForRef: checksListForRef },
      actions: {
        listWorkflowRunsForRepo,
        listJobsForWorkflowRun,
        downloadJobLogsForWorkflowRun,
      },
    };
  }),
}));

const baseInput = {
  githubToken: 'tok',
  repo: 'acme/widget',
  headSha: 'abc1234',
  pollIntervalMs: 1, // tight loop in tests
  timeoutMs: 60_000,
};

describe('awaitCiVerdict', () => {
  beforeEach(() => {
    checksListForRef.mockReset();
    listWorkflowRunsForRepo.mockReset();
    listJobsForWorkflowRun.mockReset();
    downloadJobLogsForWorkflowRun.mockReset();
  });

  it('returns unavailable (not a throw) when the app lacks Checks: Read', async () => {
    const err = Object.assign(new Error('Resource not accessible by integration'), {
      status: 403,
    });
    checksListForRef.mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await awaitCiVerdict(baseInput);
      expect(r.verdict).toBe('unavailable');
      expect(r.failureLogs).toBe('');
      // A permission 403 cannot heal; one call is enough.
      expect(checksListForRef).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join(' ')).toContain('Checks');
    } finally {
      warn.mockRestore();
    }
  });

  it('retries transient listForRef errors and then reports unavailable', async () => {
    checksListForRef.mockRejectedValue(new Error('ECONNRESET'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await awaitCiVerdict(baseInput);
      expect(r.verdict).toBe('unavailable');
      expect(checksListForRef.mock.calls.length).toBeGreaterThan(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns success when all check_runs complete with conclusion=success', async () => {
    checksListForRef.mockResolvedValueOnce({
      data: {
        check_runs: [
          { status: 'completed', conclusion: 'success', name: 'build' },
          { status: 'completed', conclusion: 'success', name: 'lint' },
        ],
      },
    });
    const r = await awaitCiVerdict(baseInput);
    expect(r.verdict).toBe('success');
    expect(r.failureLogs).toBe('');
  });

  it('waits for in-progress checks before deciding', async () => {
    checksListForRef
      .mockResolvedValueOnce({
        data: {
          check_runs: [{ status: 'in_progress', conclusion: null, name: 'build' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [{ status: 'completed', conclusion: 'success', name: 'build' }],
        },
      });
    const r = await awaitCiVerdict(baseInput);
    expect(r.verdict).toBe('success');
    expect(checksListForRef).toHaveBeenCalledTimes(2);
  });

  it('declares success after several empty polls (no CI configured)', async () => {
    checksListForRef.mockResolvedValue({ data: { check_runs: [] } });
    const r = await awaitCiVerdict(baseInput);
    expect(r.verdict).toBe('success');
    // 4 empty polls trigger the "no CI configured" early-out
    expect(checksListForRef).toHaveBeenCalledTimes(4);
  });

  it('returns timed_out when timeout fires before checks complete', async () => {
    checksListForRef.mockResolvedValue({
      data: {
        check_runs: [{ status: 'in_progress', conclusion: null, name: 'build' }],
      },
    });
    const r = await awaitCiVerdict({ ...baseInput, timeoutMs: 50, pollIntervalMs: 30 });
    expect(r.verdict).toBe('timed_out');
  });

  it('on failure fetches logs from the matching workflow run', async () => {
    checksListForRef.mockResolvedValueOnce({
      data: {
        check_runs: [{ status: 'completed', conclusion: 'failure', name: 'build' }],
      },
    });
    listWorkflowRunsForRepo.mockResolvedValueOnce({
      data: {
        workflow_runs: [{ id: 999, name: 'CI', conclusion: 'failure' }],
      },
    });
    listJobsForWorkflowRun.mockResolvedValueOnce({
      data: {
        jobs: [{ id: 42, name: 'build', conclusion: 'failure' }],
      },
    });
    downloadJobLogsForWorkflowRun.mockResolvedValueOnce({
      data: '##[error] tsc found 3 errors\nsrc/x.ts(10,5): error TS2304: Cannot find name foo.\n',
    });

    const r = await awaitCiVerdict(baseInput);
    expect(r.verdict).toBe('failure');
    expect(r.failureLogs).toContain('CI / build (job 42, failure)');
    expect(r.failureLogs).toContain('TS2304');
  });

  it('falls back to a check-name summary when actions API yields no logs', async () => {
    checksListForRef.mockResolvedValueOnce({
      data: {
        check_runs: [{ status: 'completed', conclusion: 'failure', name: 'license-compliance' }],
      },
    });
    listWorkflowRunsForRepo.mockResolvedValueOnce({
      data: { workflow_runs: [] },
    });
    const r = await awaitCiVerdict(baseInput);
    expect(r.verdict).toBe('failure');
    expect(r.failureLogs).toContain('check-run summary');
    expect(r.failureLogs).toContain('license-compliance');
  });

  it('truncates very long logs to head + tail', async () => {
    const huge = 'A'.repeat(50_000);
    checksListForRef.mockResolvedValueOnce({
      data: {
        check_runs: [{ status: 'completed', conclusion: 'failure', name: 'build' }],
      },
    });
    listWorkflowRunsForRepo.mockResolvedValueOnce({
      data: { workflow_runs: [{ id: 1, name: 'CI', conclusion: 'failure' }] },
    });
    listJobsForWorkflowRun.mockResolvedValueOnce({
      data: { jobs: [{ id: 1, name: 'build', conclusion: 'failure' }] },
    });
    downloadJobLogsForWorkflowRun.mockResolvedValueOnce({ data: huge });

    const r = await awaitCiVerdict(baseInput);
    expect(r.failureLogs).toContain('bytes truncated');
    expect(r.failureLogs.length).toBeLessThan(huge.length);
  });
});
