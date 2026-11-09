import 'server-only';
import { getCurrentMembership } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

/**
 * Server-side backend client. Signs the HS256 token directly from the current
 * session (real org_id / role / actor) and calls the backend over the internal
 * network. Kept separate from the browser `backend-client` so the `server-only`
 * auth modules never enter the client layer (importing them from a module that
 * client components also import breaks the production build).
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

async function serverBackendFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const membership = await getCurrentMembership();
  if (!membership) {
    throw new Error('Cannot call backend without an authenticated session');
  }
  const token = signBackendToken({
    sub: membership.userId,
    email: membership.email,
    org_id: membership.orgId,
    role: membership.role,
  });

  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchOrganization(): Promise<{
  id: string;
  name: string;
  plan: string;
  settings: Record<string, unknown>;
  customPrompts: Record<string, string>;
}> {
  return serverBackendFetch('/api/org');
}

export async function updateOrgSettings(settings: Record<string, unknown>): Promise<void> {
  await serverBackendFetch<unknown>('/api/org/settings', {
    method: 'PATCH',
    body: JSON.stringify({ settings }),
  });
}
