import { ForgotPasswordForm } from './forgot-password-form';

export default function ForgotPasswordPage() {
  return (
    <div className="w-full max-w-md">
      <div className="rounded-lg border border-border bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-navy">Reset your password</h1>
        <p className="mt-1 text-sm text-gray-text">
          Enter your email and we&apos;ll send you a reset link.
        </p>
        <div className="mt-6">
          <ForgotPasswordForm />
        </div>
      </div>
    </div>
  );
}
