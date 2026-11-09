import { NextResponse, type NextRequest } from 'next/server';
import {
  getInvitationByToken,
  markInvitationAccepted,
} from '@/lib/auth/invitations';
import { hashPassword } from '@/lib/auth/password';
import {
  createMembership,
  createUser,
  findUserByEmail,
  updatePasswordHash,
} from '@/lib/auth/users';
import { createSession, getSessionCookieName, getSessionCookieOptions } from '@/lib/auth/session';
import { writeAudit } from '@/lib/auth/audit';

export const runtime = 'nodejs';

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

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

  const inv = await getInvitationByToken(token);
  if (!inv) {
    return NextResponse.json({ error: 'Invalid or expired invitation' }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);

  // Either create the user, or attach a membership to the existing user
  // (and reset their password since the invite is itself proof of email
  // ownership — this is the standard SaaS invite UX).
  let userId: string;
  const existing = await findUserByEmail(inv.email);
  if (existing) {
    userId = existing.id;
    await updatePasswordHash(userId, passwordHash);
  } else {
    const user = await createUser({
      email: inv.email,
      passwordHash,
      emailVerified: true,
    });
    userId = user.id;
  }

  await createMembership({
    userId,
    orgId: inv.org_id,
    role: inv.role,
    invitedBy: inv.invited_by,
  });
  await markInvitationAccepted(inv.id);

  await writeAudit({
    orgId: inv.org_id,
    userId,
    actor: inv.email,
    action: 'org.invitation.accepted',
    resourceType: 'invitation',
    resourceId: inv.id,
    metadata: { role: inv.role },
  });

  const { token: sessionToken } = await createSession({
    userId,
    activeOrgId: inv.org_id,
    userAgent: req.headers.get('user-agent'),
    ip: clientIp(req),
  });

  const res = NextResponse.json({
    user: { id: userId, email: inv.email },
    activeOrgId: inv.org_id,
    role: inv.role,
  });
  res.cookies.set(getSessionCookieName(), sessionToken, getSessionCookieOptions());
  return res;
}
