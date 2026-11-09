import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { getMemberDetail } from '@/lib/auth/users';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ userId: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const auth = await requirePermission('org:members:read');
    const { userId } = await ctx.params;
    const detail = await getMemberDetail(userId, auth.orgId);
    if (!detail) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
