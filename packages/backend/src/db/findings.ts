import type { NormalizedFinding, FindingStatus, VerificationVerdict } from '@sutura/common';
import { isDedupKillSwitchOn } from '@sutura/common';
import { getPool } from './client';
import {
  normalizedFindingToDbRow,
  type DbFinding,
  type FindingFilters,
  type PaginatedResult,
} from './types';

const TERMINAL_STATUSES: FindingStatus[] = ['fixed', 'wont_fix'];
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/**
 * Upsert a single NormalizedFinding for the given org.
 *
 * Same-scanner idempotency is provided by the (org_id, scanner_source,
 * external_id) unique constraint -- re-reporting the same issue from the same
 * scanner updates the existing row in place.
 *
 * Cross-scanner dedup (migration 014): after the upsert, if another finding in
 * the same org shares this row's `signature` but comes from a DIFFERENT scanner,
 * the new row is linked to the earliest-ingested canonical via `duplicate_of`.
 * Both rows are kept (provenance); only the link is set. Never dedups across
 * orgs. Disabled by the SUTURA_DEDUP_DISABLED kill-switch.
 */
export async function upsertFinding(orgId: string, finding: NormalizedFinding): Promise<DbFinding> {
  const pool = getPool();
  const row = normalizedFindingToDbRow(orgId, finding);

  const { rows } = await pool.query(
    `INSERT INTO findings (org_id, scanner_source, external_id, title, description, severity, cvss_score, epss_score, cwe_id, cve_id, file_path, line_range, repo, package_name, current_version, fixed_version, raw_payload, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (org_id, scanner_source, external_id)
     DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, severity = EXCLUDED.severity,
       cvss_score = EXCLUDED.cvss_score, epss_score = EXCLUDED.epss_score, cwe_id = EXCLUDED.cwe_id,
       cve_id = EXCLUDED.cve_id, file_path = EXCLUDED.file_path, line_range = EXCLUDED.line_range,
       repo = EXCLUDED.repo, package_name = EXCLUDED.package_name, current_version = EXCLUDED.current_version,
       fixed_version = EXCLUDED.fixed_version, raw_payload = EXCLUDED.raw_payload,
       signature = EXCLUDED.signature
     RETURNING *`,
    [row.org_id, row.scanner_source, row.external_id, row.title, row.description, row.severity,
     row.cvss_score, row.epss_score, row.cwe_id, row.cve_id, row.file_path, row.line_range, row.repo,
     row.package_name, row.current_version, row.fixed_version,
     row.raw_payload === null ? null : JSON.stringify(row.raw_payload),
     row.signature],
  );

  const upserted = rows[0] as DbFinding;
  return linkCrossScannerDuplicate(upserted);
}

/**
 * If `finding` shares its signature with an earlier-ingested finding from a
 * different scanner in the same org, set its `duplicate_of` to that canonical
 * row and return the updated row. Otherwise (no signature, kill-switch on, or
 * no cross-scanner match) returns `finding` unchanged.
 *
 * The canonical is the earliest-ingested same-signature row from another
 * scanner; ties broken by id for determinism. We only ever LINK -- both rows
 * are preserved so provenance per scanner is intact.
 */
