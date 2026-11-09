import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the pg pool before importing the repository ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Import AFTER mock registration
import { upsertIndex, getIndex, listIndices } from '../codebase-indices';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbCodebaseIndex(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-idx-001',
    org_id: 'org-1',
    repo: 'org/repo',
    branch: 'main',
    vector_namespace: 'org-1-org/repo-main',
    file_count: 100,
    chunk_count: 500,
    last_indexed_at: '2024-01-15T10:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codebase-indices repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // upsertIndex
  // -------------------------------------------------------------------------

  describe('upsertIndex', () => {
    it('calls INSERT ON CONFLICT and returns the row', async () => {
      const dbRow = makeDbCodebaseIndex();
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const result = await upsertIndex({
        org_id: 'org-1',
        repo: 'org/repo',
        branch: 'main',
        vector_namespace: 'org-1-org/repo-main',
        file_count: 100,
        chunk_count: 500,
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO codebase_indices');
      expect(sql).toContain('ON CONFLICT');
      expect(params).toContain('org-1');
      expect(params).toContain('org/repo');
      expect(params).toContain('main');
      expect(params).toContain('org-1-org/repo-main');
      expect(result).toMatchObject({ id: 'uuid-idx-001', org_id: 'org-1', repo: 'org/repo' });
    });

    it('sets last_indexed_at using NOW()', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbCodebaseIndex()] });

      await upsertIndex({
        org_id: 'org-1',
        repo: 'org/repo',
        branch: 'main',
        vector_namespace: 'ns',
      });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('NOW()');
      expect(sql).toContain('last_indexed_at');
    });

    it('defaults file_count to 0 when not provided', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbCodebaseIndex({ file_count: 0 })] });

      await upsertIndex({
        org_id: 'org-1',
        repo: 'org/repo',
        branch: 'main',
        vector_namespace: 'ns',
      });

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toContain(0); // file_count defaults to 0
    });

    it('defaults chunk_count to 0 when not provided', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbCodebaseIndex({ chunk_count: 0 })] });

      await upsertIndex({
        org_id: 'org-1',
        repo: 'org/repo',
        branch: 'main',
        vector_namespace: 'ns',
      });

      const [, params] = mockQuery.mock.calls[0];
      // both file_count and chunk_count default to 0
      const zeros = params.filter((p: unknown) => p === 0);
      expect(zeros.length).toBeGreaterThanOrEqual(2);
    });

    it('passes provided file_count and chunk_count to query', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbCodebaseIndex({ file_count: 42, chunk_count: 200 })] });

      await upsertIndex({
        org_id: 'org-1',
        repo: 'org/repo',
        branch: 'main',
        vector_namespace: 'ns',
        file_count: 42,
        chunk_count: 200,
      });

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toContain(42);
      expect(params).toContain(200);
    });

    it('uses ON CONFLICT DO UPDATE to handle duplicates', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbCodebaseIndex()] });

      await upsertIndex({
        org_id: 'org-1',
        repo: 'org/repo',
        branch: 'main',
        vector_namespace: 'new-namespace',
      });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('DO UPDATE SET');
    });

    it('returns the upserted row with RETURNING *', async () => {
      const dbRow = makeDbCodebaseIndex({ vector_namespace: 'updated-ns' });
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const result = await upsertIndex({
        org_id: 'org-1',
        repo: 'org/repo',
        branch: 'main',
        vector_namespace: 'updated-ns',
      });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('RETURNING');
      expect(result.vector_namespace).toBe('updated-ns');
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));

      await expect(
        upsertIndex({ org_id: 'org-1', repo: 'org/repo', branch: 'main', vector_namespace: 'ns' }),
      ).rejects.toThrow('DB error');
    });
  });

  // -------------------------------------------------------------------------
  // getIndex
  // -------------------------------------------------------------------------

  describe('getIndex', () => {
    it('queries by org_id, repo, and branch and returns the row', async () => {
      const dbRow = makeDbCodebaseIndex();
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const result = await getIndex('org-1', 'org/repo', 'main');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('codebase_indices'),
        ['org-1', 'org/repo', 'main'],
      );
      expect(result).toMatchObject({ id: 'uuid-idx-001', repo: 'org/repo', branch: 'main' });
    });

    it('returns null when the index is not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await getIndex('org-1', 'nonexistent-repo', 'main');
      expect(result).toBeNull();
    });

    it('filters by all three fields (org_id, repo, branch)', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await getIndex('org-99', 'org/backend', 'feature-branch');

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual(['org-99', 'org/backend', 'feature-branch']);
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Connection refused'));

      await expect(getIndex('org-1', 'repo', 'main')).rejects.toThrow('Connection refused');
    });
  });

  // -------------------------------------------------------------------------
  // listIndices
  // -------------------------------------------------------------------------

  describe('listIndices', () => {
    it('returns all indices for an org ordered by repo', async () => {
      const rows = [
        makeDbCodebaseIndex({ repo: 'org/alpha', id: 'uuid-1' }),
        makeDbCodebaseIndex({ repo: 'org/beta', id: 'uuid-2' }),
      ];
      mockQuery.mockResolvedValue({ rows });

      const result = await listIndices('org-1');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('codebase_indices');
      expect(sql).toContain('ORDER BY repo');
      expect(params).toContain('org-1');
      expect(result).toHaveLength(2);
      expect(result[0].repo).toBe('org/alpha');
      expect(result[1].repo).toBe('org/beta');
    });

    it('returns empty array when there are no indices for the org', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await listIndices('org-empty');
      expect(result).toEqual([]);
    });

    it('filters by org_id', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await listIndices('org-42');

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual(['org-42']);
    });

    it('returns full row objects matching DbCodebaseIndex shape', async () => {
      const row = makeDbCodebaseIndex();
      mockQuery.mockResolvedValue({ rows: [row] });

      const result = await listIndices('org-1');

      expect(result[0]).toMatchObject({
        id: expect.any(String),
        org_id: expect.any(String),
        repo: expect.any(String),
        branch: expect.any(String),
        vector_namespace: expect.any(String),
        file_count: expect.any(Number),
        chunk_count: expect.any(Number),
      });
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Query timeout'));

      await expect(listIndices('org-1')).rejects.toThrow('Query timeout');
    });
  });
});
