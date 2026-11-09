import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.fn().mockResolvedValue(undefined);
const mockQuery = vi.fn().mockResolvedValue({ matches: [] });
const mockDeleteAll = vi.fn().mockResolvedValue(undefined);
const mockNamespace = vi.fn().mockReturnValue({
  upsert: mockUpsert,
  query: mockQuery,
  deleteAll: mockDeleteAll,
});
const mockIndex = vi.fn().mockReturnValue({ namespace: mockNamespace });

vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: vi.fn().mockImplementation(function () {
    return {
      index: mockIndex,
    };
  }),
}));

import { upsertChunks, queryVectors, deleteNamespace } from '../store';
import type { CodeChunk } from '../chunker';

const API_KEY = 'pinecone-test-key';

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    filePath: 'src/foo.ts',
    startLine: 1,
    endLine: 50,
    content: 'const x = 1;',
    language: 'typescript',
    repo: 'owner/repo',
    branch: 'main',
    ...overrides,
  };
}

function makeEmbedding(dim = 3): number[] {
  return Array.from({ length: dim }, (_, i) => i * 0.1);
}

beforeEach(() => {
  mockUpsert.mockReset();
  mockQuery.mockReset();
  mockDeleteAll.mockReset();
  mockUpsert.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue({ matches: [] });
  mockDeleteAll.mockResolvedValue(undefined);
  mockNamespace.mockReturnValue({
    upsert: mockUpsert,
    query: mockQuery,
    deleteAll: mockDeleteAll,
  });
  mockIndex.mockReturnValue({ namespace: mockNamespace });
});

