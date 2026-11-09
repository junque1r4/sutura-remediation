'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PasswordInput } from '@/components/password-input';
import { validatePasswordPair } from '@/lib/auth/validate';

interface InvitePreview {
  email: string;
  role: string;
  orgName: string;
  inviterEmail: string;
  expiresAt: string;
}

export function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError('Missing token');
      return;
    }
    void (async () => {
      const res = await fetch(`/api/invitations/${encodeURIComponent(token)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setLoadError(body.error ?? 'Invalid invitation');
        return;
      }
      setPreview((await res.json()) as InvitePreview);
    })();
  }, [token]);

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
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to accept invitation');
        return;
      }
      router.replace('/');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-severity-critical">{loadError}</p>
        <a href="/login" className="block text-center text-gray-text hover:text-navy">
          Go to sign in
        </a>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-4 w-3/4 animate-pulse rounded bg-cream-warm" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-cream-warm" />
        <div className="h-10 w-full animate-pulse rounded bg-cream-warm" />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="rounded-md border border-border bg-cream-warm px-4 py-3 text-sm">
        <p className="text-navy">
          <span className="font-medium">{preview.inviterEmail}</span> invited you to join{' '}
          <span className="font-medium">{preview.orgName}</span> as{' '}
          <span className="font-medium">{preview.role}</span>.
        </p>
        <p className="mt-1 text-xs text-gray-text">
          Joining as <span className="font-medium">{preview.email}</span>
        </p>
      </div>
      <PasswordInput
        label="Choose a password"
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
        {submitting ? 'Joining…' : 'Accept and sign in'}
      </button>
    </form>
  );
}
