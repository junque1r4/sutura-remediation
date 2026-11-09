import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the pg pool before importing the repository ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Import AFTER mock registration
import { logAction, listAuditLog } from '../audit-log';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeDbAuditLogEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'al-uuid-001',
  org_id: 'org-1',
  actor: 'user@example.com',
  action: 'finding.status_changed',
  resource_type: 'finding',
  resource_id: 'finding-001',
  metadata_json: {},
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit-log repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // logAction
  // -------------------------------------------------------------------------
  describe('logAction', () => {
    it('inserts an audit log entry and returns the row', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbAuditLogEntry()] });

      const input = {
        org_id: 'org-1',
        actor: 'user@example.com',
        action: 'finding.status_changed',
        resource_type: 'finding',
        resource_id: 'finding-001',
      };
      const result = await logAction(input);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        expect.arrayContaining(['org-1', 'user@example.com', 'finding.status_changed']),
      );
      expect(result.id).toBe('al-uuid-001');
    });

    it('uses provided metadata_json when specified', async () => {
      const metadata = { old_status: 'open', new_status: 'fixed' };
      mockQuery.mockResolvedValue({ rows: [makeDbAuditLogEntry({ metadata_json: metadata })] });

      await logAction({
        org_id: 'org-1',
        actor: 'user@example.com',
        action: 'finding.status_changed',
        metadata_json: metadata,
      });

      const params = mockQuery.mock.calls[0][1];
      expect(params[5]).toBe(JSON.stringify(metadata));
    });

    it('defaults metadata_json to empty object when not provided', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbAuditLogEntry()] });

      await logAction({ org_id: 'org-1', actor: 'admin', action: 'org.updated' });

      const params = mockQuery.mock.calls[0][1];
      expect(params[5]).toBe(JSON.stringify({}));
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Insert failed'));

      await expect(
        logAction({ org_id: 'org-1', actor: 'admin', action: 'test' }),
      ).rejects.toThrow('Insert failed');
    });
  });

  // -------------------------------------------------------------------------
  // listAuditLog
  // -------------------------------------------------------------------------
  describe('listAuditLog', () => {
    it('always filters by org_id', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listAuditLog('org-99', {});

      expect(mockQuery.mock.calls[0][0]).toContain('org_id = $1');
      expect(mockQuery.mock.calls[0][1][0]).toBe('org-99');
    });

    it('applies action filter when provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listAuditLog('org-1', { action: 'finding.status_changed' });

      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'finding.status_changed']);
    });

    it('applies resourceType filter when provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listAuditLog('org-1', { resourceType: 'finding' });

      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'finding']);
    });

    it('applies search using ILIKE on action and actor', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listAuditLog('org-1', { search: 'admin' });

      expect(mockQuery.mock.calls[0][0]).toContain('ILIKE');
      expect(mockQuery.mock.calls[0][1]).toContain('%admin%');
    });

    it('does not add ILIKE when search is not provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listAuditLog('org-1', {});

      expect(mockQuery.mock.calls[0][0]).not.toContain('ILIKE');
    });

    it('applies pagination with LIMIT/OFFSET', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '200' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await listAuditLog('org-1', { page: 2, pageSize: 10 });

      const dataParams = mockQuery.mock.calls[1][1];
      expect(dataParams).toEqual(['org-1', 10, 10]); // offset = (2-1)*10 = 10
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.total).toBe(200);
    });

    it('returns paginated result with defaults (page=1, pageSize=20)', async () => {
      const rows = [makeDbAuditLogEntry()];
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows });

      const result = await listAuditLog('org-1', {});

      const dataParams = mockQuery.mock.calls[1][1];
      expect(dataParams).toEqual(['org-1', 20, 0]);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.data).toHaveLength(1);
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));

      await expect(listAuditLog('org-1', {})).rejects.toThrow('DB error');
    });
  });
});
