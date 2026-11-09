import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';

// Mock the embedder and store modules
vi.mock('../embedder', () => ({
  embedQuery: vi.fn(),
}));

vi.mock('../store', () => ({
  queryVectors: vi.fn(),
}));

import { queryRelevantContext } from '../query';
import { embedQuery } from '../embedder';
import { queryVectors } from '../store';

const mockEmbedQuery = vi.mocked(embedQuery);
const mockQueryVectors = vi.mocked(queryVectors);

const BASE_FINDING: NormalizedFinding = {
  externalId: 'finding-1',
  scanner: 'snyk',
  title: 'SQL Injection vulnerability',
  description: 'Unsanitized user input passed directly to SQL query',
  severity: 'high',
  cweId: 'CWE-89',
  filePath: 'src/db/queries.ts',
  repo: 'owner/my-repo',
  rawPayload: {},
};

const MOCK_VECTOR = [0.1, 0.2, 0.3];

const MOCK_CONFIG = {
  voyageApiKey: 'voyage-key',
  pineconeApiKey: 'pinecone-key',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbedQuery.mockResolvedValue(MOCK_VECTOR);
  mockQueryVectors.mockResolvedValue([]);
});

describe('queryRelevantContext', () => {
  it('builds query text from finding title and description', async () => {
    await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG);

    expect(mockEmbedQuery).toHaveBeenCalledOnce();
    const queryText: string = mockEmbedQuery.mock.calls[0][0];
    expect(queryText).toContain('SQL Injection vulnerability');
    expect(queryText).toContain('Unsanitized user input passed directly to SQL query');
  });

  it('includes filePath in query text when present', async () => {
    await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG);

    const queryText: string = mockEmbedQuery.mock.calls[0][0];
    expect(queryText).toContain('src/db/queries.ts');
  });

  it('includes cweId in query text when present', async () => {
    await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG);

    const queryText: string = mockEmbedQuery.mock.calls[0][0];
    expect(queryText).toContain('CWE-89');
  });

  it('uses correct namespace derived from orgId and repo', async () => {
    await queryRelevantContext(BASE_FINDING, 'org-42', 'owner/my-repo', MOCK_CONFIG);

    expect(mockQueryVectors).toHaveBeenCalledWith(
      'org-42/owner/my-repo/main',
      MOCK_VECTOR,
      5,
      'pinecone-key',
    );
  });

  it('passes voyageApiKey when embedding', async () => {
    await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG);

    expect(mockEmbedQuery).toHaveBeenCalledWith(expect.any(String), 'voyage-key');
  });

  it('returns formatted code chunks', async () => {
    mockQueryVectors.mockResolvedValue([
      {
        id: 'src/db/queries.ts:1-50',
        score: 0.95,
        metadata: {
          filePath: 'src/db/queries.ts',
          content: 'const query = db.execute(sql);',
        },
      },
      {
        id: 'src/db/helpers.ts:10-60',
        score: 0.87,
        metadata: {
          filePath: 'src/db/helpers.ts',
          content: 'function buildQuery(input) {}',
        },
      },
    ]);

    const result = await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe('// File: src/db/queries.ts\nconst query = db.execute(sql);');
    expect(result[1]).toBe('// File: src/db/helpers.ts\nfunction buildQuery(input) {}');
  });

  it('handles empty results from Pinecone', async () => {
    mockQueryVectors.mockResolvedValue([]);

    const result = await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG);

    expect(result).toEqual([]);
  });

  it('respects the topK parameter', async () => {
    await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG, 10);

    expect(mockQueryVectors).toHaveBeenCalledWith(
      expect.any(String),
      MOCK_VECTOR,
      10,
      'pinecone-key',
    );
  });

  it('uses default topK of 5', async () => {
    await queryRelevantContext(BASE_FINDING, 'org-1', 'owner/my-repo', MOCK_CONFIG);

    expect(mockQueryVectors).toHaveBeenCalledWith(
      expect.any(String),
      MOCK_VECTOR,
      5,
      'pinecone-key',
    );
  });

  it('works without optional finding fields (filePath, cweId)', async () => {
    const minimalFinding: NormalizedFinding = {
      externalId: 'finding-2',
      scanner: 'snyk',
      title: 'XSS vulnerability',
      description: 'Cross-site scripting issue',
      severity: 'medium',
      repo: 'owner/other-repo',
      rawPayload: {},
    };

    await expect(
      queryRelevantContext(minimalFinding, 'org-1', 'owner/other-repo', MOCK_CONFIG),
    ).resolves.toEqual([]);

    const queryText: string = mockEmbedQuery.mock.calls[0][0];
    expect(queryText).toContain('XSS vulnerability');
    expect(queryText).not.toContain('File:');
    expect(queryText).not.toContain('CWE:');
  });
});
