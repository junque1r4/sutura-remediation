import { type NextRequest, NextResponse } from 'next/server';
import { getCurrentMembership } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

/**
 * Same-origin proxy to the backend API. The browser never holds JWT_SECRET:
 * it calls this route, which resolves the authenticated session, mints a
 * short-lived HS256 token carrying the REAL org_id / role / actor, and
 * forwards the request to the backend. The backend verifies the signature
 * against the shared JWT_SECRET.
 *
 * Requests without a valid session/membership are rejected with 401 before
 * any backend call is made.
 */
async function proxy(req: NextRequest): Promise<Response> {
  const membership = await getCurrentMembership();
  if (!membership) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = signBackendToken({
    sub: membership.userId,
    email: membership.email,
    org_id: membership.orgId,
    role: membership.role,
  });

  // Reconstruct the backend path from the raw request pathname so already-
  // encoded segments (e.g. finding ids) are forwarded verbatim without being
  // double-encoded. Everything after the `/api/backend` prefix maps to
  // `/api/...` on the backend.
  const suffix = req.nextUrl.pathname.replace(/^\/api\/backend/, '');
  // Single-tenant: org identity travels in the signed token, never the query
  // string. Strip any client-supplied orgId so it can never reach the backend.
  const params = new URLSearchParams(req.nextUrl.search);
  params.delete('orgId');
  const search = params.toString();
  const target = `${BACKEND_URL}/api${suffix}${search ? `?${search}` : ''}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const contentType = req.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const res = await fetch(target, {
    method,
    headers,
    body: hasBody ? await req.text() : undefined,
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  return proxy(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return proxy(req);
}

export async function PATCH(req: NextRequest): Promise<Response> {
  return proxy(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return proxy(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return proxy(req);
}
