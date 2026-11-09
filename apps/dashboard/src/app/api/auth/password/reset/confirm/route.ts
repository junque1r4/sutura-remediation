import { NextResponse, type NextRequest } from 'next/server';
import { consumePasswordResetToken } from '@/lib/auth/password-reset';
import { hashPassword } from '@/lib/auth/password';
import { updatePasswordHash } from '@/lib/auth/users';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { token?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!token || password.length < 12) {
    return NextResponse.json(
      { error: 'Invalid request. Password must be at least 12 characters.' },
      { status: 400 },
    );
  }

  const userId = await consumePasswordResetToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
  }

  const hash = await hashPassword(password);
  await updatePasswordHash(userId, hash);

  // Revoke all existing sessions on password change for safety.
  await query(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );

  return NextResponse.json({ ok: true });
}
