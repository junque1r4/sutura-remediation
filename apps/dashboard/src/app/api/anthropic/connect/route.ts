import { type NextRequest, NextResponse } from 'next/server';
import { validateAnthropicKey } from '@/lib/anthropic';
import { putConnection } from '@/lib/connections-client.server';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

function maskAnthropicKey(apiKey: string): string {
  return `${apiKey.slice(0, 11)}...${apiKey.slice(-4)}`;
}

export async function POST(request: NextRequest) {
  try {
    await requirePermission('integrations:write');
    const { apiKey } = (await request.json()) as { apiKey: string };

    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return NextResponse.json(
        { error: 'A valid Anthropic API key is required (starts with sk-ant-)' },
        { status: 400 },
      );
    }

    const valid = await validateAnthropicKey(apiKey);
    if (!valid) {
      return NextResponse.json(
        { error: 'Invalid API key -- authentication failed' },
        { status: 401 },
      );
    }

    const status = await putConnection('anthropic', {
      secret: apiKey,
      maskedIdentifier: maskAnthropicKey(apiKey),
      metadata: {},
    });

    return NextResponse.json({
      connected: true,
      connectedAt: status.connectedAt,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to connect';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
