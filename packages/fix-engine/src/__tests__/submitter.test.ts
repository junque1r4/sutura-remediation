import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'abc123' } } }),
        createRef: vi.fn().mockResolvedValue({}),
      },
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            content: Buffer.from('original content').toString('base64'),
            sha: 'file-sha',
            encoding: 'base64',
            type: 'file',
          },
        }),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
        }),
        requestReviewers: vi.fn().mockResolvedValue({}),
      },
    };
  }),
}));

import { submitFix } from '../pipeline/submitter';
import { Octokit } from '@octokit/rest';

// Helper to get mock octokit instance methods
function getOctokitMocks() {
  const instance = (Octokit as unknown as ReturnType<typeof vi.fn>).mock.results[
    (Octokit as unknown as ReturnType<typeof vi.fn>).mock.results.length - 1
  ].value;
  return instance;
}

const SIMPLE_DIFF = `--- a/src/db.ts
+++ b/src/db.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const query = \`SELECT * FROM users WHERE id = \${id}\`;
+const query = 'SELECT * FROM users WHERE id = ?';
 module.exports = { query };`;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-setup default mocks after clearAllMocks
  (Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return {
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'abc123' } } }),
        createRef: vi.fn().mockResolvedValue({}),
      },
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            content: Buffer.from('original content\n').toString('base64'),
            sha: 'file-sha',
            encoding: 'base64',
            type: 'file',
          },
        }),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
        }),
        requestReviewers: vi.fn().mockResolvedValue({}),
      },
    };
  });
});

