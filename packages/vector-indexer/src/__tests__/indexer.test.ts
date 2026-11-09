import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeChunk } from '../chunker';

// --- Mock dependencies BEFORE importing the module under test ---

vi.mock('../chunker', () => ({
  chunkFileContent: vi.fn(),
}));

vi.mock('../embedder', () => ({
  embedTexts: vi.fn(),
}));

vi.mock('../store', () => ({
  upsertChunks: vi.fn(),
  deleteNamespace: vi.fn(),
}));

// Octokit mock: built as named refs so tests can configure per-call
const mockGetTree = vi.fn();
const mockGetContent = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      git: { getTree: mockGetTree },
      repos: { getContent: mockGetContent },
    };
  }),
}));

// Import after mocks are registered
import { indexRepository } from '../indexer';
import { chunkFileContent } from '../chunker';
import { embedTexts } from '../embedder';
import { upsertChunks, deleteNamespace } from '../store';

// Typed mock helpers
const mockChunkFileContent = vi.mocked(chunkFileContent);
const mockEmbedTexts = vi.mocked(embedTexts);
const mockUpsertChunks = vi.mocked(upsertChunks);
const mockDeleteNamespace = vi.mocked(deleteNamespace);

// Default config
const CONFIG = {
  voyageApiKey: 'voyage-key',
  pineconeApiKey: 'pinecone-key',
};

function makeTreeItem(
  path: string,
  type: 'blob' | 'tree' = 'blob',
): { path: string; type: string } {
  return { path, type };
}

function makeFileResponse(content: string) {
  return {
    data: {
      type: 'file' as const,
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    },
  };
}

function makeChunk(filePath = 'src/foo.ts'): CodeChunk {
  return {
    filePath,
    startLine: 1,
    endLine: 50,
    content: 'const x = 1;',
    language: 'typescript',
    repo: 'owner/repo',
    branch: 'main',
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Sensible defaults
  mockGetTree.mockResolvedValue({ data: { tree: [] } });
  mockGetContent.mockResolvedValue(makeFileResponse('const x = 1;'));
  mockChunkFileContent.mockReturnValue([makeChunk()]);
  mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
  mockUpsertChunks.mockResolvedValue(undefined);
  mockDeleteNamespace.mockResolvedValue(undefined);
});

