import { Pool } from 'pg';
import { getConfig } from '../config';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  const config = getConfig();
  _pool = new Pool({ connectionString: config.DATABASE_URL });
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
