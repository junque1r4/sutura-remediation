import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { isRole } from '@/lib/auth/permissions';
import { createInvitation } from '@/lib/auth/invitations';
import { sendInvitationEmail, buildInviteAcceptUrl } from '@/lib/auth/email';
import { getMembership } from '@/lib/auth/users';
import { writeAudit } from '@/lib/auth/audit';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await requirePermission('org:members:invite');
    let body: { email?: unknown; role?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const role = body.role;
    if (!email || !isRole(role)) {
      return NextResponse.json({ error: 'Email and valid role required' }, { status: 400 });
    }
    // Only owners can mint other owners.
    if (role === 'owner' && ctx.role !== 'owner') {
      return NextResponse.json({ error: 'Only owners can invite owners' }, { status: 403 });
    }

    // Reject if a user with that email is already a member of this org.
    const existing = await query<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1 AND m.org_id = $2`,
      [email, ctx.orgId],
    );
    if (existing.rowCount > 0) {
      return NextResponse.json({ error: 'User is already a member' }, { status: 409 });
    }

    const { id, token, expiresAt } = await createInvitation({
      orgId: ctx.orgId,
      email,
      role,
      invitedBy: ctx.userId,
    });

    // Look up the org name for the email body. Stored on memberships pull.
    const inviterMembership = await getMembership(ctx.userId, ctx.orgId);
    const orgName = inviterMembership?.org_name ?? 'your team';

    let emailFailed = false;
    try {
      await sendInvitationEmail(email, token, orgName, ctx.email);
    } catch (err) {
      console.error('[invitation] email send failed', err);
      emailFailed = true;
    }

    await writeAudit({
      orgId: ctx.orgId,
      userId: ctx.userId,
      actor: ctx.email,
      action: 'org.member.invited',
      resourceType: 'invitation',
      resourceId: id,
      metadata: { email, role, emailDelivered: !emailFailed },
    });

    if (emailFailed) {
      return NextResponse.json({
        id,
        email,
        role,
        expiresAt,
        warning: 'Invitation created, but email delivery failed. Share this link manually:',
        acceptUrl: buildInviteAcceptUrl(token),
      });
    }
    return NextResponse.json({ id, email, role, expiresAt });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
