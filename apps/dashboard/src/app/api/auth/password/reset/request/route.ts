import { NextResponse, type NextRequest } from 'next/server';
import { findUserByEmail } from '@/lib/auth/users';
import { createPasswordResetToken } from '@/lib/auth/password-reset';
import { sendPasswordResetEmail } from '@/lib/auth/email';
import { isLocked, recordFailure } from '@/lib/auth/rate-limit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) {
    return NextResponse.json({ ok: true });
  }

  const key = `reset:email:${email}`;
  if (await isLocked(key)) {
    return NextResponse.json({ ok: true });
  }

  const user = await findUserByEmail(email);
  if (user) {
    const token = await createPasswordResetToken(user.id);
    try {
      await sendPasswordResetEmail(email, token);
    } catch (err) {
      console.error('[password-reset] email send failed', err);
    }
  } else {
    await recordFailure(key);
  }
  // Always 200 -- never reveal whether the email exists.
  return NextResponse.json({ ok: true });
}
