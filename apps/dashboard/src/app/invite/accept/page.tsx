import { Suspense } from 'react';
import { AcceptInviteForm } from './accept-form';

export const dynamic = 'force-dynamic';

export default function AcceptInvitePage() {
  return (
    <div className="w-full max-w-md">
      <div className="rounded-lg border border-border bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-navy">Accept invitation</h1>
        <div className="mt-6">
          <Suspense fallback={null}>
            <AcceptInviteForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
