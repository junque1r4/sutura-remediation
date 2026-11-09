import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the pg pool before importing the repository ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Import AFTER mock registration
import {
  createFixAttempt,
  updateFixAttempt,
  getFixAttempt,
  listFixAttempts,
  listFixAttemptsByOrg,
} from '../fix-attempts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeDbFixAttempt = (overrides: Record<string, unknown> = {}) => ({
  id: 'fa-uuid-001',
  finding_id: 'finding-001',
  org_id: 'org-1',
  prompt_snapshot: 'Fix this vulnerability',
  generated_diff: null,
  test_result: null,
  pr_url: null,
  pr_status: null,
  claude_model: 'claude-3-5-sonnet-20241022',
  claude_tokens_used: 0,
  created_at: '2024-01-01T00:00:00Z',
  completed_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fix-attempts repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // createFixAttempt
  // -------------------------------------------------------------------------
  describe('createFixAttempt', () => {
    it('inserts a new fix attempt and returns the row', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbFixAttempt()] });

      const input = {
        finding_id: 'finding-001',
        org_id: 'org-1',
        prompt_snapshot: 'Fix this vulnerability',
        claude_model: 'claude-3-5-sonnet-20241022',
      };
      const result = await createFixAttempt(input);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO fix_attempts'),
        ['finding-001', 'org-1', 'Fix this vulnerability', 'claude-3-5-sonnet-20241022'],
      );
      expect(result.id).toBe('fa-uuid-001');
      expect(result.finding_id).toBe('finding-001');
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Insert failed'));

      await expect(
        createFixAttempt({
          finding_id: 'finding-001',
          org_id: 'org-1',
          prompt_snapshot: 'Fix this',
          claude_model: 'claude-3-5-sonnet-20241022',
        }),
      ).rejects.toThrow('Insert failed');
    });
  });

  // -------------------------------------------------------------------------
  // updateFixAttempt
  // -------------------------------------------------------------------------
  describe('updateFixAttempt', () => {
    it('updates specified fields and returns the row', async () => {
      const updated = makeDbFixAttempt({
        generated_diff: 'diff content',
        test_result: 'passed',
        completed_at: '2024-01-02T00:00:00Z',
      });
      mockQuery.mockResolvedValue({ rows: [updated] });

      const updates = {
        generated_diff: 'diff content',
        test_result: 'passed' as const,
        completed_at: '2024-01-02T00:00:00Z',
      };
      const result = await updateFixAttempt('fa-uuid-001', updates);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE fix_attempts SET'),
        expect.arrayContaining(['diff content', 'passed', '2024-01-02T00:00:00Z', 'fa-uuid-001']),
      );
      expect(result.generated_diff).toBe('diff content');
      expect(result.test_result).toBe('passed');
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Update failed'));

      await expect(updateFixAttempt('fa-uuid-001', { pr_url: 'https://github.com/pr/1' })).rejects.toThrow(
        'Update failed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getFixAttempt
  // -------------------------------------------------------------------------
  describe('getFixAttempt', () => {
    it('fetches a fix attempt by id', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbFixAttempt()] });

      const result = await getFixAttempt('fa-uuid-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN findings'),
        ['fa-uuid-001'],
      );
      expect(result?.id).toBe('fa-uuid-001');
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await getFixAttempt('non-existent');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listFixAttempts
  // -------------------------------------------------------------------------
  describe('listFixAttempts', () => {
    it('returns all fix attempts for a finding ordered by created_at desc', async () => {
      const rows = [
        makeDbFixAttempt({ id: 'fa-002', created_at: '2024-01-02T00:00:00Z' }),
        makeDbFixAttempt({ id: 'fa-001', created_at: '2024-01-01T00:00:00Z' }),
      ];
      mockQuery.mockResolvedValue({ rows });

      const result = await listFixAttempts('finding-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE finding_id = $1 ORDER BY created_at DESC'),
        ['finding-001'],
      );
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('fa-002');
    });

    it('returns empty array when no attempts found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await listFixAttempts('finding-none');
      expect(result).toEqual([]);
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Query failed'));

      await expect(listFixAttempts('finding-001')).rejects.toThrow('Query failed');
    });
  });

  // -------------------------------------------------------------------------
  // listFixAttemptsByOrg
  // -------------------------------------------------------------------------
  describe('listFixAttemptsByOrg', () => {
    it('always filters by org_id', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFixAttemptsByOrg('org-99', {});

      expect(mockQuery.mock.calls[0][0]).toContain('fa.org_id = $1');
      expect(mockQuery.mock.calls[0][1][0]).toBe('org-99');
    });

    it('applies findingId filter when provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFixAttemptsByOrg('org-1', { findingId: 'finding-001' });

      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'finding-001']);
    });

    it('does not apply findingId filter when not provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFixAttemptsByOrg('org-1', {});

      // Only org_id param
      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1']);
    });

    it('applies pagination with LIMIT/OFFSET', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await listFixAttemptsByOrg('org-1', { page: 3, pageSize: 5 });

      // offset = (3-1)*5 = 10
      const dataParams = mockQuery.mock.calls[1][1];
      expect(dataParams).toEqual(['org-1', 5, 10]);
      expect(result.page).toBe(3);
      expect(result.pageSize).toBe(5);
      expect(result.total).toBe(100);
    });

    it('returns paginated result with defaults (page=1, pageSize=20)', async () => {
      const rows = [makeDbFixAttempt()];
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows });

      const result = await listFixAttemptsByOrg('org-1', {});

      const dataParams = mockQuery.mock.calls[1][1];
      expect(dataParams).toEqual(['org-1', 20, 0]);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.data).toHaveLength(1);
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));

      await expect(listFixAttemptsByOrg('org-1', {})).rejects.toThrow('DB error');
    });
  });
});
