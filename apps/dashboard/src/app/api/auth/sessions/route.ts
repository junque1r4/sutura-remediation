import { NextResponse } from 'next/server';
import { requireSession, jsonError } from '@/lib/auth/server';
import { listSessionsForUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const sessions = await listSessionsForUser(session.user.id);
    return NextResponse.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        expiresAt: s.expiresAt,
        current: s.id === session.id,
      })),
    });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
