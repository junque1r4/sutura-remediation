import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, jsonError } from '@/lib/auth/server';
import { revokeSession } from '@/lib/auth/session';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = await ctx.params;
    // Only revoke sessions that belong to the caller.
    const own = await query<{ id: string }>(
      `SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2`,
      [id, session.user.id],
    );
    if (own.rowCount === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    await revokeSession(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
