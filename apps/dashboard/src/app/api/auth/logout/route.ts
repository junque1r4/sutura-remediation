import { NextResponse, type NextRequest } from 'next/server';
import {
  getSessionCookieName,
  revokeSessionByToken,
  validateSessionToken,
} from '@/lib/auth/session';
import { writeAudit } from '@/lib/auth/audit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(getSessionCookieName())?.value;
  if (token) {
    const session = await validateSessionToken(token);
    if (session && session.membership) {
      await writeAudit({
        orgId: session.membership.orgId,
        userId: session.user.id,
        actor: session.user.email,
        action: 'auth.logout',
      });
    }
    await revokeSessionByToken(token);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(getSessionCookieName(), '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return res;
}
