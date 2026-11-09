import { VALIDATION_LIMITS } from '@sutura/common';
import { getPool } from './client';
import { computeCostUsd } from '../lib/token-pricing';
import { redactSecrets, cap } from '../lib/data-minimization';
import type {
  DbTokenUsage,
  CreateTokenUsageInput,
  TokenUsageFilters,
  TokenUsageStats,
  FindingCostRanking,
  FindingCostBreakdown,
  TokenUsageOperation,
  PaginatedResult,
} from './types';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;

// In single-tenant / no-auth demo mode `orgId` is empty and rows are stored
// with `org_id IS NULL`. Using `org_id = $N` against UUID-typed columns would
// fail validation, and even if it didn't, `= NULL` never matches. Each query
// in this file branches on whether an explicit org id was supplied.

// Data minimization: we never persist the full prompt/response. Only token
// counts and cost are needed by readers (aggregates only -- see
// getTokenUsageStats / getFindingCost*). We keep a short, secret-scrubbed
// excerpt for debugging, capped to MAX_TOKEN_EXCERPT_BYTES.
function excerpt(s: string | null | undefined): string | null {
  if (s == null) return null;
  return cap(redactSecrets(s), VALIDATION_LIMITS.MAX_TOKEN_EXCERPT_BYTES);
}

export async function createTokenUsage(input: CreateTokenUsageInput): Promise<DbTokenUsage> {
  const pool = getPool();
  const cost = computeCostUsd(input.model, input.input_tokens, input.output_tokens);
  const { rows } = await pool.query(
    `INSERT INTO token_usage
       (org_id, operation, model, input_tokens, output_tokens, cost_usd,
        finding_id, finding_title, finding_severity,
        fix_attempt_id, prompt, response)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      input.org_id ?? null,
      input.operation,
      input.model,
      input.input_tokens,
      input.output_tokens,
      cost,
      input.finding_id ?? null,
      input.finding_title ?? null,
      input.finding_severity ?? null,
      input.fix_attempt_id ?? null,
      excerpt(input.prompt),
      excerpt(input.response),
    ],
  );
  return rows[0] as DbTokenUsage;
}

export async function listTokenUsage(
  orgId: string,
  filters: TokenUsageFilters,
): Promise<PaginatedResult<DbTokenUsage>> {
  const pool = getPool();
  const page = filters.page ?? DEFAULT_PAGE;
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (orgId) {
    conditions.push(`org_id = $${i++}`);
    params.push(orgId);
  } else {
    conditions.push('org_id IS NULL');
  }

  if (filters.operation) {
    conditions.push(`operation = $${i++}`);
    params.push(filters.operation);
  }
  if (filters.findingId) {
    conditions.push(`finding_id = $${i++}`);
    params.push(filters.findingId);
  }

  const where = conditions.join(' AND ');
  const countRes = await pool.query(`SELECT COUNT(*) FROM token_usage WHERE ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  const dataRes = await pool.query(
    `SELECT * FROM token_usage WHERE ${where}
     ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`,
    [...params, pageSize, offset],
  );

  return { data: dataRes.rows as DbTokenUsage[], total, page, pageSize };
}

export async function getTokenUsageStats(orgId: string): Promise<TokenUsageStats> {
  const pool = getPool();
  const orgClause = orgId ? 'org_id = $1' : 'org_id IS NULL';
  const params = orgId ? [orgId] : [];
  const { rows } = await pool.query(
    `SELECT operation,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
            COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
     FROM token_usage
     WHERE ${orgClause}
     GROUP BY operation`,
    params,
  );

  const byOperation = rows.map((r) => ({
    operation: r.operation as TokenUsageStats['byOperation'][number]['operation'],
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: Number(r.cost_usd),
  }));

  return {
    totalCalls: byOperation.reduce((a, b) => a + b.calls, 0),
    totalInputTokens: byOperation.reduce((a, b) => a + b.inputTokens, 0),
    totalOutputTokens: byOperation.reduce((a, b) => a + b.outputTokens, 0),
    totalCostUsd: byOperation.reduce((a, b) => a + b.costUsd, 0),
    byOperation,
  };
}

/**
 * Ranking of findings by total cost across all token_usage rows.
 * Picks the most recent title/severity observed for each finding_id.
 */
export async function getFindingCostRanking(
  orgId: string,
  limit = 100,
): Promise<FindingCostRanking[]> {
  const pool = getPool();
  const orgClause = orgId ? 'org_id = $1' : 'org_id IS NULL';
  const tOrgClause = orgId ? 't.org_id = $1' : 't.org_id IS NULL';
  const limitParam = orgId ? '$2' : '$1';
  const params: unknown[] = orgId ? [orgId, limit] : [limit];
  const { rows } = await pool.query(
    `SELECT
       t.finding_id AS finding_id,
       (SELECT finding_title FROM token_usage
         WHERE ${orgClause} AND finding_id = t.finding_id
         ORDER BY created_at DESC LIMIT 1) AS finding_title,
       (SELECT finding_severity FROM token_usage
         WHERE ${orgClause} AND finding_id = t.finding_id
         ORDER BY created_at DESC LIMIT 1) AS finding_severity,
       COUNT(*)::int AS calls,
       COALESCE(SUM(t.input_tokens), 0)::int AS input_tokens,
       COALESCE(SUM(t.output_tokens), 0)::int AS output_tokens,
       COALESCE(SUM(t.cost_usd), 0)::numeric AS cost_usd,
       MAX(t.created_at) AS last_activity
     FROM token_usage t
     WHERE ${tOrgClause} AND t.finding_id IS NOT NULL
     GROUP BY t.finding_id
     ORDER BY cost_usd DESC
     LIMIT ${limitParam}`,
    params,
  );

  return rows.map((r) => ({
    findingId: r.finding_id,
    findingTitle: r.finding_title,
    findingSeverity: r.finding_severity,
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.input_tokens + r.output_tokens,
    costUsd: Number(r.cost_usd),
    lastActivity: r.last_activity,
  }));
}

/**
 * Breakdown of token usage for a single finding (by operation).
 */
export async function getFindingCostBreakdown(
  orgId: string,
  findingId: string,
): Promise<FindingCostBreakdown | null> {
  const pool = getPool();
  const orgClause = orgId ? 'org_id = $1' : 'org_id IS NULL';
  const findingParam = orgId ? '$2' : '$1';
  const params: unknown[] = orgId ? [orgId, findingId] : [findingId];
  const { rows } = await pool.query(
    `SELECT operation,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
            COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
     FROM token_usage
     WHERE ${orgClause} AND finding_id = ${findingParam}
     GROUP BY operation`,
    params,
  );

  if (rows.length === 0) return null;

  const byOperation = rows.map((r) => ({
    operation: r.operation as TokenUsageOperation,
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: Number(r.cost_usd),
  }));

  const meta = await pool.query(
    `SELECT finding_title, finding_severity FROM token_usage
     WHERE ${orgClause} AND finding_id = ${findingParam}
     ORDER BY created_at DESC LIMIT 1`,
    params,
  );

  return {
    findingId,
    findingTitle: meta.rows[0]?.finding_title ?? null,
    findingSeverity: meta.rows[0]?.finding_severity ?? null,
    calls: byOperation.reduce((a, b) => a + b.calls, 0),
    inputTokens: byOperation.reduce((a, b) => a + b.inputTokens, 0),
    outputTokens: byOperation.reduce((a, b) => a + b.outputTokens, 0),
    costUsd: byOperation.reduce((a, b) => a + b.costUsd, 0),
    byOperation,
  };
}
