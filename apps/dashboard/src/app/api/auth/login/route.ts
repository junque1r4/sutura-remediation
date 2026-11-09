import { NextResponse, type NextRequest } from 'next/server';
import { findUserByEmail, listMembershipsForUser, recordLoginSuccess } from '@/lib/auth/users';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, getSessionCookieName, getSessionCookieOptions } from '@/lib/auth/session';
import { clearFailures, isLocked, recordFailure } from '@/lib/auth/rate-limit';
import { writeAudit } from '@/lib/auth/audit';

export const runtime = 'nodejs';

const GENERIC_ERROR = 'Invalid email or password';

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
  }

  const ip = clientIp(req);
  const emailKey = `login:email:${email}`;
  const ipKey = `login:ip:${ip}`;

  if ((await isLocked(emailKey)) || (await isLocked(ipKey))) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again in 15 minutes.' },
      { status: 429 },
    );
  }

  const user = await findUserByEmail(email);
  // Always run argon2 verify (against the user's hash, or a dummy hash) so
  // the response time doesn't reveal whether the email exists.
  const dummyHash =
    '$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0c2FsdHNhbHQ$Pf3VEpFq+rIYscmHBfh2vQ8oeQRBaqyybVcg5Skj+lA';
  const hashToCheck = user?.password_hash ?? dummyHash;
  const ok = await verifyPassword(hashToCheck, password);

  if (!user || !ok) {
    await recordFailure(emailKey);
    await recordFailure(ipKey);
    if (user) {
      // We know the email exists; record audit for the existing user.
      await writeAudit({
        orgId: '00000000-0000-0000-0000-000000000001',
        userId: user.id,
        actor: user.email,
        action: 'auth.login.failed',
        metadata: { ip },
      });
    }
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const memberships = await listMembershipsForUser(user.id);
  const activeOrgId = memberships[0]?.org_id ?? null;

  const { token } = await createSession({
    userId: user.id,
    activeOrgId,
    userAgent: req.headers.get('user-agent'),
    ip,
  });

  await recordLoginSuccess(user.id);
  await clearFailures(emailKey);
  await clearFailures(ipKey);

  if (activeOrgId) {
    await writeAudit({
      orgId: activeOrgId,
      userId: user.id,
      actor: user.email,
      action: 'auth.login.succeeded',
      metadata: { ip },
    });
  }

  const res = NextResponse.json({
    user: { id: user.id, email: user.email },
    memberships: memberships.map((m) => ({
      orgId: m.org_id,
      orgName: m.org_name,
      role: m.role,
    })),
    activeOrgId,
  });
  res.cookies.set(getSessionCookieName(), token, getSessionCookieOptions());
  return res;
}
