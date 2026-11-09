'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PasswordInput } from '@/components/password-input';
import { validatePasswordPair } from '@/lib/auth/validate';

interface SessionRow {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  current: boolean;
}

export function SecurityClient() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await fetch('/api/auth/sessions', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionRow[] };
        setSessions(data.sessions);
      }
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onChangePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const validationError = validatePasswordPair(next, confirm);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/password/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Update failed');
        return;
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      setSuccess('Password updated. Other sessions were revoked.');
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function onRevoke(id: string) {
    const res = await fetch(`/api/auth/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Revoke failed');
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-border bg-white p-6">
        <h2 className="text-lg font-medium text-navy">Change password</h2>
        <form onSubmit={onChangePassword} className="mt-4 grid max-w-md gap-3">
          <PasswordInput
            label="Current password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <PasswordInput
            label="New password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
            showStrength
            showLengthHint
          />
          <PasswordInput
            label="Confirm new password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <p className="text-xs text-gray-text">
            Submitting will sign you out of all other sessions.
          </p>
          {error && (
            <div
              role="alert"
              className="rounded-md border border-severity-critical/30 bg-severity-bg-critical px-3 py-2 text-sm text-severity-critical"
            >
              {error}
            </div>
          )}
          {success && (
            <div
              role="status"
              className="rounded-md border border-status-success/30 bg-status-success/10 px-3 py-2 text-sm text-status-success"
            >
              {success}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="justify-self-start rounded-md bg-orange px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-orange-deep disabled:opacity-60"
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-white">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-lg font-medium text-navy">Active sessions</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-cream-warm text-left text-xs uppercase tracking-wide text-gray-text">
            <tr>
              <th className="px-6 py-3">Device</th>
              <th className="px-6 py-3">IP</th>
              <th className="px-6 py-3">Last active</th>
              <th className="px-6 py-3">Expires</th>
              <th className="px-6 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-light">
            {loadingSessions ? (
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={`skel-${i}`}>
                  <td className="px-6 py-3">
                    <div className="h-3 w-48 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-24 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-32 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3">
                    <div className="h-3 w-20 animate-pulse rounded bg-cream-warm" />
                  </td>
                  <td className="px-6 py-3" />
                </tr>
              ))
            ) : (
              sessions.map((s) => (
                <tr key={s.id}>
                  <td className="px-6 py-3 text-navy">
                    <span className="block max-w-xs truncate" title={s.userAgent ?? undefined}>
                      {s.userAgent ?? '—'}
                    </span>
                    {s.current && (
                      <span className="mt-0.5 inline-block rounded-full bg-status-success/15 px-2 py-0.5 text-xs font-medium text-status-success">
                        This device
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-gray-text">{s.ip ?? '—'}</td>
                  <td className="px-6 py-3 text-gray-text">
                    {new Date(s.lastActiveAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-gray-text">
                    {new Date(s.expiresAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {!s.current && (
                      <button
                        onClick={() => onRevoke(s.id)}
                        className="text-sm text-severity-critical hover:underline"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
