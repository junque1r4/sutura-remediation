import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <div className="w-full max-w-md">
      <div className="rounded-lg border border-border bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-orange text-base font-extrabold text-navy">
            S
          </div>
          <h1 className="text-2xl font-semibold text-navy">Sign in to Sutura</h1>
          <p className="mt-1 text-sm text-gray-text">
            Continuous vulnerability remediation
          </p>
        </div>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
