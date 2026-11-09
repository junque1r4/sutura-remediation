import 'server-only';
import { query } from '@/lib/db';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

interface RateLimitRow {
  attempts: number;
  window_started_at: Date;
  locked_until: Date | null;
}

export async function isLocked(key: string): Promise<boolean> {
  const result = await query<{ locked_until: Date | null }>(
    `SELECT locked_until FROM auth_rate_limits WHERE key = $1`,
    [key],
  );
  const row = result.rows[0];
  if (!row || !row.locked_until) return false;
  return row.locked_until > new Date();
}

export async function recordFailure(key: string): Promise<{ locked: boolean }> {
  const now = new Date();
  const result = await query<RateLimitRow>(
    `INSERT INTO auth_rate_limits (key, attempts, window_started_at)
       VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE
         SET attempts = CASE
                          WHEN auth_rate_limits.window_started_at < now() - INTERVAL '${Math.floor(WINDOW_MS / 1000)} seconds'
                          THEN 1
                          ELSE auth_rate_limits.attempts + 1
                        END,
             window_started_at = CASE
                                   WHEN auth_rate_limits.window_started_at < now() - INTERVAL '${Math.floor(WINDOW_MS / 1000)} seconds'
                                   THEN now()
                                   ELSE auth_rate_limits.window_started_at
                                 END
       RETURNING attempts, window_started_at, locked_until`,
    [key],
  );
  const row = result.rows[0];
  if (row.attempts >= MAX_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + LOCK_MS);
    await query(
      `UPDATE auth_rate_limits SET locked_until = $1 WHERE key = $2`,
      [lockedUntil, key],
    );
    return { locked: true };
  }
  return { locked: false };
}

export async function clearFailures(key: string): Promise<void> {
  await query(`DELETE FROM auth_rate_limits WHERE key = $1`, [key]);
}
