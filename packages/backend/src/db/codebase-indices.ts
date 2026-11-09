import { getPool } from './client';
import type { DbCodebaseIndex, UpsertIndexInput } from './types';

/**
 * Upsert a codebase index using the (org_id, repo, branch) unique constraint.
 * Sets last_indexed_at to now.
 */
export async function upsertIndex(input: UpsertIndexInput): Promise<DbCodebaseIndex> {
  const pool = getPool();
  const fileCount = input.file_count ?? 0;
  const chunkCount = input.chunk_count ?? 0;

  const { rows } = await pool.query(
    `INSERT INTO codebase_indices (org_id, repo, branch, vector_namespace, file_count, chunk_count, last_indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (org_id, repo, branch)
     DO UPDATE SET vector_namespace = EXCLUDED.vector_namespace, file_count = EXCLUDED.file_count,
       chunk_count = EXCLUDED.chunk_count, last_indexed_at = NOW()
     RETURNING *`,
    [input.org_id, input.repo, input.branch, input.vector_namespace, fileCount, chunkCount],
  );
  return rows[0] as DbCodebaseIndex;
}

/**
 * Get a single codebase index. Returns null if not found.
 */
export async function getIndex(
  orgId: string,
  repo: string,
  branch: string,
): Promise<DbCodebaseIndex | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM codebase_indices WHERE org_id = $1 AND repo = $2 AND branch = $3',
    [orgId, repo, branch],
  );
  return (rows[0] as DbCodebaseIndex) ?? null;
}

/**
 * List all codebase indices for an org, ordered by repo.
 */
export async function listIndices(orgId: string): Promise<DbCodebaseIndex[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM codebase_indices WHERE org_id = $1 ORDER BY repo ASC',
    [orgId],
  );
  return rows as DbCodebaseIndex[];
}