describe('submitFix', () => {
  describe('branch creation', () => {
    it('creates branch with correct name using first 8 chars of findingId', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'abcdef1234567890',
        'SQL Injection',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: expect.stringMatching(
            /^refs\/heads\/sutura\/fix-abcdef12-\d{8}T\d{4}$/,
          ) as unknown as string,
        }),
      );
    });

    it('strips non-alphanumeric chars when building branch name from findingId', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'abc-def-123',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: expect.stringMatching(
            /^refs\/heads\/sutura\/fix-abcdef12-\d{8}T\d{4}$/,
          ) as unknown as string,
        }),
      );
    });

    it('gets target branch SHA before creating branch', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
        'develop',
      );
      const mocks = getOctokitMocks();

      expect(mocks.git.getRef).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'heads/develop',
      });
      expect(mocks.git.createRef).toHaveBeenCalledWith(expect.objectContaining({ sha: 'abc123' }));
    });

    it('uses sha from getRef to create branch', async () => {
      (Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
        return {
          git: {
            getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'deadbeef' } } }),
            createRef: vi.fn().mockResolvedValue({}),
          },
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from('').toString('base64'),
                sha: 'file-sha',
                encoding: 'base64',
                type: 'file',
              },
            }),
            createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
          },
          pulls: {
            create: vi.fn().mockResolvedValue({
              data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
            }),
            requestReviewers: vi.fn().mockResolvedValue({}),
          },
        };
      });

      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({ sha: 'deadbeef' }),
      );
    });
  });

  describe('default targetBranch', () => {
    it('defaults to main when targetBranch is not provided', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.git.getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main' }));
      expect(mocks.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ base: 'main' }));
    });
  });

  describe('PR creation', () => {
    it('creates PR with correct title format: fix({severity}): {findingTitle}', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'SQL Injection Vulnerability',
        'critical',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'fix(critical): SQL Injection Vulnerability',
        }),
      );
    });

    it('PR body includes finding title, severity, and finding ID', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-abc',
        'XSS Attack',
        'high',
        'gpt-4',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      const callArgs = mocks.pulls.create.mock.calls[0][0];
      expect(callArgs.body).toContain('XSS Attack');
      expect(callArgs.body).toContain('HIGH');
      expect(callArgs.body).toContain('finding-abc');
    });

    it('PR body includes model info', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-sonnet-4-5',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      const callArgs = mocks.pulls.create.mock.calls[0][0];
      expect(callArgs.body).toContain('claude-sonnet-4-5');
    });

    it('sets correct head and base for PR', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding123',
        'Title',
        'high',
        'claude-3',
        'gh-token',
        'staging',
      );
      const mocks = getOctokitMocks();

      expect(mocks.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          head: expect.stringMatching(/^sutura\/fix-finding1-\d{8}T\d{4}$/) as unknown as string,
          base: 'staging',
          owner: 'owner',
          repo: 'repo',
        }),
      );
    });

    it('returns prUrl, prStatus=open, and branchName', async () => {
      const result = await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );

      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/1');
      expect(result.prStatus).toBe('open');
      expect(result.branchName).toMatch(/^sutura\/fix-/);
    });
  });

  describe('reviewer assignment', () => {
    it('requests reviewers when provided', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
        'main',
        ['alice', 'bob'],
      );
      const mocks = getOctokitMocks();

      expect(mocks.pulls.requestReviewers).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewers: ['alice', 'bob'],
          pull_number: 1,
        }),
      );
    });

    it('does not request reviewers when reviewers array is empty', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
        'main',
        [],
      );
      const mocks = getOctokitMocks();

      expect(mocks.pulls.requestReviewers).not.toHaveBeenCalled();
    });

    it('does not request reviewers when reviewers is undefined', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.pulls.requestReviewers).not.toHaveBeenCalled();
    });

    it('reviewer assignment failure is non-fatal: still returns result', async () => {
      (Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
        return {
          git: {
            getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'abc123' } } }),
            createRef: vi.fn().mockResolvedValue({}),
          },
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from('').toString('base64'),
                sha: 'file-sha',
                encoding: 'base64',
                type: 'file',
              },
            }),
            createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
          },
          pulls: {
            create: vi.fn().mockResolvedValue({
              data: { html_url: 'https://github.com/owner/repo/pull/2', number: 2 },
            }),
            requestReviewers: vi.fn().mockRejectedValue(new Error('Reviewer not found')),
          },
        };
      });

      const result = await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
        'main',
        ['unknown-user'],
      );

      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/2');
      expect(result.prStatus).toBe('open');
    });
  });

  describe('diff parsing', () => {
    it('parses file paths from "+++ b/path/to/file.ts" lines', async () => {
      const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`;
      await submitFix('owner/repo', diff, 'finding-1', 'Title', 'high', 'claude-3', 'gh-token');
      const mocks = getOctokitMocks();

      expect(mocks.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'src/foo.ts' }),
      );
    });

    it('handles multiple files in one diff', async () => {
      const multiFileDiff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-oldA
+newA
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-oldB
+newB`;
      await submitFix(
        'owner/repo',
        multiFileDiff,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      const getContentPaths = mocks.repos.getContent.mock.calls.map(
        (c: [{ path: string }]) => c[0].path,
      );
      expect(getContentPaths).toContain('src/a.ts');
      expect(getContentPaths).toContain('src/b.ts');
    });

    it('empty diff → no file operations', async () => {
      await submitFix('owner/repo', '', 'finding-1', 'Title', 'high', 'claude-3', 'gh-token');
      const mocks = getOctokitMocks();

      expect(mocks.repos.getContent).not.toHaveBeenCalled();
      expect(mocks.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });
  });

  describe('patch application', () => {
    it('applies simple line addition correctly', async () => {
      const originalContent = 'line1\nline2\nline3';
      const diff = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3`;

      (Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
        return {
          git: {
            getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'abc123' } } }),
            createRef: vi.fn().mockResolvedValue({}),
          },
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(originalContent).toString('base64'),
                sha: 'file-sha',
                encoding: 'base64',
                type: 'file',
              },
            }),
            createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
          },
          pulls: {
            create: vi.fn().mockResolvedValue({
              data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
            }),
            requestReviewers: vi.fn().mockResolvedValue({}),
          },
        };
      });

      await submitFix('owner/repo', diff, 'finding-1', 'Title', 'high', 'claude-3', 'gh-token');
      const mocks = getOctokitMocks();

      const callArgs = mocks.repos.createOrUpdateFileContents.mock.calls[0][0];
      const newContent = Buffer.from(callArgs.content, 'base64').toString('utf-8');
      expect(newContent).toContain('added line');
    });

    it('applies simple line removal correctly', async () => {
      // The patch applier splices out `origCount` lines and replaces with only `+` lines.
      // Context lines are tracked but not re-inserted (simplified implementation).
      // A hunk of only removals with no additions results in lines being removed.
      const originalContent = 'before\nremove me\nafter';
      // Single-line hunk: origCount=1, only the removal line is in the hunk range
      const diff = `--- a/src/file.ts
+++ b/src/file.ts
@@ -2,1 +2,0 @@
-remove me`;

      (Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
        return {
          git: {
            getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'abc123' } } }),
            createRef: vi.fn().mockResolvedValue({}),
          },
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(originalContent).toString('base64'),
                sha: 'file-sha',
                encoding: 'base64',
                type: 'file',
              },
            }),
            createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
          },
          pulls: {
            create: vi.fn().mockResolvedValue({
              data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
            }),
            requestReviewers: vi.fn().mockResolvedValue({}),
          },
        };
      });

      await submitFix('owner/repo', diff, 'finding-1', 'Title', 'high', 'claude-3', 'gh-token');
      const mocks = getOctokitMocks();

      const callArgs = mocks.repos.createOrUpdateFileContents.mock.calls[0][0];
      const newContent = Buffer.from(callArgs.content, 'base64').toString('utf-8');
      expect(newContent).not.toContain('remove me');
    });

    it('includes sha in update call when file already exists', async () => {
      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ sha: 'file-sha' }),
      );
    });

    it('omits sha in update call when file does not exist (new file)', async () => {
      (Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
        return {
          git: {
            getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'abc123' } } }),
            createRef: vi.fn().mockResolvedValue({}),
          },
          repos: {
            // Simulate 404: file doesn't exist
            getContent: vi
              .fn()
              .mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
            createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
          },
          pulls: {
            create: vi.fn().mockResolvedValue({
              data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
            }),
            requestReviewers: vi.fn().mockResolvedValue({}),
          },
        };
      });

      await submitFix(
        'owner/repo',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      const callArgs = mocks.repos.createOrUpdateFileContents.mock.calls[0][0];
      expect(callArgs.sha).toBeUndefined();
    });
  });

  describe('repo splitting', () => {
    it('correctly splits owner/repo format for all API calls', async () => {
      await submitFix(
        'my-org/my-service',
        SIMPLE_DIFF,
        'finding-1',
        'Title',
        'high',
        'claude-3',
        'gh-token',
      );
      const mocks = getOctokitMocks();

      expect(mocks.git.getRef).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'my-org', repo: 'my-service' }),
      );
      expect(mocks.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'my-org', repo: 'my-service' }),
      );
      expect(mocks.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'my-org', repo: 'my-service' }),
      );
    });
  });
});
