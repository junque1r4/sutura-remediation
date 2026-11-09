'use client';

import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { PasswordInput } from '@/components/password-input';
import { validatePasswordPair } from '@/lib/auth/validate';

export function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const validationError = validatePasswordPair(password, confirm);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/password/reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Reset failed');
        return;
      }
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <p role="alert" className="text-sm text-severity-critical">
        Missing token. Use the link from your email.
      </p>
    );
  }

  if (done) {
    return (
      <div role="status" className="space-y-4">
        <p className="text-sm text-navy">
          Your password has been updated. You can now sign in with your new password.
        </p>
        <a
          href="/login"
          className="block w-full rounded-md bg-orange px-4 py-2 text-center text-sm font-medium text-white shadow-sm hover:bg-orange-deep"
        >
          Continue to sign in
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PasswordInput
        label="New password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        showStrength
        showLengthHint
      />
      <PasswordInput
        label="Confirm password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {error && (
        <div
          role="alert"
          className="rounded-md border border-severity-critical/30 bg-severity-bg-critical px-3 py-2 text-sm text-severity-critical"
        >
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-orange-deep disabled:opacity-60"
      >
        {submitting ? 'Updating…' : 'Update password'}
      </button>
    </form>
  );
}
