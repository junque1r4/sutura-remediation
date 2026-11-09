import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { listSessionsForUserAsAdmin } from '@/lib/auth/session';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ userId: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const auth = await requirePermission('org:members:read');
    const { userId } = await ctx.params;
    const sessions = await listSessionsForUserAsAdmin(userId, auth.orgId);
    if (!sessions) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    return NextResponse.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        expiresAt: s.expiresAt,
      })),
    });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
