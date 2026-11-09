import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted, factories cannot reference variables declared before them
vi.mock('../queues', () => ({
  getFixQueue: vi.fn(),
}));

import { getFixJobStatus } from '../status';
import { getFixQueue } from '../queues';

const mockGetJob = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFixQueue).mockReturnValue({ getJob: mockGetJob } as any);
});

describe('getFixJobStatus', () => {
  it('returns { state: "unknown", progress: 0 } when job not found', async () => {
    mockGetJob.mockResolvedValue(null);

    const result = await getFixJobStatus('missing-job');

    expect(result).toEqual({
      id: 'missing-job',
      state: 'unknown',
      progress: 0,
      result: null,
      error: undefined,
    });
  });

  it('returns job state, progress, result, and error when job found', async () => {
    const mockJob = {
      getState: vi.fn().mockResolvedValue('completed'),
      progress: 100,
      returnvalue: { fixAttemptId: 'attempt-1', skipped: false },
      failedReason: undefined,
    };
    mockGetJob.mockResolvedValue(mockJob);

    const result = await getFixJobStatus('job-1');

    expect(result).toEqual({
      id: 'job-1',
      state: 'completed',
      progress: 100,
      result: { fixAttemptId: 'attempt-1', skipped: false },
      error: undefined,
    });
  });

  it('returns error from failedReason when job failed', async () => {
    const mockJob = {
      getState: vi.fn().mockResolvedValue('failed'),
      progress: 0,
      returnvalue: null,
      failedReason: 'Finding not found',
    };
    mockGetJob.mockResolvedValue(mockJob);

    const result = await getFixJobStatus('job-failed');

    expect(result).toEqual({
      id: 'job-failed',
      state: 'failed',
      progress: 0,
      result: null,
      error: 'Finding not found',
    });
  });

  it('returns null result when returnvalue is undefined', async () => {
    const mockJob = {
      getState: vi.fn().mockResolvedValue('active'),
      progress: 50,
      returnvalue: undefined,
      failedReason: undefined,
    };
    mockGetJob.mockResolvedValue(mockJob);

    const result = await getFixJobStatus('job-active');

    expect(result.result).toBeNull();
  });

  it('returns correct state for "waiting" jobs', async () => {
    const mockJob = {
      getState: vi.fn().mockResolvedValue('waiting'),
      progress: 0,
      returnvalue: null,
      failedReason: undefined,
    };
    mockGetJob.mockResolvedValue(mockJob);

    const result = await getFixJobStatus('job-waiting');

    expect(result.state).toBe('waiting');
    expect(result.progress).toBe(0);
  });

  it('returns correct state for "delayed" jobs', async () => {
    const mockJob = {
      getState: vi.fn().mockResolvedValue('delayed'),
      progress: 0,
      returnvalue: null,
      failedReason: undefined,
    };
    mockGetJob.mockResolvedValue(mockJob);

    const result = await getFixJobStatus('job-delayed');

    expect(result.state).toBe('delayed');
  });

  it('returns undefined error when failedReason is empty string', async () => {
    const mockJob = {
      getState: vi.fn().mockResolvedValue('completed'),
      progress: 100,
      returnvalue: { done: true },
      failedReason: '',
    };
    mockGetJob.mockResolvedValue(mockJob);

    const result = await getFixJobStatus('job-1');

    // Empty string is falsy, so error should be undefined
    expect(result.error).toBeUndefined();
  });

  it('passes jobId to queue.getJob', async () => {
    mockGetJob.mockResolvedValue(null);

    await getFixJobStatus('specific-job-id');

    expect(mockGetJob).toHaveBeenCalledWith('specific-job-id');
  });
});
