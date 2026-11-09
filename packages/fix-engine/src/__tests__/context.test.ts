import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';

// Mock @sutura/vector-indexer
vi.mock('@sutura/vector-indexer', () => ({
  queryRelevantContext: vi.fn(),
}));

// Mock @octokit/rest
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      repos: {
        getContent: vi.fn(),
      },
    };
  }),
}));

import { retrieveContext } from '../pipeline/context';
import { queryRelevantContext } from '@sutura/vector-indexer';
import { Octokit } from '@octokit/rest';

function makeFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    externalId: 'finding-abc123',
    scanner: 'snyk',
    title: 'SQL Injection',
    description: 'A SQL injection vulnerability',
    severity: 'high',
    repo: 'owner/my-repo',
    rawPayload: {},
    ...overrides,
  };
}

const baseConfig = {
  voyageApiKey: 'voyage-key',
  pineconeApiKey: 'pinecone-key',
  githubToken: 'gh-token',
};

describe('retrieveContext', () => {
  let mockGetContent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetContent = vi.fn();
    (Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return {
        repos: { getContent: mockGetContent },
      };
    });
  });

  it('happy path: RAG returns chunks + GitHub returns file content → complete FixContext', async () => {
    const chunks = ['relevant code chunk 1', 'relevant code chunk 2'];
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue(chunks);

    const fileContent = 'const x = 1;';
    mockGetContent.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from(fileContent).toString('base64'),
        encoding: 'base64',
      },
    });

    const finding = makeFinding({ filePath: 'src/db.ts' });
    const customPrompts = { systemPrompt: 'Be careful.' };

    const result = await retrieveContext(finding, 'org-1', customPrompts, baseConfig);

    expect(result.finding).toBe(finding);
    expect(result.orgId).toBe('org-1');
    expect(result.customPrompts).toBe(customPrompts);
    expect(result.relevantCode).toEqual(chunks);
    expect(result.vulnerableFileContent).toBe(fileContent);
  });

  it('RAG query fails → relevantCode = [] (non-fatal)', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('vector DB unavailable'),
    );

    mockGetContent.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from('some content').toString('base64'),
        encoding: 'base64',
      },
    });

    const finding = makeFinding({ filePath: 'src/db.ts' });
    const result = await retrieveContext(finding, 'org-1', {}, baseConfig);

    expect(result.relevantCode).toEqual([]);
    // Should still attempt GitHub fetch
    expect(result.vulnerableFileContent).toBe('some content');
  });

  it('GitHub file fetch fails → vulnerableFileContent = null (non-fatal)', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue(['chunk1']);
    mockGetContent.mockRejectedValue(new Error('404 Not Found'));

    const finding = makeFinding({ filePath: 'src/missing.ts' });
    const result = await retrieveContext(finding, 'org-1', {}, baseConfig);

    expect(result.relevantCode).toEqual(['chunk1']);
    expect(result.vulnerableFileContent).toBeNull();
  });

  it('finding without filePath → skips GitHub fetch, vulnerableFileContent = null', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const finding = makeFinding({ filePath: undefined });
    const result = await retrieveContext(finding, 'org-1', {}, baseConfig);

    expect(mockGetContent).not.toHaveBeenCalled();
    expect(result.vulnerableFileContent).toBeNull();
  });

  it('custom prompts passed through to result', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const customPrompts = { systemPrompt: 'Custom system prompt', userPrompt: 'Focus on XSS' };
    const finding = makeFinding();

    const result = await retrieveContext(finding, 'org-2', customPrompts, baseConfig);

    expect(result.customPrompts).toEqual(customPrompts);
    expect(result.customPrompts).toBe(customPrompts);
  });

  it('GitHub file content decoded from base64 correctly', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const originalContent = 'function vulnerable() {\n  return eval(userInput);\n}';
    mockGetContent.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from(originalContent).toString('base64'),
        encoding: 'base64',
      },
    });

    const finding = makeFinding({ filePath: 'src/utils.ts' });
    const result = await retrieveContext(finding, 'org-1', {}, baseConfig);

    expect(result.vulnerableFileContent).toBe(originalContent);
  });

  it('repo split correctly (owner/repo format)', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockGetContent.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from('content').toString('base64'),
        encoding: 'base64',
      },
    });

    const finding = makeFinding({ repo: 'my-org/my-service', filePath: 'index.ts' });
    await retrieveContext(finding, 'org-1', {}, baseConfig);

    expect(mockGetContent).toHaveBeenCalledWith({
      owner: 'my-org',
      repo: 'my-service',
      path: 'index.ts',
    });
  });

  it('does not set vulnerableFileContent if GitHub returns an array (directory listing)', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // GitHub returns an array when path is a directory
    mockGetContent.mockResolvedValue({ data: [] });

    const finding = makeFinding({ filePath: 'src/' });
    const result = await retrieveContext(finding, 'org-1', {}, baseConfig);

    expect(result.vulnerableFileContent).toBeNull();
  });

  it('passes correct params to queryRelevantContext', async () => {
    (queryRelevantContext as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const finding = makeFinding({ repo: 'owner/repo' });
    await retrieveContext(finding, 'org-3', {}, baseConfig);

    expect(queryRelevantContext).toHaveBeenCalledWith(finding, 'org-3', 'owner/repo', {
      voyageApiKey: 'voyage-key',
      pineconeApiKey: 'pinecone-key',
    });
  });
});
