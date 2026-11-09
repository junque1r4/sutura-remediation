import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { revokeInvitation } from '@/lib/auth/invitations';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const auth = await requirePermission('org:members:invite');
    const { id } = await ctx.params;
    const ok = await revokeInvitation(id, auth.orgId);
    if (!ok) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
