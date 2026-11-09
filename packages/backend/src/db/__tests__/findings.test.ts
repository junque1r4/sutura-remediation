import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';

// --- Mock the pg pool before importing the repository ---
const mockQuery = vi.fn();

vi.mock('../client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Import AFTER mock registration
import {
  upsertFinding,
  upsertFindings,
  getFinding,
  listFindings,
  updateFindingStatus,
} from '../findings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeNormalizedFinding = (overrides: Partial<NormalizedFinding> = {}): NormalizedFinding => ({
  externalId: 'ext-001',
  scanner: 'aikido',
  title: 'SQL Injection',
  description: 'SQL injection in login form',
  severity: 'high',
  repo: 'org/repo',
  rawPayload: {},
  ...overrides,
});

const makeDbFinding = (overrides: Record<string, unknown> = {}) => ({
  id: 'uuid-001',
  org_id: 'org-1',
  scanner_source: 'aikido',
  external_id: 'ext-001',
  title: 'SQL Injection',
  description: 'SQL injection in login form',
  severity: 'high',
  cvss_score: null,
  epss_score: null,
  cwe_id: null,
  cve_id: null,
  file_path: null,
  line_range: null,
  repo: 'org/repo',
  status: 'open',
  ingested_at: '2024-01-01T00:00:00Z',
  resolved_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findings repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // upsertFinding
  // -------------------------------------------------------------------------
  describe('upsertFinding', () => {
    it('calls INSERT ON CONFLICT with correct params and returns the row', async () => {
      const dbRow = makeDbFinding();
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const finding = makeNormalizedFinding();
      const result = await upsertFinding('org-1', finding);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO findings'),
        expect.arrayContaining(['org-1', 'aikido', 'ext-001']),
      );
      expect(result).toMatchObject({ id: 'uuid-001', status: 'open' });
    });

    it('deduplicates by upserting (ON CONFLICT update)', async () => {
      const dbRow = makeDbFinding({ title: 'Updated Title' });
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const finding = makeNormalizedFinding({ title: 'Updated Title' });
      const result = await upsertFinding('org-1', finding);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result.title).toBe('Updated Title');
    });

    it('relabels repo on conflict so a re-sync updates the container image label', async () => {
      // First sync: repo unknown.
      mockQuery.mockResolvedValueOnce({ rows: [makeDbFinding({ repo: 'unknown' })] });
      const first = await upsertFinding('org-1', makeNormalizedFinding({ repo: 'unknown' }));
      expect(first.repo).toBe('unknown');

      // Re-sync of the same (org, scanner, external_id) carries the image label.
      mockQuery.mockResolvedValueOnce({ rows: [makeDbFinding({ repo: 'org/image' })] });
      const second = await upsertFinding('org-1', makeNormalizedFinding({ repo: 'org/image' }));
      expect(second.repo).toBe('org/image');

      // ON CONFLICT must include repo so the stored label is overwritten.
      const insertSql = mockQuery.mock.calls[0][0] as string;
      expect(insertSql).toContain('repo = EXCLUDED.repo');
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));

      await expect(upsertFinding('org-1', makeNormalizedFinding())).rejects.toThrow('DB error');
    });
  });

  // -------------------------------------------------------------------------
  // upsertFindings (batch)
  // -------------------------------------------------------------------------
  describe('upsertFindings', () => {
    it('calls upsert once per finding', async () => {
      const row1 = makeDbFinding();
      const row2 = makeDbFinding({ external_id: 'ext-002', id: 'uuid-002' });
      mockQuery
        .mockResolvedValueOnce({ rows: [row1] })
        .mockResolvedValueOnce({ rows: [row2] });

      const findings = [
        makeNormalizedFinding(),
        makeNormalizedFinding({ externalId: 'ext-002' }),
      ];
      const result = await upsertFindings('org-1', findings);

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });

    it('returns empty array for empty input', async () => {
      const result = await upsertFindings('org-1', []);
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getFinding
  // -------------------------------------------------------------------------
  describe('getFinding', () => {
    const REAL_UUID = '11111111-1111-4111-8111-111111111111';

    it('fetches finding by id', async () => {
      mockQuery.mockResolvedValue({
        rows: [makeDbFinding({ id: REAL_UUID })],
      });

      const result = await getFinding(REAL_UUID);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM findings WHERE id'),
        [REAL_UUID],
      );
      expect(result?.id).toBe(REAL_UUID);
    });

    it('returns null without querying when id is not a UUID', async () => {
      const result = await getFinding('aikido-12345');
      expect(result).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await getFinding(REAL_UUID);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listFindings with filters and pagination
  // -------------------------------------------------------------------------
  describe('listFindings', () => {
    it('applies status filter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFindings('org-1', { status: 'open' });

      // COUNT query should have 2 params: org_id and status
      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'open']);
    });

    it('applies severity filter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFindings('org-1', { severity: 'critical' });

      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'critical']);
    });

    it('applies scanner filter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFindings('org-1', { scanner: 'snyk' });

      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'snyk']);
    });

    it('applies repo filter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFindings('org-1', { repo: 'org/myrepo' });

      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'org/myrepo']);
    });

    it('applies pagination with LIMIT/OFFSET', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await listFindings('org-1', { page: 2, pageSize: 10 });

      // Data query: params = [org_id, pageSize, offset]
      const dataParams = mockQuery.mock.calls[1][1];
      expect(dataParams).toEqual(['org-1', 10, 10]); // offset = (2-1)*10 = 10
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.total).toBe(50);
    });

    it('returns paginated result with defaults (page=1, pageSize=20)', async () => {
      const rows = [makeDbFinding()];
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows });

      const result = await listFindings('org-1', {});

      const dataParams = mockQuery.mock.calls[1][1];
      expect(dataParams).toEqual(['org-1', 20, 0]); // offset = 0
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.data).toHaveLength(1);
    });

    it('always filters by org_id', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFindings('org-99', {});

      expect(mockQuery.mock.calls[0][0]).toContain('org_id = $1');
      expect(mockQuery.mock.calls[0][1][0]).toBe('org-99');
    });
  });

  // -------------------------------------------------------------------------
  // Cross-scanner signature dedup (migration 014)
  // -------------------------------------------------------------------------
  describe('cross-scanner dedup', () => {
    const SIG = 'a'.repeat(64);
    const AIKIDO_UUID = '11111111-1111-4111-8111-111111111111';
    const SNYK_UUID = '22222222-2222-4222-8222-222222222222';

    it('links a same-CVE finding from a different scanner to the canonical', async () => {
      // INSERT returns the new snyk row (signature set, not yet linked).
      mockQuery
        .mockResolvedValueOnce({
          rows: [makeDbFinding({
            id: SNYK_UUID,
            scanner_source: 'snyk',
            external_id: 'SNYK-1',
            signature: SIG,
            duplicate_of: null,
          })],
        })
        // SELECT canonical -> the earlier aikido row.
        .mockResolvedValueOnce({ rows: [{ id: AIKIDO_UUID }] })
        // UPDATE duplicate_of -> returns the linked snyk row.
        .mockResolvedValueOnce({
          rows: [makeDbFinding({
            id: SNYK_UUID,
            scanner_source: 'snyk',
            external_id: 'SNYK-1',
            signature: SIG,
            duplicate_of: AIKIDO_UUID,
          })],
        });

      const result = await upsertFinding('org-1', makeNormalizedFinding({
        scanner: 'snyk',
        externalId: 'SNYK-1',
        cveId: 'CVE-2021-1',
      }));

      expect(result.duplicate_of).toBe(AIKIDO_UUID);
      // The canonical lookup must be scoped to org, different scanner, unlinked.
      const selectSql = mockQuery.mock.calls[1][0] as string;
      expect(selectSql).toContain('org_id = $1');
      expect(selectSql).toContain('scanner_source <> $3');
      expect(selectSql).toContain('duplicate_of IS NULL');
      expect(mockQuery.mock.calls[1][1]).toEqual(['org-1', SIG, 'snyk', SNYK_UUID]);
      // UPDATE links new row to the canonical.
      expect(mockQuery.mock.calls[2][0]).toContain('SET duplicate_of = $1');
      expect(mockQuery.mock.calls[2][1]).toEqual([AIKIDO_UUID, SNYK_UUID]);
    });

    it('does not link when no cross-scanner match exists (different CVE)', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [makeDbFinding({
            id: SNYK_UUID,
            scanner_source: 'snyk',
            signature: 'b'.repeat(64),
            duplicate_of: null,
          })],
        })
        // SELECT canonical -> none.
        .mockResolvedValueOnce({ rows: [] });

      const result = await upsertFinding('org-1', makeNormalizedFinding({
        scanner: 'snyk',
        cveId: 'CVE-2021-2',
      }));

      expect(result.duplicate_of).toBeNull();
      // INSERT + SELECT only, no UPDATE.
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('same-scanner re-report stays a single row and is never self-linked', async () => {
      // The canonical lookup excludes the same scanner, so it returns none.
      mockQuery
        .mockResolvedValueOnce({
          rows: [makeDbFinding({
            id: AIKIDO_UUID,
            scanner_source: 'aikido',
            signature: SIG,
            duplicate_of: null,
          })],
        })
        .mockResolvedValueOnce({ rows: [] });

      const result = await upsertFinding('org-1', makeNormalizedFinding({ scanner: 'aikido' }));

      expect(result.duplicate_of).toBeNull();
      expect(mockQuery.mock.calls[1][1]).toEqual(['org-1', SIG, 'aikido', AIKIDO_UUID]);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('does not link an already-linked row (re-report of a duplicate)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeDbFinding({
          id: SNYK_UUID,
          scanner_source: 'snyk',
          signature: SIG,
          duplicate_of: AIKIDO_UUID,
        })],
      });

      const result = await upsertFinding('org-1', makeNormalizedFinding({ scanner: 'snyk' }));

      expect(result.duplicate_of).toBe(AIKIDO_UUID);
      // No SELECT/UPDATE -- short-circuits on existing link.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('passes the computed signature in the INSERT params', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeDbFinding({ signature: SIG })] })
        .mockResolvedValueOnce({ rows: [] });

      await upsertFinding('org-1', makeNormalizedFinding());

      const insertSql = mockQuery.mock.calls[0][0] as string;
      expect(insertSql).toContain('signature');
      // 18th positional param is the signature (a 64-char hex string).
      const insertParams = mockQuery.mock.calls[0][1] as unknown[];
      expect(insertParams).toHaveLength(18);
      expect(insertParams[17]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not dedup across orgs (canonical lookup is org-scoped)', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [makeDbFinding({ id: SNYK_UUID, org_id: 'org-2', scanner_source: 'snyk', signature: SIG, duplicate_of: null })],
        })
        // SELECT finds nothing because the only same-signature row is in another org.
        .mockResolvedValueOnce({ rows: [] });

      const result = await upsertFinding('org-2', makeNormalizedFinding({ scanner: 'snyk' }));

      expect(result.duplicate_of).toBeNull();
      expect(mockQuery.mock.calls[1][1][0]).toBe('org-2');
    });

    it('skips linking entirely when the dedup kill-switch is on', async () => {
      const prev = process.env.SUTURA_DEDUP_DISABLED;
      process.env.SUTURA_DEDUP_DISABLED = '1';
      try {
        mockQuery.mockResolvedValueOnce({
          rows: [makeDbFinding({ id: SNYK_UUID, scanner_source: 'snyk', signature: SIG, duplicate_of: null })],
        });

        const result = await upsertFinding('org-1', makeNormalizedFinding({ scanner: 'snyk' }));

        expect(result.duplicate_of).toBeNull();
        // INSERT only -- no canonical lookup.
        expect(mockQuery).toHaveBeenCalledTimes(1);
      } finally {
        if (prev === undefined) delete process.env.SUTURA_DEDUP_DISABLED;
        else process.env.SUTURA_DEDUP_DISABLED = prev;
      }
    });
  });

  // -------------------------------------------------------------------------
  // listFindings hideDuplicates
  // -------------------------------------------------------------------------
  describe('listFindings hideDuplicates', () => {
    it('hides duplicates by default (duplicate_of IS NULL)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFindings('org-1', {});

      expect(mockQuery.mock.calls[0][0]).toContain('duplicate_of IS NULL');
    });

    it('includes duplicates when hideDuplicates is false', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await listFindings('org-1', { hideDuplicates: false });

      expect(mockQuery.mock.calls[0][0]).not.toContain('duplicate_of IS NULL');
    });

    it('does not add the duplicate filter when the kill-switch is on', async () => {
      const prev = process.env.SUTURA_DEDUP_DISABLED;
      process.env.SUTURA_DEDUP_DISABLED = '1';
      try {
        mockQuery
          .mockResolvedValueOnce({ rows: [{ count: '0' }] })
          .mockResolvedValueOnce({ rows: [] });

        await listFindings('org-1', {});

        expect(mockQuery.mock.calls[0][0]).not.toContain('duplicate_of IS NULL');
      } finally {
        if (prev === undefined) delete process.env.SUTURA_DEDUP_DISABLED;
        else process.env.SUTURA_DEDUP_DISABLED = prev;
      }
    });
  });

  // -------------------------------------------------------------------------
  // updateFindingStatus
  // -------------------------------------------------------------------------
  describe('updateFindingStatus', () => {
    it('updates status without resolved_at for non-terminal status', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbFinding({ status: 'fixing' })] });

      const result = await updateFindingStatus('uuid-001', 'fixing');

      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBe('fixing');
      expect(params[1]).toBeNull(); // resolved_at should be null
      expect(params[2]).toBe('uuid-001');
      expect(result.status).toBe('fixing');
    });

    it('sets resolved_at for "fixed" status', async () => {
      mockQuery.mockResolvedValue({
        rows: [makeDbFinding({ status: 'fixed', resolved_at: '2024-06-01T00:00:00Z' })],
      });

      await updateFindingStatus('uuid-001', 'fixed');

      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBe('fixed');
      expect(params[1]).toBeDefined();
      expect(typeof params[1]).toBe('string');
    });

    it('sets resolved_at for "wont_fix" status', async () => {
      mockQuery.mockResolvedValue({
        rows: [makeDbFinding({ status: 'wont_fix', resolved_at: '2024-06-01T00:00:00Z' })],
      });

      await updateFindingStatus('uuid-001', 'wont_fix');

      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBe('wont_fix');
      expect(params[1]).toBeDefined();
    });

    it('does not set resolved_at for "failed" status', async () => {
      mockQuery.mockResolvedValue({ rows: [makeDbFinding({ status: 'failed' })] });

      await updateFindingStatus('uuid-001', 'failed');

      const params = mockQuery.mock.calls[0][1];
      expect(params[1]).toBeNull();
    });

    it('throws when pg returns an error', async () => {
      mockQuery.mockRejectedValue(new Error('Update failed'));

      await expect(updateFindingStatus('uuid-001', 'fixed')).rejects.toThrow('Update failed');
    });
  });
});
