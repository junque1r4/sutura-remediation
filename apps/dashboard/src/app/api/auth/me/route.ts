import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/lib/auth/server';
import { listMembershipsForUser } from '@/lib/auth/users';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const memberships = await listMembershipsForUser(session.user.id);
  return NextResponse.json({
    user: session.user,
    activeOrgId: session.activeOrgId,
    activeRole: session.membership?.role ?? null,
    memberships: memberships.map((m) => ({
      orgId: m.org_id,
      orgName: m.org_name,
      role: m.role,
    })),
  });
}
