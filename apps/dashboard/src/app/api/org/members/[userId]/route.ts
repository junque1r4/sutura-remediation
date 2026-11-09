import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, jsonError } from '@/lib/auth/server';
import { isRole } from '@/lib/auth/permissions';
import {
  countOwners,
  getMembership,
  removeMembership,
  updateMembershipRole,
} from '@/lib/auth/users';
import { writeAudit } from '@/lib/auth/audit';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ userId: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const auth = await requirePermission('org:members:role');
    const { userId } = await ctx.params;
    let body: { role?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const role = body.role;
    if (!isRole(role)) {
      return NextResponse.json({ error: 'Valid role required' }, { status: 400 });
    }

    if (role === 'owner' && auth.role !== 'owner') {
      return NextResponse.json({ error: 'Only owners can promote to owner' }, { status: 403 });
    }

    const target = await getMembership(userId, auth.orgId);
    if (!target) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Don't allow demoting the last owner.
    if (target.role === 'owner' && role !== 'owner') {
      const owners = await countOwners(auth.orgId);
      if (owners <= 1) {
        return NextResponse.json(
          { error: 'Cannot demote the last owner' },
          { status: 400 },
        );
      }
    }

    const ok = await updateMembershipRole(userId, auth.orgId, role);
    if (!ok) {
      return NextResponse.json({ error: 'Update failed' }, { status: 500 });
    }
    await writeAudit({
      orgId: auth.orgId,
      userId: auth.userId,
      actor: auth.email,
      action: 'org.member.role_changed',
      resourceType: 'user',
      resourceId: userId,
      metadata: { previousRole: target.role, newRole: role },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const auth = await requirePermission('org:members:remove');
    const { userId } = await ctx.params;

    if (userId === auth.userId) {
      return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });
    }

    const target = await getMembership(userId, auth.orgId);
    if (!target) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    if (target.role === 'owner') {
      const owners = await countOwners(auth.orgId);
      if (owners <= 1) {
        return NextResponse.json(
          { error: 'Cannot remove the last owner' },
          { status: 400 },
        );
      }
      if (auth.role !== 'owner') {
        return NextResponse.json({ error: 'Only owners can remove owners' }, { status: 403 });
      }
    }

    const ok = await removeMembership(userId, auth.orgId);
    if (!ok) {
      return NextResponse.json({ error: 'Remove failed' }, { status: 500 });
    }
    await writeAudit({
      orgId: auth.orgId,
      userId: auth.userId,
      actor: auth.email,
      action: 'org.member.removed',
      resourceType: 'user',
      resourceId: userId,
      metadata: { removedRole: target.role },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status });
  }
}
