import { type NextRequest, NextResponse } from 'next/server';

import type { AikidoConnection } from '@/types';
import { authenticateAikido, validateAikidoConnection } from '@/lib/aikido';
import { putConnection } from '@/lib/connections-client.server';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

export async function POST(request: NextRequest) {
  try {
    await requirePermission('integrations:write');
    const body = (await request.json()) as { clientId: string; clientSecret: string };
    const { clientId, clientSecret } = body;

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: 'Client ID and Client Secret are required' },
        { status: 400 },
      );
    }

    const { accessToken } = await authenticateAikido(clientId, clientSecret);

    const valid = await validateAikidoConnection(accessToken);
    if (!valid) {
      return NextResponse.json({ error: 'Unable to validate Aikido connection' }, { status: 401 });
    }

    const status = await putConnection('aikido', {
      secret: `${clientId}:${clientSecret}`,
      maskedIdentifier: clientId,
      metadata: { clientId },
    });

    const connection: AikidoConnection = { clientId, connectedAt: status.connectedAt };
    return NextResponse.json({ connected: true, connection });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Invalid credentials or unable to connect';
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
