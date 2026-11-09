import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted, so factories cannot reference variables declared with const/let
// Use vi.fn() inline and capture references after import
vi.mock('../queues', () => ({
  getFixQueue: vi.fn(),
  getIndexQueue: vi.fn(),
}));

import { enqueueFixJob, enqueueIndexJob } from '../enqueue';
import { getFixQueue, getIndexQueue } from '../queues';
import { decryptSecret } from '../../lib/secret-encryption';

const mockFixAdd = vi.fn();
const mockIndexAdd = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Secret fields in job payloads are encrypted at rest (Task 6). Set a stable
  // key so encrypt/decrypt round-trips deterministically within the test.
  process.env.INTEGRATION_ENCRYPTION_KEY = 'test-integration-encryption-key-1234567890';
  mockFixAdd.mockResolvedValue({ id: 'job-1' });
  mockIndexAdd.mockResolvedValue({ id: 'job-2' });
  vi.mocked(getFixQueue).mockReturnValue({ add: mockFixAdd } as any);
  vi.mocked(getIndexQueue).mockReturnValue({ add: mockIndexAdd } as any);
});

describe('enqueueFixJob', () => {
  it('calls getFixQueue().add with correct job name and data', async () => {
    const data = { findingId: 'finding-123', orgId: 'org-1' };
    await enqueueFixJob(data);

    expect(getFixQueue).toHaveBeenCalled();
    expect(mockFixAdd).toHaveBeenCalledWith('fix', data, expect.any(Object));
  });

  it('passes attempts: 3 and exponential backoff with delay 5000', async () => {
    await enqueueFixJob({ findingId: 'finding-123', orgId: 'org-1' });

    expect(mockFixAdd).toHaveBeenCalledWith('fix', expect.any(Object), {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    });
  });

  it('returns the job id', async () => {
    mockFixAdd.mockResolvedValue({ id: 'fix-job-abc' });

    const result = await enqueueFixJob({ findingId: 'finding-123', orgId: 'org-1' });

    expect(result).toBe('fix-job-abc');
  });

  it('passes findingId and orgId as job data', async () => {
    const data = { findingId: 'finding-xyz', orgId: 'org-99' };
    await enqueueFixJob(data);

    const callArgs = mockFixAdd.mock.calls[0];
    expect(callArgs[1]).toEqual({ findingId: 'finding-xyz', orgId: 'org-99' });
  });
});

describe('enqueueIndexJob', () => {
  it('calls getIndexQueue().add with correct job name and data (githubToken encrypted at rest)', async () => {
    const data = { repo: 'org/repo', branch: 'main', orgId: 'org-1', githubToken: 'ghp_token' };
    await enqueueIndexJob(data);

    expect(getIndexQueue).toHaveBeenCalled();
    expect(mockIndexAdd).toHaveBeenCalledWith(
      'index',
      expect.objectContaining({ repo: 'org/repo', branch: 'main', orgId: 'org-1' }),
      expect.any(Object),
    );
    const payload = mockIndexAdd.mock.calls[0][1];
    expect(payload.githubToken).not.toBe('ghp_token');
    expect(decryptSecret(payload.githubToken)).toBe('ghp_token');
  });

  it('passes attempts: 2 and exponential backoff with delay 10000', async () => {
    await enqueueIndexJob({ repo: 'org/repo', branch: 'main', orgId: 'org-1', githubToken: 'ghp_token' });

    expect(mockIndexAdd).toHaveBeenCalledWith('index', expect.any(Object), {
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 10000,
      },
    });
  });

  it('returns the job id', async () => {
    mockIndexAdd.mockResolvedValue({ id: 'index-job-xyz' });

    const result = await enqueueIndexJob({
      repo: 'org/repo',
      branch: 'main',
      orgId: 'org-1',
      githubToken: 'ghp_token',
    });

    expect(result).toBe('index-job-xyz');
  });

  it('passes all fields correctly as job data, encrypting the github token', async () => {
    const data = { repo: 'myorg/myrepo', branch: 'feature/x', orgId: 'org-42', githubToken: 'ghp_abc' };
    await enqueueIndexJob(data);

    const payload = mockIndexAdd.mock.calls[0][1];
    expect(payload).toMatchObject({ repo: 'myorg/myrepo', branch: 'feature/x', orgId: 'org-42' });
    expect(payload.githubToken).not.toBe('ghp_abc');
    expect(decryptSecret(payload.githubToken)).toBe('ghp_abc');
  });
});
