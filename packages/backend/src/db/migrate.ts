import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { getPool } from './client';

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [file],
    );
    if (rowCount && rowCount > 0) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      );
      await client.query('COMMIT');
      console.warn(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      // Migrations are expected to be idempotent (CREATE ... IF NOT EXISTS,
      // guarded CREATE TYPE, ON CONFLICT inserts). The schema_migrations
      // table above is the source of truth for what has been applied, so a
      // file should normally only run once. As a safety net for databases
      // whose objects predate this tracking table (e.g. an early batch
      // applied via docker-entrypoint-initdb.d), tolerate "already exists"
      // errors: log them and mark the migration applied instead of failing
      // the whole deploy. Any other error is fatal and re-thrown.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        await pool.query(
          'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
          [file],
        );
        console.warn(
          `[migrate] ${file} reported existing objects; marking applied: ${msg}`,
        );
      } else {
        console.error(`[migrate] failed ${file}: ${msg}`);
        throw err;
      }
    } finally {
      client.release();
    }
  }
}
