import { requireAuthOrRedirect } from '@/lib/auth/server';
import { hasPermission } from '@/lib/auth/permissions';
import { SettingsTabs } from './settings-tabs';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAuthOrRedirect();
  const canSeeTeam = hasPermission(ctx.role, 'org:members:read');

  return (
    <div className="space-y-6">
      <SettingsTabs canSeeTeam={canSeeTeam} />
      <div>{children}</div>
    </div>
  );
}
