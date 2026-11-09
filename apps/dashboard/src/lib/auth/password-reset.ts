import 'server-only';
import { query } from '@/lib/db';
import { generateToken, hashToken } from './tokens';

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = generateToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );
  return token;
}

interface ResetRow {
  id: string;
  user_id: string;
}

export async function consumePasswordResetToken(token: string): Promise<string | null> {
  const hash = hashToken(token);
  const result = await query<ResetRow>(
    `UPDATE password_reset_tokens
        SET used_at = now()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id`,
    [hash],
  );
  return result.rows[0]?.user_id ?? null;
}
