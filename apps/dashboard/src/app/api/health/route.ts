import { NextResponse } from 'next/server';

/**
 * Redirect-free liveness probe. Whitelisted as public in `middleware.ts`, so it
 * answers 200 without a session and without the `/` -> `/login` redirect hop --
 * a stable target for container/orchestrator healthchecks. Kept deliberately
 * trivial: it asserts the Next.js server is up, nothing more.
 */
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' });
}
