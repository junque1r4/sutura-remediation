import { redirect } from 'next/navigation';
import { requireAuthOrRedirect } from '@/lib/auth/server';
import { hasPermission } from '@/lib/auth/permissions';
import { MembersClient } from './members-client';

export const dynamic = 'force-dynamic';

export default async function MembersPage() {
  const ctx = await requireAuthOrRedirect();
  if (!hasPermission(ctx.role, 'org:members:read')) {
    redirect('/');
  }
  const canInvite = hasPermission(ctx.role, 'org:members:invite');
  const canChangeRole = hasPermission(ctx.role, 'org:members:role');
  const canRemove = hasPermission(ctx.role, 'org:members:remove');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-navy">Team members</h1>
        <p className="mt-1 text-sm text-gray-text">
          Manage who has access to {ctx.orgName} and what they can do.
        </p>
      </header>
      <MembersClient
        currentUserId={ctx.userId}
        currentRole={ctx.role}
        canInvite={canInvite}
        canChangeRole={canChangeRole}
        canRemove={canRemove}
      />
    </div>
  );
}
