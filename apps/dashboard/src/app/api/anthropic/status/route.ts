import { NextResponse } from 'next/server';
import {
  getAnthropicConnectionFromCookies,
  clearAnthropicConnectionCookie,
} from '@/lib/anthropic';
import { getConnectionStatus, putConnection } from '@/lib/connections-client.server';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

function maskAnthropicKey(apiKey: string): string {
  return `${apiKey.slice(0, 11)}...${apiKey.slice(-4)}`;
}

export async function GET() {
  try {
    await requirePermission('integrations:read');

    // (1) Authoritative: DB-backed connection.
    const status = await getConnectionStatus('anthropic');
    if (status) {
      return NextResponse.json({
        connected: true,
        connectedAt: status.connectedAt,
      });
    }

    // (2) Legacy fallback: migrate an existing encrypted cookie into the DB
    // once, then clear it. Guarded so a backend hiccup never breaks status.
    try {
      const cookie = await getAnthropicConnectionFromCookies();
      if (cookie?.apiKey) {
        const migrated = await putConnection('anthropic', {
          secret: cookie.apiKey,
          maskedIdentifier: maskAnthropicKey(cookie.apiKey),
          metadata: {},
        });
        await clearAnthropicConnectionCookie();
        return NextResponse.json({
          connected: true,
          connectedAt: migrated.connectedAt,
        });
      }
    } catch {
      // Migration failed -- fall through to not-connected.
    }

    // (3) Neither.
    return NextResponse.json({ connected: false });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ connected: false }, { status: 500 });
  }
}
