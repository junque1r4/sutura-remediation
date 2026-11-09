import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Proxy the latest persisted AI analysis for a finding from the backend. The
// detail page calls this on load so the analysis survives reloads/new tabs/
// re-login (it is DB-backed, no longer sessionStorage).
export const GET = withPermission<{ params: Promise<{ id: string }> }>(
  'findings:read',
  async (auth, _req, ctx) => {
    const backendUrl =
      process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
    const token = signBackendToken({
      sub: auth.userId,
      email: auth.email,
      org_id: auth.orgId,
      role: auth.role,
    });

    const { id } = await ctx.params;
    const res = await fetch(
      `${backendUrl}/api/findings/${encodeURIComponent(id)}/analysis`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );

    if (!res.ok) {
      const body = await res.text();
      return new NextResponse(body, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
      });
    }

    const data = await res.json();
    return NextResponse.json(data);
  },
);
