import { getPool } from './client';
import type { CreateSandboxLogInput, DbSandboxLog } from './types';

const STDOUT_CAP = 256 * 1024;

function cap(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.length > STDOUT_CAP ? s.slice(s.length - STDOUT_CAP) : s;
}

export async function createSandboxLog(input: CreateSandboxLogInput): Promise<DbSandboxLog> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO sandbox_logs
       (fix_attempt_id, step, exit_code, stdout, stderr, duration_ms, timed_out, command)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.fix_attempt_id,
      input.step,
      input.exit_code ?? null,
      cap(input.stdout ?? null),
      cap(input.stderr ?? null),
      input.duration_ms ?? null,
      input.timed_out ?? false,
      input.command ?? null,
    ],
  );
  return rows[0] as DbSandboxLog;
}

export async function listSandboxLogs(fixAttemptId: string): Promise<DbSandboxLog[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM sandbox_logs WHERE fix_attempt_id = $1 ORDER BY created_at ASC',
    [fixAttemptId],
  );
  return rows as DbSandboxLog[];
}
