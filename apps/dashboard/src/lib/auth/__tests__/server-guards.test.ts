import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks. server.ts pulls in `server-only` and the session/cookie machinery;
// stub those so the guard logic can run in a plain node test environment.
// ---------------------------------------------------------------------------

vi.mock('server-only', () => ({}));

// In-memory session control. `getCurrentSession` reads the cookie then calls
// validateSessionToken; we drive the whole thing through this single value.
let activeSession: unknown = null;

vi.mock('../session', () => ({
  getSessionCookieName: () => 'sutura_session',
  validateSessionToken: vi.fn(async () => activeSession),
}));

const cookieStore = {
  get(name: string): { name: string; value: string } | undefined {
    // Only return a token when a session is configured, so the absent-cookie
    // path is exercised when activeSession is null.
    return activeSession ? { name, value: 'token' } : undefined;
  },
};

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve(new Map()),
}));

import { withPermission, requirePermission, ForbiddenError } from '../server';

function makeSession(role: string) {
  return {
    user: { id: 'user-1', email: 'alice@example.com' },
    membership: { orgId: 'org-1', role, orgName: 'Acme' },
  };
}

const handler = vi.fn(async (..._args: unknown[]) => Response.json({ ok: true }));

beforeEach(() => {
  activeSession = null;
  handler.mockClear();
});

describe('withPermission guard', () => {
  it('returns 403 when there is no session/membership and never runs the handler', async () => {
    const route = withPermission('findings:read', handler);
    const res = await route(new NextRequest('http://localhost/api/analytics/overview'), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 when the role lacks the required permission', async () => {
    // viewer has findings:read but not fixes:approve.
    activeSession = makeSession('viewer');
    const route = withPermission('fixes:approve', handler);
    const res = await route(new NextRequest('http://localhost/x'), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler and forwards auth when the permission is granted', async () => {
    activeSession = makeSession('owner');
    const route = withPermission('findings:read', handler);
    const res = await route(new NextRequest('http://localhost/x'), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    const [auth] = handler.mock.calls[0];
    expect(auth).toMatchObject({
      userId: 'user-1',
      email: 'alice@example.com',
      orgId: 'org-1',
      role: 'owner',
    });
  });
});

describe('requirePermission', () => {
  it('throws ForbiddenError with no active session', async () => {
    await expect(requirePermission('findings:read')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
