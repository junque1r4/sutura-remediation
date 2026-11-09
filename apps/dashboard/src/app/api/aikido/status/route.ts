import { NextResponse } from 'next/server';

import type { AikidoConnection } from '@/types';
import { getAikidoConnectionFromCookies, clearAikidoConnectionCookie } from '@/lib/aikido';
import { getConnectionStatus, putConnection } from '@/lib/connections-client.server';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

export async function GET() {
  try {
    await requirePermission('integrations:read');
    if (process.env.AIKIDO_DEV_MODE === 'true') {
      const mockConnection: AikidoConnection = {
        clientId: 'aikido-dev-client',
        connectedAt: new Date().toISOString(),
      };
      return NextResponse.json({ connected: true, connection: mockConnection });
    }

    // (1) Authoritative: DB-backed connection.
    const status = await getConnectionStatus('aikido');
    if (status) {
      const clientId =
        typeof status.metadata.clientId === 'string' ? status.metadata.clientId : '';
      const connection: AikidoConnection = { clientId, connectedAt: status.connectedAt };
      return NextResponse.json({ connected: true, connection });
    }

    // (2) Legacy fallback: migrate an existing encrypted cookie into the DB
    // once, then clear it. Guarded so a backend hiccup never breaks status.
    try {
      const cookie = await getAikidoConnectionFromCookies();
      if (cookie?.clientId && cookie?.clientSecret) {
        const migrated = await putConnection('aikido', {
          secret: `${cookie.clientId}:${cookie.clientSecret}`,
          maskedIdentifier: cookie.clientId,
          metadata: { clientId: cookie.clientId },
        });
        await clearAikidoConnectionCookie();
        const connection: AikidoConnection = {
          clientId: cookie.clientId,
          connectedAt: migrated.connectedAt,
        };
        return NextResponse.json({ connected: true, connection });
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
