import { getPool } from './client';
import type { DbFindingAnalysis, CreateFindingAnalysisInput } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Insert one analysis run for a finding and return the created row. One row per
 * run (history) so re-analyzing never destroys the prior analysis.
 */
export async function createFindingAnalysis(
  input: CreateFindingAnalysisInput,
): Promise<DbFindingAnalysis> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO finding_analyses
       (finding_id, org_id, analysis_md, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.finding_id,
      input.org_id,
      input.analysis_md,
      input.model ?? null,
      input.input_tokens ?? 0,
      input.output_tokens ?? 0,
    ],
  );
  return rows[0] as DbFindingAnalysis;
}

/**
 * Fetch the most recent analysis for a finding, or null if none exists (or the
 * id is not a valid UUID — some callers pass synthetic dashboard ids).
 */
export async function getLatestFindingAnalysis(
  findingId: string,
): Promise<DbFindingAnalysis | null> {
  if (!UUID_RE.test(findingId)) return null;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM finding_analyses
     WHERE finding_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [findingId],
  );
  return (rows[0] as DbFindingAnalysis) ?? null;
}
