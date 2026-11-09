'use client';

import { useState, type FormEvent } from 'react';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch('/api/auth/password/reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="space-y-4 text-sm text-navy">
        <p>
          If an account exists for that email, we&apos;ve sent a reset link. Check your
          inbox.
        </p>
        <a href="/login" className="block text-center text-gray-text hover:text-navy">
          Back to sign in
        </a>
      </div>
    );
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
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-orange-deep disabled:opacity-60"
      >
        {submitting ? 'Sending…' : 'Send reset link'}
      </button>
      <div className="text-center text-sm">
        <a href="/login" className="text-gray-text hover:text-navy">
          Back to sign in
        </a>
      </div>
    </form>
  );
}
