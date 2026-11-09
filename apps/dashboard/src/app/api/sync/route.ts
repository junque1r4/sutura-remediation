import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * On-demand "Sync now": proxies to the backend scanner-sync route, which pulls
 * issues from the connected scanners and upserts them into the findings table.
 * Org identity travels in the signed token; no client input reaches the backend.
 */
export const POST = withPermission('findings:write', async (auth) => {
  const backendUrl =
    process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
  const token = signBackendToken({
    sub: auth.userId,
    email: auth.email,
    org_id: auth.orgId,
    role: auth.role,
  });

  const res = await fetch(`${backendUrl}/api/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
});
