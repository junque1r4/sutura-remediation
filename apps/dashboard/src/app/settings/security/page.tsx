import { requireAuthOrRedirect } from '@/lib/auth/server';
import { SecurityClient } from './security-client';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const ctx = await requireAuthOrRedirect();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-navy">Security</h1>
        <p className="mt-1 text-sm text-gray-text">Signed in as {ctx.email}</p>
      </header>
      <SecurityClient />
    </div>
  );
}
