import { NextResponse, type NextRequest } from 'next/server';
import { getInvitationByToken } from '@/lib/auth/invitations';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;
  const inv = await getInvitationByToken(token);
  if (!inv) {
    return NextResponse.json({ error: 'Invalid or expired invitation' }, { status: 404 });
  }
  return NextResponse.json({
    email: inv.email,
    role: inv.role,
    orgName: inv.org_name,
    inviterEmail: inv.inviter_email,
    expiresAt: inv.expires_at,
  });
}
