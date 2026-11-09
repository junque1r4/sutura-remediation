import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/server';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { findUserById, updatePasswordHash } from '@/lib/auth/users';
import { writeAudit } from '@/lib/auth/audit';
import { query } from '@/lib/db';
import { listMembershipsForUser } from '@/lib/auth/users';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();
    let body: { currentPassword?: unknown; newPassword?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!current || next.length < 12) {
      return NextResponse.json(
        { error: 'New password must be at least 12 characters' },
        { status: 400 },
      );
    }
    const user = await findUserById(session.user.id);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const ok = await verifyPassword(user.password_hash, current);
    if (!ok) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
    }
    const hash = await hashPassword(next);
    await updatePasswordHash(user.id, hash);
    // Revoke other sessions on password change (keep current).
    await query(
      `UPDATE user_sessions SET revoked_at = now()
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [user.id, session.id],
    );
    const memberships = await listMembershipsForUser(user.id);
    for (const m of memberships) {
      await writeAudit({
        orgId: m.org_id,
        userId: user.id,
        actor: user.email,
        action: 'auth.password.changed',
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status });
  }
}
