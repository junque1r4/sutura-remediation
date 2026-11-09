import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionCookieName, validateSessionToken, type ActiveSession } from './session';
import { hasPermission, type Permission, type Role } from './permissions';

export class UnauthorizedError extends Error {
  status = 401 as const;
  constructor(message = 'Unauthorized') {
    super(message);
  }
}

export class ForbiddenError extends Error {
  status = 403 as const;
  constructor(message = 'Forbidden') {
    super(message);
  }
}

export async function getCurrentSession(): Promise<ActiveSession | null> {
  // Middleware short-circuits unauthenticated traffic on protected paths, so
  // most code paths receive a populated session. For RSC and route handlers
  // we still read the cookie directly to keep this function usable from any
  // server context.
  const c = await cookies();
  const token = c.get(getSessionCookieName())?.value;
  if (!token) return null;
  return validateSessionToken(token);
}

export async function getCurrentUser(): Promise<ActiveSession['user'] | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}

export async function getCurrentMembership(): Promise<{
  userId: string;
  email: string;
  orgId: string;
  role: Role;
  orgName: string;
} | null> {
  const session = await getCurrentSession();
  if (!session || !session.membership) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    orgId: session.membership.orgId,
    role: session.membership.role,
    orgName: session.membership.orgName,
  };
}

export async function requireSession(): Promise<ActiveSession> {
  const session = await getCurrentSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

export async function requireMembership(): Promise<{
  userId: string;
  email: string;
  orgId: string;
  role: Role;
  orgName: string;
}> {
  const m = await getCurrentMembership();
  if (!m) throw new ForbiddenError('No active organization');
  return m;
}

export async function requirePermission(perm: Permission): Promise<{
  userId: string;
  email: string;
  orgId: string;
  role: Role;
}> {
  const m = await requireMembership();
  if (!hasPermission(m.role, perm)) {
    throw new ForbiddenError(`Missing permission: ${perm}`);
  }
  return m;
}

/**
 * For server components: redirect to /login if no session, returning the
 * resolved membership otherwise. Use in protected pages.
 */
export async function requireAuthOrRedirect(): Promise<{
  userId: string;
  email: string;
  orgId: string;
  role: Role;
  orgName: string;
}> {
  const session = await getCurrentSession();
  if (!session) {
    const h = await headers();
    const next = h.get('x-pathname') ?? '/';
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  if (!session.membership) {
    throw new ForbiddenError('No active organization');
  }
  return {
    userId: session.user.id,
    email: session.user.email,
    orgId: session.membership.orgId,
    role: session.membership.role,
    orgName: session.membership.orgName,
  };
}

export function jsonError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof UnauthorizedError) return { status: 401, body: { error: err.message } };
  if (err instanceof ForbiddenError) return { status: 403, body: { error: err.message } };
  const message = err instanceof Error ? err.message : 'Internal error';
  return { status: 500, body: { error: message } };
}

import { NextResponse, type NextRequest } from 'next/server';

// Default context shape for App Router route handlers without dynamic params.
// Concrete routes can narrow `C` to their own `{ params: Promise<...> }` type.
type RouteCtx = { params: Promise<Record<string, string | string[]>> };

/**
 * Wrap a route handler so it requires `perm` before running. Auto-converts
 * Unauthorized/Forbidden into 401/403 JSON responses. The returned function
 * matches Next's App Router handler signature (NextRequest + params context).
 */
export function withPermission<C extends RouteCtx = RouteCtx>(
  perm: Permission,
  handler: (
    auth: { userId: string; email: string; orgId: string; role: Role },
    req: NextRequest,
    ctx: C,
  ) => Promise<Response> | Response,
): (req: NextRequest, ctx: C) => Promise<Response> {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      const auth = await requirePermission(perm);
      return await handler(auth, req, ctx);
    } catch (err) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
  };
}

/**
 * Like `withPermission` but only requires an authenticated session (no
 * specific permission). Useful for endpoints like /api/auth/me.
 */
export function withSession<C extends RouteCtx = RouteCtx>(
  handler: (
    session: { userId: string; email: string },
    req: NextRequest,
    ctx: C,
  ) => Promise<Response> | Response,
): (req: NextRequest, ctx: C) => Promise<Response> {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      const s = await requireSession();
      return await handler({ userId: s.user.id, email: s.user.email }, req, ctx);
    } catch (err) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
  };
}
