import { type NextRequest, NextResponse } from 'next/server';
import { getConnectionSecret } from '@/lib/connections-client.server';
import {
  requirePermission,
  getCurrentMembership,
  jsonError,
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

interface RequestBody {
  targetBranch?: string;
  reviewers?: string[];
  maxAttempts?: number;
  priorAnalysis?: string;
}

/**
 * Same-origin proxy: reads the Aikido `client_id:client_secret` from the
 * encrypted dashboard cookie and forwards the validated-fix trigger to the
 * backend with the credential in the body. The backend never sees the cookie
 * directly; the dashboard is the only place credentials are decrypted.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requirePermission('fixes:write');
    const membership = await getCurrentMembership();
    if (!membership) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await context.params;
    const body = ((await request.json().catch(() => ({}))) as RequestBody) ?? {};

    let aikidoApiKey: string | undefined;
    try {
      // Already stored as the combined `clientId:clientSecret` secret.
      aikidoApiKey = (await getConnectionSecret('aikido'))?.secret ?? undefined;
    } catch {
      // If the secret can't be read, proceed without it; the worker will fall
      // back to OSS scanners.
    }

    let anthropicApiKey: string | undefined;
    try {
      anthropicApiKey = (await getConnectionSecret('anthropic'))?.secret ?? undefined;
    } catch {
      // proceed without it; the worker will fall back to env.
    }

    const token = signBackendToken({
      sub: membership.userId,
      email: membership.email,
      org_id: membership.orgId,
      role: membership.role,
    });

    const res = await fetch(
      `${BACKEND_URL}/api/findings/${encodeURIComponent(id)}/validated-fix`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...body, aikidoApiKey, anthropicApiKey }),
      },
    );

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to trigger validated fix';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
