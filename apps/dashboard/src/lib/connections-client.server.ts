import 'server-only';
import { getCurrentMembership } from '@/lib/auth/server';
import { signBackendToken } from '@/lib/auth/backend-token';

/**
 * Server-only client for the backend org-scoped integration connections API
 * (migration 015 / packages/backend/src/routes/connections.ts).
 *
 * Centralizes the dashboard->backend hop so individual {provider}/connect,
 * status and disconnect routes (and the consumer routes) never re-sign tokens
 * or hold the cipher key. The provider SECRET is encrypted at rest in the
 * backend; this client only ever ships plaintext on PUT (once, over the
 * internal network) and reads it back via the /internal secret endpoint when a
 * consumer still calls the vendor dashboard-side. The browser never sees it.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

export type IntegrationProvider = 'anthropic' | 'snyk' | 'aikido';

export interface ConnectionStatus {
  provider: IntegrationProvider;
  connected: true;
  maskedIdentifier: string | null;
  connectedAt: string;
  metadata: Record<string, unknown>;
}

export interface ConnectionSecret {
  provider: IntegrationProvider;
  secret: string;
  metadata: Record<string, unknown>;
}

interface TokenInput {
  userId: string;
  email: string;
  orgId: string;
  role: string;
}

/**
 * Resolves a signed backend token from the current membership. Most routes go
 * through this (requirePermission already established a real membership).
 */
async function tokenFromMembership(): Promise<string> {
  const membership = await getCurrentMembership();
  if (!membership) {
    throw new Error('Cannot call backend without an authenticated session');
  }
  return signBackendToken({
    sub: membership.userId,
    email: membership.email,
    org_id: membership.orgId,
    role: membership.role,
  });
}

function signFromInput(input: TokenInput): string {
  return signBackendToken({
    sub: input.userId,
    email: input.email,
    org_id: input.orgId,
    role: input.role,
  });
}

async function connectionsFetch(
  path: string,
  options: RequestInit,
  token: string,
): Promise<Response> {
  return fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
}

/** GET /api/connections/:provider -> status or null when not connected. */
export async function getConnectionStatus(
  provider: IntegrationProvider,
): Promise<ConnectionStatus | null> {
  const token = await tokenFromMembership();
  const res = await connectionsFetch(`/api/connections/${provider}`, { method: 'GET' }, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  return res.json() as Promise<ConnectionStatus>;
}

/** GET /api/connections -> all configured connections for the org. */
export async function listConnectionStatuses(): Promise<ConnectionStatus[]> {
  const token = await tokenFromMembership();
  const res = await connectionsFetch('/api/connections', { method: 'GET' }, token);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  const data = (await res.json()) as { connections?: ConnectionStatus[] };
  return data.connections ?? [];
}

/** PUT /api/connections/:provider -> upsert. Plaintext secret travels once. */
export async function putConnection(
  provider: IntegrationProvider,
  input: { secret: string; maskedIdentifier?: string; metadata?: Record<string, unknown> },
  token?: string,
): Promise<ConnectionStatus> {
  const t = token ?? (await tokenFromMembership());
  const res = await connectionsFetch(
    `/api/connections/${provider}`,
    { method: 'PUT', body: JSON.stringify(input) },
    t,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  return res.json() as Promise<ConnectionStatus>;
}

/** DELETE /api/connections/:provider -> idempotent removal. */
export async function deleteConnection(provider: IntegrationProvider): Promise<void> {
  const token = await tokenFromMembership();
  const res = await connectionsFetch(`/api/connections/${provider}`, { method: 'DELETE' }, token);
  // 204 expected; tolerate 200. Anything else is an error.
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
}

/**
 * GET /internal/connections/:provider/secret -> decrypted secret for
 * consumer routes that still call the vendor dashboard-side. Returns null when
 * not connected. Server-side only; never reachable from the browser.
 */
export async function getConnectionSecret(
  provider: IntegrationProvider,
): Promise<ConnectionSecret | null> {
  const token = await tokenFromMembership();
  const res = await connectionsFetch(
    `/internal/connections/${provider}/secret`,
    { method: 'GET' },
    token,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  return res.json() as Promise<ConnectionSecret>;
}

// ---------------------------------------------------------------------------
// Session/activeOrgId variants (for routes like sbom/sync that use
// getCurrentSession()+activeOrgId instead of getCurrentMembership()).
// ---------------------------------------------------------------------------

/** Decrypted secret using an explicitly supplied token signer input. */
export async function getConnectionSecretWithToken(
  provider: IntegrationProvider,
  input: TokenInput,
): Promise<ConnectionSecret | null> {
  const token = signFromInput(input);
  const res = await connectionsFetch(
    `/internal/connections/${provider}/secret`,
    { method: 'GET' },
    token,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  return res.json() as Promise<ConnectionSecret>;
}
