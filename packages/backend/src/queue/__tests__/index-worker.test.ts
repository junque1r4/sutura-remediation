import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  getConfig: vi.fn().mockReturnValue({
    VOYAGE_API_KEY: 'test-voyage-key',
    PINECONE_API_KEY: 'test-pinecone-key',
    PINECONE_ENVIRONMENT: 'test-env',
  }),
}));

vi.mock('../../db/codebase-indices', () => ({
  upsertIndex: vi.fn(),
}));

vi.mock('../../db/audit-log', () => ({
  logAction: vi.fn(),
}));

vi.mock('@sutura/vector-indexer', () => ({
  indexRepository: vi.fn(),
}));

vi.mock('../connection', () => ({
  getRedisConnection: vi.fn().mockReturnValue({}),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
}));

import { startIndexWorker } from '../workers/index-worker';
import { Worker } from 'bullmq';
import { upsertIndex } from '../../db/codebase-indices';
import { logAction } from '../../db/audit-log';
import { indexRepository } from '@sutura/vector-indexer';

const MockWorker = vi.mocked(Worker);

const mockIndexResult = {
  namespace: 'org-1-org-repo',
  fileCount: 42,
  chunkCount: 200,
};

function getProcessor(): (job: any) => Promise<any> {
  startIndexWorker();
  const workerCall = MockWorker.mock.calls[MockWorker.mock.calls.length - 1];
  return workerCall[1] as (job: any) => Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(indexRepository).mockResolvedValue(mockIndexResult as any);
  vi.mocked(upsertIndex).mockResolvedValue(undefined as any);
  vi.mocked(logAction).mockResolvedValue(undefined as any);
});

describe('startIndexWorker', () => {
  it('creates a Worker on "index-queue"', () => {
    startIndexWorker();
    expect(MockWorker).toHaveBeenCalledWith(
      'index-queue',
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('returns the Worker instance', () => {
    const mockWorkerInstance = { id: 'index-worker-instance' };
    MockWorker.mockImplementation(function () {
      return mockWorkerInstance as any;
    });

    const result = startIndexWorker();

    expect(result).toBe(mockWorkerInstance);
  });
});

describe('index-worker processor', () => {
  const jobData = {
    repo: 'org/repo',
    branch: 'main',
    orgId: 'org-1',
    githubToken: 'ghp_token123',
  };

  it('calls indexRepository with correct arguments', async () => {
    const processor = getProcessor();
    await processor({ data: jobData });

    expect(indexRepository).toHaveBeenCalledWith('org/repo', 'main', 'ghp_token123', 'org-1', {
      voyageApiKey: 'test-voyage-key',
      pineconeApiKey: 'test-pinecone-key',
    });
  });

  it('calls upsertIndex with result counts', async () => {
    const processor = getProcessor();
    await processor({ data: jobData });

    expect(upsertIndex).toHaveBeenCalledWith({
      org_id: 'org-1',
      repo: 'org/repo',
      branch: 'main',
      vector_namespace: 'org-1-org-repo',
      file_count: 42,
      chunk_count: 200,
    });
  });

  it('calls logAction with repository.indexed', async () => {
    const processor = getProcessor();
    await processor({ data: jobData });

    expect(logAction).toHaveBeenCalledWith({
      org_id: 'org-1',
      actor: 'index-worker',
      action: 'repository.indexed',
      resource_type: 'repository',
      resource_id: 'org/repo',
      metadata_json: {
        branch: 'main',
        fileCount: 42,
        chunkCount: 200,
        namespace: 'org-1-org-repo',
      },
    });
  });

  it('returns fileCount, chunkCount, and namespace', async () => {
    const processor = getProcessor();
    const result = await processor({ data: jobData });

    expect(result).toEqual({
      fileCount: 42,
      chunkCount: 200,
      namespace: 'org-1-org-repo',
    });
  });

  it('propagates indexRepository errors', async () => {
    const err = new Error('GitHub API error');
    vi.mocked(indexRepository).mockRejectedValue(err);

    const processor = getProcessor();

    await expect(processor({ data: jobData })).rejects.toThrow('GitHub API error');
  });

  it('does not call upsertIndex if indexRepository fails', async () => {
    vi.mocked(indexRepository).mockRejectedValue(new Error('Index failed'));

    const processor = getProcessor();

    await expect(processor({ data: jobData })).rejects.toThrow();

    expect(upsertIndex).not.toHaveBeenCalled();
  });

  it('does not call logAction if indexRepository fails', async () => {
    vi.mocked(indexRepository).mockRejectedValue(new Error('Index failed'));

    const processor = getProcessor();

    await expect(processor({ data: jobData })).rejects.toThrow();

    expect(logAction).not.toHaveBeenCalled();
  });

  it('uses config keys when calling indexRepository', async () => {
    const { getConfig } = await import('../../config');
    vi.mocked(getConfig).mockReturnValue({
      VOYAGE_API_KEY: 'custom-voyage',
      PINECONE_API_KEY: 'custom-pinecone',
    } as any);

    const processor = getProcessor();
    await processor({ data: jobData });

    expect(indexRepository).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      {
        voyageApiKey: 'custom-voyage',
        pineconeApiKey: 'custom-pinecone',
      },
    );
  });
});
