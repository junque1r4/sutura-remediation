import { NextResponse } from 'next/server';

import { clearInstallationFromOrg } from '@/lib/github';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

export async function POST() {
  try {
    await requirePermission('integrations:disconnect');
    await clearInstallationFromOrg();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
