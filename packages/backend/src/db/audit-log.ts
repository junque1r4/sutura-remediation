import { getPool } from './client';
import type { DbAuditLogEntry, AuditLogInput, AuditLogFilters, PaginatedResult } from './types';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/**
 * Insert an audit log entry.
 */
export async function logAction(input: AuditLogInput): Promise<DbAuditLogEntry> {
  const pool = getPool();
  const metadataJson = input.metadata_json ?? {};

  const { rows } = await pool.query(
    `INSERT INTO audit_log (org_id, actor, action, resource_type, resource_id, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.org_id, input.actor, input.action, input.resource_type ?? null, input.resource_id ?? null, JSON.stringify(metadataJson)],
  );
  return rows[0] as DbAuditLogEntry;
}

/**
 * Paginated list of audit log entries for an org with optional filters.
 */
export async function listAuditLog(
  orgId: string,
  filters: AuditLogFilters,
): Promise<PaginatedResult<DbAuditLogEntry>> {
  const pool = getPool();
  const page = filters.page ?? DEFAULT_PAGE;
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * pageSize;

  const conditions = ['org_id = $1'];
  const params: unknown[] = [orgId];
  let paramIndex = 2;

  if (filters.action) {
    conditions.push(`action = $${paramIndex++}`);
    params.push(filters.action);
  }

  if (filters.resourceType) {
    conditions.push(`resource_type = $${paramIndex++}`);
    params.push(filters.resourceType);
  }

  if (filters.search) {
    conditions.push(`(action ILIKE $${paramIndex} OR actor ILIKE $${paramIndex})`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  const where = conditions.join(' AND ');

  const countResult = await pool.query(`SELECT COUNT(*) FROM audit_log WHERE ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, pageSize, offset],
  );

  return {
    data: dataResult.rows as DbAuditLogEntry[],
    total,
    page,
    pageSize,
  };
}