describe('upsertChunks', () => {
  it('does nothing when chunks array is empty', async () => {
    await upsertChunks('ns/test', [], [], API_KEY);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('uses the correct namespace', async () => {
    const chunk = makeChunk();
    const embedding = makeEmbedding();

    await upsertChunks('org/myrepo/main', [chunk], [embedding], API_KEY);

    expect(mockNamespace).toHaveBeenCalledWith('org/myrepo/main');
  });

  it('builds vector ID as {filePath}:{startLine}-{endLine}', async () => {
    const chunk = makeChunk({ filePath: 'src/auth.ts', startLine: 10, endLine: 60 });
    const embedding = makeEmbedding();

    await upsertChunks('ns', [chunk], [embedding], API_KEY);

    const vectors = mockUpsert.mock.calls[0][0];
    expect(vectors[0].id).toBe('src/auth.ts:10-60');
  });

  it('includes all metadata fields', async () => {
    const chunk = makeChunk({
      filePath: 'src/bar.py',
      startLine: 5,
      endLine: 30,
      content: 'def foo(): pass',
      language: 'python',
      repo: 'owner/other',
      branch: 'dev',
    });
    const embedding = makeEmbedding();

    await upsertChunks('ns', [chunk], [embedding], API_KEY);

    const vectors = mockUpsert.mock.calls[0][0];
    const meta = vectors[0].metadata;
    expect(meta.filePath).toBe('src/bar.py');
    expect(meta.startLine).toBe(5);
    expect(meta.endLine).toBe(30);
    expect(meta.language).toBe('python');
    expect(meta.repo).toBe('owner/other');
    expect(meta.branch).toBe('dev');
    expect(meta.content).toBe('def foo(): pass');
  });

  it('truncates content to 10000 chars in metadata', async () => {
    const longContent = 'x'.repeat(20000);
    const chunk = makeChunk({ content: longContent });
    const embedding = makeEmbedding();

    await upsertChunks('ns', [chunk], [embedding], API_KEY);

    const vectors = mockUpsert.mock.calls[0][0];
    expect(vectors[0].metadata.content.length).toBe(10000);
  });

  it('does not truncate content shorter than 10000 chars', async () => {
    const shortContent = 'short content';
    const chunk = makeChunk({ content: shortContent });
    const embedding = makeEmbedding();

    await upsertChunks('ns', [chunk], [embedding], API_KEY);

    const vectors = mockUpsert.mock.calls[0][0];
    expect(vectors[0].metadata.content).toBe(shortContent);
  });

  it('batches upserts in groups of 100', async () => {
    const count = 250;
    const chunks = Array.from({ length: count }, (_, i) =>
      makeChunk({ filePath: `src/file${i}.ts`, startLine: i + 1, endLine: i + 50 }),
    );
    const embeddings = Array.from({ length: count }, () => makeEmbedding());

    await upsertChunks('ns', chunks, embeddings, API_KEY);

    // 250 chunks → 3 batches: 100, 100, 50
    expect(mockUpsert).toHaveBeenCalledTimes(3);
    expect(mockUpsert.mock.calls[0][0]).toHaveLength(100);
    expect(mockUpsert.mock.calls[1][0]).toHaveLength(100);
    expect(mockUpsert.mock.calls[2][0]).toHaveLength(50);
  });

  it('throws when chunks and embeddings lengths differ', async () => {
    const chunks = [makeChunk(), makeChunk()];
    const embeddings = [makeEmbedding()];

    await expect(upsertChunks('ns', chunks, embeddings, API_KEY)).rejects.toThrow('Mismatch');
  });

  it('passes embedding values to pinecone', async () => {
    const chunk = makeChunk();
    const embedding = [0.5, 0.6, 0.7];

    await upsertChunks('ns', [chunk], [embedding], API_KEY);

    const vectors = mockUpsert.mock.calls[0][0];
    expect(vectors[0].values).toEqual([0.5, 0.6, 0.7]);
  });
});

describe('queryVectors', () => {
  it('calls query with includeMetadata: true', async () => {
    mockQuery.mockResolvedValueOnce({ matches: [] });

    await queryVectors('ns', [0.1, 0.2], 5, API_KEY);

    expect(mockQuery).toHaveBeenCalledWith({
      vector: [0.1, 0.2],
      topK: 5,
      includeMetadata: true,
    });
  });

  it('forwards topK parameter', async () => {
    mockQuery.mockResolvedValueOnce({ matches: [] });

    await queryVectors('ns', [0.1], 10, API_KEY);

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.topK).toBe(10);
  });

  it('uses the correct namespace', async () => {
    mockQuery.mockResolvedValueOnce({ matches: [] });

    await queryVectors('org/repo/main', [0.1], 5, API_KEY);

    expect(mockNamespace).toHaveBeenCalledWith('org/repo/main');
  });

  it('returns empty array when matches is empty', async () => {
    mockQuery.mockResolvedValueOnce({ matches: [] });

    const result = await queryVectors('ns', [0.1], 5, API_KEY);

    expect(result).toEqual([]);
  });

  it('returns empty array when matches is undefined', async () => {
    mockQuery.mockResolvedValueOnce({});

    const result = await queryVectors('ns', [0.1], 5, API_KEY);

    expect(result).toEqual([]);
  });

  it('maps matches to VectorMatch[] with id, score, metadata', async () => {
    mockQuery.mockResolvedValueOnce({
      matches: [
        {
          id: 'src/foo.ts:1-50',
          score: 0.92,
          metadata: { filePath: 'src/foo.ts', startLine: 1 },
        },
        {
          id: 'src/bar.ts:10-60',
          score: 0.85,
          metadata: { filePath: 'src/bar.ts', startLine: 10 },
        },
      ],
    });

    const result = await queryVectors('ns', [0.1], 5, API_KEY);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'src/foo.ts:1-50',
      score: 0.92,
      metadata: { filePath: 'src/foo.ts', startLine: 1 },
    });
    expect(result[1]).toEqual({
      id: 'src/bar.ts:10-60',
      score: 0.85,
      metadata: { filePath: 'src/bar.ts', startLine: 10 },
    });
  });

  it('defaults score to 0 when score is undefined', async () => {
    mockQuery.mockResolvedValueOnce({
      matches: [{ id: 'some-id', score: undefined, metadata: {} }],
    });

    const result = await queryVectors('ns', [0.1], 5, API_KEY);

    expect(result[0].score).toBe(0);
  });

  it('defaults metadata to empty object when undefined', async () => {
    mockQuery.mockResolvedValueOnce({
      matches: [{ id: 'some-id', score: 0.9, metadata: undefined }],
    });

    const result = await queryVectors('ns', [0.1], 5, API_KEY);

    expect(result[0].metadata).toEqual({});
  });
});

describe('deleteNamespace', () => {
  it('calls deleteAll on the correct namespace', async () => {
    await deleteNamespace('org/repo/main', API_KEY);

    expect(mockNamespace).toHaveBeenCalledWith('org/repo/main');
    expect(mockDeleteAll).toHaveBeenCalledTimes(1);
  });

  it('uses the correct Pinecone index', async () => {
    await deleteNamespace('some/ns', API_KEY);

    expect(mockIndex).toHaveBeenCalledWith('sutura-codebase');
  });
});
