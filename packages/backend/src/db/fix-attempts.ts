import { getPool } from './client';
import type {
  DbFixAttempt,
  DbFixAttemptWithFinding,
  CreateFixAttemptInput,
  CreateRunningAttemptInput,
  FixAttemptFilters,
  PaginatedResult,
} from './types';

/**
 * Column list for SELECTs that LEFT JOIN findings into a fix_attempts row.
 * Aliased so the resulting object matches DbFixAttemptWithFinding without
 * post-processing. Kept as a single source of truth so list/get queries
 * stay in sync.
 */
const FIX_ATTEMPT_WITH_FINDING_COLUMNS = `
  fa.*,
  f.title           AS finding_title,
  f.repo            AS finding_repo,
  f.severity        AS finding_severity,
  f.external_id     AS finding_external_id,
  f.scanner_source  AS finding_scanner
`;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/**
 * Insert a new fix attempt and return the created row.
 */
export async function createFixAttempt(input: CreateFixAttemptInput): Promise<DbFixAttempt> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO fix_attempts (finding_id, org_id, prompt_snapshot, claude_model)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.finding_id, input.org_id, input.prompt_snapshot, input.claude_model],
  );
  return rows[0] as DbFixAttempt;
}

/**
 * Insert a fix attempt in 'running' state for the validated-fix pipeline.
 * Tracks attempt_number and links to a parent on retry.
 */
export async function insertRunningAttempt(
  input: CreateRunningAttemptInput,
): Promise<DbFixAttempt> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO fix_attempts
       (finding_id, org_id, prompt_snapshot, claude_model, attempt_number, parent_attempt_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING *`,
    [
      input.finding_id,
      input.org_id,
      input.prompt_snapshot ?? '',
      input.claude_model ?? '',
      input.attempt_number,
      input.parent_attempt_id ?? null,
    ],
  );
  return rows[0] as DbFixAttempt;
}

const UPDATABLE_COLUMNS = [
  'generated_diff',
  'test_result',
  'pr_url',
  'pr_status',
  'claude_tokens_used',
  'completed_at',
  'status',
  'test_output',
  'test_files_added',
  'validation_status',
  'scan_output',
  'scan_tool',
  'failure_reason',
  'prompt_snapshot',
  'claude_model',
  'pr_head_sha',
  'ci_check_status',
  'ci_failure_logs',
  'ci_polled_at',
  'grader_verdict',
  'bypass_attempted',
  'bypass_result',
] as const;

type UpdatableColumn = (typeof UPDATABLE_COLUMNS)[number];
type UpdateInput = Partial<Pick<DbFixAttempt, UpdatableColumn>>;

/**
 * Partial update of a fix attempt by id.
 */
export async function updateFixAttempt(id: string, updates: UpdateInput): Promise<DbFixAttempt> {
  const pool = getPool();
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (!UPDATABLE_COLUMNS.includes(key as UpdatableColumn)) continue;
    setClauses.push(`${key} = $${paramIndex++}`);
    const isJsonbColumn =
      key === 'test_files_added' || key === 'grader_verdict' || key === 'bypass_result';
    params.push(isJsonbColumn && value !== null ? JSON.stringify(value) : value);
  }

  if (setClauses.length === 0) {
    const { rows } = await pool.query('SELECT * FROM fix_attempts WHERE id = $1', [id]);
    return rows[0] as DbFixAttempt;
  }

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE fix_attempts SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params,
  );
  return rows[0] as DbFixAttempt;
}

/**
 * Fetch a single fix attempt by UUID with finding metadata joined.
 * Returns null if not found.
 */
export async function getFixAttempt(id: string): Promise<DbFixAttemptWithFinding | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${FIX_ATTEMPT_WITH_FINDING_COLUMNS}
     FROM fix_attempts fa
     LEFT JOIN findings f ON f.id = fa.finding_id
     WHERE fa.id = $1`,
    [id],
  );
  return (rows[0] as DbFixAttemptWithFinding) ?? null;
}

/**
 * List all fix attempts for a finding, newest first.
 */
export async function listFixAttempts(findingId: string): Promise<DbFixAttempt[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM fix_attempts WHERE finding_id = $1 ORDER BY created_at DESC',
    [findingId],
  );
  return rows as DbFixAttempt[];
}

/**
 * List fix attempts for a finding ordered by attempt_number ASC -- the
 * canonical ordering for a validated-fix retry chain.
 */
export async function listAttemptsByFinding(
  findingId: string,
): Promise<DbFixAttemptWithFinding[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${FIX_ATTEMPT_WITH_FINDING_COLUMNS}
     FROM fix_attempts fa
     LEFT JOIN findings f ON f.id = fa.finding_id
     WHERE fa.finding_id = $1
     ORDER BY fa.attempt_number ASC, fa.created_at ASC`,
    [findingId],
  );
  return rows as DbFixAttemptWithFinding[];
}

/**
 * Paginated list of fix attempts for an org with optional findingId filter.
 * LEFT JOIN finds the parent finding so the dashboard can render title/repo
 * without a second roundtrip.
 */
export async function listFixAttemptsByOrg(
  orgId: string,
  filters: FixAttemptFilters,
): Promise<PaginatedResult<DbFixAttemptWithFinding>> {
  const pool = getPool();
  const page = filters.page ?? DEFAULT_PAGE;
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * pageSize;

  const conditions = ['fa.org_id = $1'];
  const params: unknown[] = [orgId];
  let paramIndex = 2;

  if (filters.findingId) {
    conditions.push(`fa.finding_id = $${paramIndex++}`);
    params.push(filters.findingId);
  }

  const where = conditions.join(' AND ');

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM fix_attempts fa WHERE ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT ${FIX_ATTEMPT_WITH_FINDING_COLUMNS}
     FROM fix_attempts fa
     LEFT JOIN findings f ON f.id = fa.finding_id
     WHERE ${where}
     ORDER BY fa.created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, pageSize, offset],
  );

  return {
    data: dataResult.rows as DbFixAttemptWithFinding[],
    total,
    page,
    pageSize,
  };
}
