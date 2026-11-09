import { NextResponse } from 'next/server';

import { clearAikidoConnectionCookie } from '@/lib/aikido';
import { deleteConnection } from '@/lib/connections-client.server';
import { requirePermission, jsonError } from '@/lib/auth/server';

export async function POST() {
  try {
    await requirePermission('integrations:disconnect');
    await deleteConnection('aikido');
    // Defensively clear any legacy cookie that predates the DB migration.
    await clearAikidoConnectionCookie();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = jsonError(err);
    return NextResponse.json(body, { status: status === 500 ? 500 : status });
  }
}
