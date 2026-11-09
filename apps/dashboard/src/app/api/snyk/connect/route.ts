import { type NextRequest, NextResponse } from 'next/server';

import type { SnykConnection } from '@/types';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';
import { putConnection } from '@/lib/connections-client.server';

const SNYK_API_BASE = 'https://api.snyk.io';

export async function POST(request: NextRequest) {
  try {
    await requirePermission('integrations:write');
    const body = (await request.json()) as {
      apiToken?: string;
      orgId?: string;
      orgName?: string;
    };
    const { apiToken, orgId, orgName } = body;

    if (!apiToken || !orgId || !orgName) {
      return NextResponse.json(
        { error: 'apiToken, orgId, and orgName are required' },
        { status: 400 },
      );
    }

    // Validate the token by calling the Snyk API
    const validateRes = await fetch(
      `${SNYK_API_BASE}/rest/self?version=2024-10-15`,
      {
        headers: {
          Authorization: `token ${apiToken}`,
          Accept: 'application/vnd.api+json',
        },
      },
    );

    if (!validateRes.ok) {
      return NextResponse.json(
        { error: 'Invalid Snyk API token' },
        { status: 401 },
      );
    }

    const region = 'us';
    await putConnection('snyk', {
      secret: apiToken,
      maskedIdentifier: orgName,
      metadata: { orgId, orgName, region },
    });

    const connection: SnykConnection = { orgId, orgName, region };
    return NextResponse.json({ connected: true, connection });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to connect to Snyk';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
