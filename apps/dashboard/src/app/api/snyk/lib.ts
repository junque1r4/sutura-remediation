import * as crypto from 'crypto';
import { encryptJson, decryptJson } from '../../../lib/crypto';
import { getIntegrationEncryptionSecret } from '../../../lib/encryption-config';

function getEncryptionSecret(): string {
  // The 'snyk:' prefix is preserved so previously issued cookies remain
  // decryptable; only the base secret source changed to the central resolver.
  const base = getIntegrationEncryptionSecret();
  return crypto.createHash('sha256').update(`snyk:${base}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnykCookieData {
  apiToken: string;
  orgId: string;
  orgName: string;
  connectedAt: string;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'snyk_connection';

export async function getSnykConnectionFromCookies(): Promise<SnykCookieData | null> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);

  if (!cookie) {
    return null;
  }

  return decryptJson<SnykCookieData>(cookie.value, getEncryptionSecret());
}

/**
 * @deprecated Legacy. Connections now persist in the backend
 * integration_connections table via connections-client.server.ts. Kept only for
 * the one-time migrate-on-read path and existing unit tests; no longer written
 * by the connect route.
 */
export async function setSnykConnectionCookie(data: SnykCookieData): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const encrypted = encryptJson(data, getEncryptionSecret());

  cookieStore.set(COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });
}

export async function clearSnykConnectionCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
