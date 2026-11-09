import { Suspense } from 'react';
import { ResetPasswordForm } from './reset-password-form';

export const dynamic = 'force-dynamic';

export default function ResetPasswordPage() {
  return (
    <div className="w-full max-w-md">
      <div className="rounded-lg border border-border bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-navy">Choose a new password</h1>
        <p className="mt-1 text-sm text-gray-text">
          Use at least 12 characters.
        </p>
        <div className="mt-6">
          <Suspense fallback={null}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
