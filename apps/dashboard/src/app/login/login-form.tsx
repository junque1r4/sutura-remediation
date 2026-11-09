'use client';

import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { PasswordInput } from '@/components/password-input';
import { safeNextPath } from './safe-next';

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Sign-in failed');
        return;
      }
      // Full navigation, not router.replace: client providers in the root
      // layout (e.g. FindingsProvider) fetch once on mount, and a mount that
      // happened unauthenticated has already cached a 401-empty result. A
      // full load remounts them with the session cookie present. Deep links
      // like /findings/<id> render "Not Found" after login without this.
      window.location.assign(safeNextPath(next));
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-navy">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-navy shadow-sm focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/30"
        />
      </div>
      <PasswordInput
        label="Password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
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
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
      <div className="pt-2 text-center text-sm">
        <a href="/forgot-password" className="text-gray-text hover:text-navy">
          Forgot your password?
        </a>
      </div>
    </form>
  );
}
