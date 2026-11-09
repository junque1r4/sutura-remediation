import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { resendInvitation } from '@/lib/auth/invitations';
import { sendInvitationEmail, buildInviteAcceptUrl } from '@/lib/auth/email';
import { getMembership } from '@/lib/auth/users';
import { writeAudit } from '@/lib/auth/audit';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const auth = await requirePermission('org:members:invite');
    const { id } = await ctx.params;
    const result = await resendInvitation(id, auth.orgId);
    if (!result) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }
    const inviter = await getMembership(auth.userId, auth.orgId);
    const orgName = inviter?.org_name ?? 'your team';
    let emailFailed = false;
    try {
      await sendInvitationEmail(result.row.email, result.token, orgName, auth.email);
    } catch (err) {
      console.error('[invitation/resend] email send failed', err);
      emailFailed = true;
    }
    await writeAudit({
      orgId: auth.orgId,
      userId: auth.userId,
      actor: auth.email,
      action: 'org.invitation.resent',
      resourceType: 'invitation',
      resourceId: id,
      metadata: { email: result.row.email, role: result.row.role, emailDelivered: !emailFailed },
    });
    if (emailFailed) {
      return NextResponse.json({
        id: result.row.id,
        email: result.row.email,
        role: result.row.role,
        expiresAt: result.row.expires_at,
        warning: 'Invitation regenerated, but email delivery failed. Share this link manually:',
        acceptUrl: buildInviteAcceptUrl(result.token),
      });
    }
    return NextResponse.json({
      id: result.row.id,
      email: result.row.email,
      role: result.row.role,
      expiresAt: result.row.expires_at,
    });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