async function linkCrossScannerDuplicate(finding: DbFinding): Promise<DbFinding> {
  if (isDedupKillSwitchOn()) return finding;
  if (!finding.signature) return finding;
  // Already linked (e.g. a re-report of a row we deduped before) -- leave as is.
  if (finding.duplicate_of) return finding;

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id FROM findings
      WHERE org_id = $1
        AND signature = $2
        AND scanner_source <> $3
        AND duplicate_of IS NULL
        AND id <> $4
      ORDER BY ingested_at ASC, id ASC
      LIMIT 1`,
    [finding.org_id, finding.signature, finding.scanner_source, finding.id],
  );

  const canonical = rows[0] as { id: string } | undefined;
  if (!canonical) return finding;

  const { rows: updated } = await pool.query(
    'UPDATE findings SET duplicate_of = $1 WHERE id = $2 RETURNING *',
    [canonical.id, finding.id],
  );
  return (updated[0] as DbFinding) ?? finding;
}

/**
 * Batch upsert an array of NormalizedFindings for the given org.
 * Returns the upserted rows. Short-circuits for empty input.
 */
export async function upsertFindings(
  orgId: string,
  findings: NormalizedFinding[],
): Promise<DbFinding[]> {
  if (findings.length === 0) return [];

  const results: DbFinding[] = [];
  for (const finding of findings) {
    results.push(await upsertFinding(orgId, finding));
  }
  return results;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch a single finding by its UUID. Returns null if not found, or if the
 * id is not a valid UUID (some callers pass dashboard-side synthetic ids
 * like `aikido-12345`).
 */
export async function getFinding(id: string): Promise<DbFinding | null> {
  if (!UUID_RE.test(id)) return null;
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM findings WHERE id = $1', [id]);
  return (rows[0] as DbFinding) ?? null;
}

/**
 * Fetch a finding by its scanner-supplied external id. Used to map
 * dashboard-side ids (like `aikido-12345`) to backend UUIDs without forcing
 * the dashboard to round-trip through an upsert first.
 */
export async function getFindingByExternal(
  orgId: string,
  scanner: string,
  externalId: string,
): Promise<DbFinding | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM findings WHERE org_id = $1 AND scanner_source = $2 AND external_id = $3',
    [orgId, scanner, externalId],
  );
  return (rows[0] as DbFinding) ?? null;
}

/**
 * Paginated list of findings for an org with optional filters.
 */
export async function listFindings(
  orgId: string,
  filters: FindingFilters,
): Promise<PaginatedResult<DbFinding>> {
  const pool = getPool();
  const page = filters.page ?? DEFAULT_PAGE;
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * pageSize;

  const conditions = ['org_id = $1'];
  const params: unknown[] = [orgId];
  let paramIndex = 2;

  if (filters.status) { conditions.push(`status = $${paramIndex++}`); params.push(filters.status); }
  if (filters.severity) { conditions.push(`severity = $${paramIndex++}`); params.push(filters.severity); }
  if (filters.scanner) { conditions.push(`scanner_source = $${paramIndex++}`); params.push(filters.scanner); }
  if (filters.repo) { conditions.push(`repo = $${paramIndex++}`); params.push(filters.repo); }

  // Hide cross-scanner duplicates by default so each underlying issue shows
  // once. No-op when the kill-switch is on (no rows are ever linked).
  const hideDuplicates = filters.hideDuplicates ?? true;
  if (hideDuplicates && !isDedupKillSwitchOn()) {
    conditions.push('duplicate_of IS NULL');
  }

  const where = conditions.join(' AND ');

  const countResult = await pool.query(`SELECT COUNT(*) FROM findings WHERE ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT * FROM findings WHERE ${where} ORDER BY ingested_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, pageSize, offset],
  );

  return {
    data: dataResult.rows as DbFinding[],
    total,
    page,
    pageSize,
  };
}

/**
 * Update the status of a finding. Sets resolved_at for terminal statuses
 * (fixed, wont_fix).
 */
export async function updateFindingStatus(
  id: string,
  status: FindingStatus,
): Promise<DbFinding> {
  const pool = getPool();
  const resolvedAt = TERMINAL_STATUSES.includes(status) ? new Date().toISOString() : null;

  const { rows } = await pool.query(
    'UPDATE findings SET status = $1, resolved_at = $2 WHERE id = $3 RETURNING *',
    [status, resolvedAt, id],
  );

  return rows[0] as DbFinding;
}

/**
 * Persist the pre-fix verification verdict on a finding. Stores the full verdict
 * as JSON plus the denormalized reachable / exploitability / verified_at columns
 * (migration 012) for cheap querying. No-ops gracefully if the id is not a UUID.
 */
export async function updateFindingVerdict(
  id: string,
  verdict: VerificationVerdict,
): Promise<DbFinding | null> {
  if (!UUID_RE.test(id)) return null;
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE findings
       SET verification_verdict = $1::jsonb,
           reachable = $2,
           exploitability = $3,
           verified_at = $4
     WHERE id = $5
     RETURNING *`,
    [
      JSON.stringify(verdict),
      verdict.reachable,
      verdict.exploitability,
      verdict.verifiedAt,
      id,
    ],
  );
  return (rows[0] as DbFinding) ?? null;
}