describe('indexRepository', () => {
  it('deletes previous namespace before indexing', async () => {
    await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockDeleteNamespace).toHaveBeenCalledTimes(1);
    expect(mockDeleteNamespace).toHaveBeenCalledWith('org1/owner/repo/main', CONFIG.pineconeApiKey);
  });

  it('fetches file tree recursively with correct params', async () => {
    await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockGetTree).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      tree_sha: 'main',
      recursive: 'true',
    });
  });

  it('returns 0 counts for empty repo', async () => {
    mockGetTree.mockResolvedValue({ data: { tree: [] } });

    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(result.fileCount).toBe(0);
    expect(result.chunkCount).toBe(0);
  });

  it('returns correct namespace in result', async () => {
    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'myorg', CONFIG);

    expect(result.namespace).toBe('myorg/owner/repo/main');
  });

  it('filters to supported extensions only', async () => {
    mockGetTree.mockResolvedValue({
      data: {
        tree: [
          makeTreeItem('src/index.ts'),
          makeTreeItem('src/App.tsx'),
          makeTreeItem('lib/utils.js'),
          makeTreeItem('scripts/run.jsx'),
          makeTreeItem('main.py'),
          makeTreeItem('server.go'),
          makeTreeItem('App.java'),
          makeTreeItem('lib.rs'),
          makeTreeItem('script.rb'),
          makeTreeItem('README.md'), // unsupported
          makeTreeItem('config.yaml'), // unsupported
          makeTreeItem('data.json'), // unsupported
          makeTreeItem('Makefile'), // unsupported
        ],
      },
    });
    mockChunkFileContent.mockReturnValue([makeChunk()]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    // 9 supported files
    expect(result.fileCount).toBe(9);
  });

  it('ignores directories (node_modules, dist, .git, vendor, .next, build, coverage, __pycache__)', async () => {
    mockGetTree.mockResolvedValue({
      data: {
        tree: [
          makeTreeItem('node_modules/lodash/index.ts'),
          makeTreeItem('dist/bundle.js'),
          makeTreeItem('.git/config.ts'),
          makeTreeItem('vendor/lib.go'),
          makeTreeItem('.next/server/page.tsx'),
          makeTreeItem('build/output.js'),
          makeTreeItem('coverage/report.ts'),
          makeTreeItem('__pycache__/main.py'),
          makeTreeItem('src/valid.ts'), // should be included
        ],
      },
    });
    mockChunkFileContent.mockReturnValue([makeChunk()]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    // Only src/valid.ts passes the filter
    expect(result.fileCount).toBe(1);
    expect(mockGetContent).toHaveBeenCalledTimes(1);
    const callArgs = mockGetContent.mock.calls[0][0];
    expect(callArgs.path).toBe('src/valid.ts');
  });

  it('ignores tree items with type != blob', async () => {
    mockGetTree.mockResolvedValue({
      data: {
        tree: [
          makeTreeItem('src', 'tree'), // directory entry
          makeTreeItem('src/index.ts', 'blob'),
        ],
      },
    });
    mockChunkFileContent.mockReturnValue([makeChunk()]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockGetContent).toHaveBeenCalledTimes(1);
  });

  it('fetches file content with correct params and decodes base64', async () => {
    const fileContent = "export function greet() { return 'hello'; }";
    mockGetTree.mockResolvedValue({
      data: { tree: [makeTreeItem('src/greet.ts')] },
    });
    mockGetContent.mockResolvedValue(makeFileResponse(fileContent));
    mockChunkFileContent.mockReturnValue([makeChunk('src/greet.ts')]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockGetContent).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      path: 'src/greet.ts',
      ref: 'main',
    });

    // The decoded content should be passed to chunkFileContent
    expect(mockChunkFileContent).toHaveBeenCalledWith(
      fileContent,
      'src/greet.ts',
      'owner/repo',
      'main',
    );
  });

  it('chunks each file and embeds all chunks', async () => {
    const chunk1 = makeChunk('src/a.ts');
    const chunk2 = makeChunk('src/b.ts');

    mockGetTree.mockResolvedValue({
      data: {
        tree: [makeTreeItem('src/a.ts'), makeTreeItem('src/b.ts')],
      },
    });
    mockChunkFileContent.mockReturnValueOnce([chunk1]).mockReturnValueOnce([chunk2]);
    mockEmbedTexts.mockResolvedValueOnce([[0.1, 0.2]]).mockResolvedValueOnce([[0.3, 0.4]]);

    await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockChunkFileContent).toHaveBeenCalledTimes(2);
    expect(mockEmbedTexts).toHaveBeenCalledTimes(2);
  });

  it('upserts to Pinecone with namespace {orgId}/{repo}/{branch}', async () => {
    const chunk = makeChunk('src/index.ts');
    mockGetTree.mockResolvedValue({
      data: { tree: [makeTreeItem('src/index.ts')] },
    });
    mockChunkFileContent.mockReturnValue([chunk]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexRepository('owner/repo', 'main', 'gh-token', 'myorg', CONFIG);

    expect(mockUpsertChunks).toHaveBeenCalledWith(
      'myorg/owner/repo/main',
      [chunk],
      [[0.1, 0.2, 0.3]],
      CONFIG.pineconeApiKey,
    );
  });

  it('returns correct fileCount and chunkCount', async () => {
    const chunks = [makeChunk('src/a.ts'), makeChunk('src/a.ts')];
    mockGetTree.mockResolvedValue({
      data: {
        tree: [makeTreeItem('src/a.ts'), makeTreeItem('src/b.ts')],
      },
    });
    mockChunkFileContent
      .mockReturnValueOnce(chunks) // 2 chunks for first file
      .mockReturnValueOnce([makeChunk('src/b.ts')]); // 1 chunk for second
    mockEmbedTexts.mockResolvedValueOnce([[0.1], [0.2]]).mockResolvedValueOnce([[0.3]]);

    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(result.fileCount).toBe(2);
    expect(result.chunkCount).toBe(3);
  });

  it('skips files where chunkFileContent returns empty (non-fatal)', async () => {
    mockGetTree.mockResolvedValue({
      data: {
        tree: [makeTreeItem('src/empty.ts'), makeTreeItem('src/real.ts')],
      },
    });
    mockChunkFileContent
      .mockReturnValueOnce([]) // empty file → skip
      .mockReturnValueOnce([makeChunk('src/real.ts')]);
    mockEmbedTexts.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);

    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
    expect(mockUpsertChunks).toHaveBeenCalledTimes(1);
    expect(result.chunkCount).toBe(1);
  });

  it('skips files that fail to fetch (non-fatal)', async () => {
    mockGetTree.mockResolvedValue({
      data: {
        tree: [makeTreeItem('src/broken.ts'), makeTreeItem('src/ok.ts')],
      },
    });
    mockGetContent
      .mockRejectedValueOnce(new Error('404 Not Found'))
      .mockResolvedValueOnce(makeFileResponse('const ok = true;'));
    mockChunkFileContent.mockReturnValue([makeChunk('src/ok.ts')]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    // Should not throw; should process the second file
    expect(mockChunkFileContent).toHaveBeenCalledTimes(1);
    expect(result.chunkCount).toBe(1);
  });

  it('skips getContent responses that are directories (array data)', async () => {
    mockGetTree.mockResolvedValue({
      data: { tree: [makeTreeItem('src/index.ts')] },
    });
    mockGetContent.mockResolvedValue({ data: [{ type: 'file', name: 'index.ts' }] });

    const result = await indexRepository('owner/repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockChunkFileContent).not.toHaveBeenCalled();
    expect(result.chunkCount).toBe(0);
  });

  it('splits repo string to owner and repoName correctly', async () => {
    await indexRepository('my-org/my-repo', 'main', 'gh-token', 'org1', CONFIG);

    expect(mockGetTree).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'my-org', repo: 'my-repo' }),
    );
  });

  it('passes the github token to Octokit', async () => {
    const { Octokit } = await import('@octokit/rest');
    const MockOctokit = vi.mocked(Octokit);

    await indexRepository('owner/repo', 'main', 'my-gh-token', 'org1', CONFIG);

    expect(MockOctokit).toHaveBeenCalledWith({ auth: 'my-gh-token' });
  });
});
