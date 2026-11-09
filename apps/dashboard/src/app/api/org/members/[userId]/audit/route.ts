import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { listAuditForUserInOrg } from '@/lib/auth/audit';
import { getMembership } from '@/lib/auth/users';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ userId: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const auth = await requirePermission('org:members:read');
    const { userId } = await ctx.params;
    // Confirm target is a member of this org before exposing their log.
    const target = await getMembership(userId, auth.orgId);
    if (!target) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const entries = await listAuditForUserInOrg(userId, auth.orgId, { limit });
    return NextResponse.json({ entries });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
