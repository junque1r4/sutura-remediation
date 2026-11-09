import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withPermission('findings:read', async (auth, req) => {
  const backendUrl =
    process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
  const token = signBackendToken({
    sub: auth.userId,
    email: auth.email,
    org_id: auth.orgId,
    role: auth.role,
  });

  // Single-tenant: org identity travels in the signed token, never the query
  // string. Strip any client-supplied orgId so it can never reach the backend.
  const url = new URL(req.url);
  url.searchParams.delete('orgId');
  const search = url.search;
  const res = await fetch(`${backendUrl}/api/analytics/overview${search}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
});
