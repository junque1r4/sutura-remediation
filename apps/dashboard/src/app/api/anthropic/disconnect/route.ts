import { NextResponse } from 'next/server';
import { clearAnthropicConnectionCookie } from '@/lib/anthropic';
import { deleteConnection } from '@/lib/connections-client.server';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

export async function POST() {
  try {
    await requirePermission('integrations:disconnect');
    await deleteConnection('anthropic');
    // Defensively clear any legacy cookie that predates the DB migration.
    await clearAnthropicConnectionCookie();
    return NextResponse.json({ disconnected: true });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
