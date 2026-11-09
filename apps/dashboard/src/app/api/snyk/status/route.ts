import { NextResponse } from 'next/server';

import type { SnykConnection } from '@/types';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';
import { getConnectionStatus, putConnection } from '@/lib/connections-client.server';
import { getSnykConnectionFromCookies, clearSnykConnectionCookie } from '../lib';

function connectionFromMetadata(metadata: Record<string, unknown>): SnykConnection {
  return {
    orgId: typeof metadata.orgId === 'string' ? metadata.orgId : '',
    orgName: typeof metadata.orgName === 'string' ? metadata.orgName : '',
    region: typeof metadata.region === 'string' ? metadata.region : 'us',
  };
}

export async function GET() {
  try {
    await requirePermission('integrations:read');

    // (1) Authoritative: DB-backed connection.
    const status = await getConnectionStatus('snyk');
    if (status) {
      return NextResponse.json({
        connected: true,
        connection: connectionFromMetadata(status.metadata),
      });
    }

    // (2) Legacy fallback: migrate an existing encrypted cookie into the DB
    // once, then clear it. Guarded so a backend hiccup never breaks status.
    try {
      const cookie = await getSnykConnectionFromCookies();
      if (cookie?.apiToken) {
        await putConnection('snyk', {
          secret: cookie.apiToken,
          maskedIdentifier: cookie.orgName,
          metadata: { orgId: cookie.orgId, orgName: cookie.orgName, region: 'us' },
        });
        await clearSnykConnectionCookie();
        const connection: SnykConnection = {
          orgId: cookie.orgId,
          orgName: cookie.orgName,
          region: 'us',
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
