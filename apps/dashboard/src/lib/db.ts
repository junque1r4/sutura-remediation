import 'server-only';
import { Pool } from 'pg';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not set');
  }
  _pool = new Pool({ connectionString });
  return _pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number }> {
  const pool = getPool();
  const result = await pool.query(sql, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}
