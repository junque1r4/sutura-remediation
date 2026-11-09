import { NextResponse } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { listMembersForOrg } from '@/lib/auth/users';
import { listInvitationsForOrg } from '@/lib/auth/invitations';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requirePermission('org:members:read');
    const [members, invitations] = await Promise.all([
      listMembersForOrg(ctx.orgId),
      listInvitationsForOrg(ctx.orgId),
    ]);
    return NextResponse.json({
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        role: m.role,
        joinedAt: m.joined_at,
        invitedByEmail: m.invited_by_email,
        lastLoginAt: m.last_login_at,
        emailVerifiedAt: m.email_verified_at,
      })),
      pendingInvitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedByEmail: i.inviter_email,
        expiresAt: i.expires_at,
        createdAt: i.created_at,
      })),
    });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
