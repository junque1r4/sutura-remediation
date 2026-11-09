import * as crypto from 'crypto';
import { encryptJson, decryptJson } from './crypto';
import { getIntegrationEncryptionSecret } from './encryption-config';

function getEncryptionSecret(): string {
  // The 'anthropic:' prefix is preserved so previously issued cookies remain
  // decryptable; only the base secret source changed to the central resolver.
  const base = getIntegrationEncryptionSecret();
  return crypto.createHash('sha256').update(`anthropic:${base}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnthropicCookieData {
  apiKey: string;
  connectedAt: string;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'anthropic_connection';

export async function getAnthropicKeyFromCookies(): Promise<string | null> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);

  if (!cookie) return null;

  const data = decryptJson<AnthropicCookieData>(cookie.value, getEncryptionSecret());
  return data?.apiKey ?? null;
}

export async function getAnthropicConnectionFromCookies(): Promise<AnthropicCookieData | null> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);

  if (!cookie) return null;

  return decryptJson<AnthropicCookieData>(cookie.value, getEncryptionSecret());
}

export async function setAnthropicConnectionCookie(apiKey: string): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();

  const data: AnthropicCookieData = {
    apiKey,
    connectedAt: new Date().toISOString(),
  };

  const encrypted = encryptJson(data, getEncryptionSecret());

  cookieStore.set(COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });
}

export async function clearAnthropicConnectionCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

// ---------------------------------------------------------------------------
// Validate key
// ---------------------------------------------------------------------------

export async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // Any 2xx or 4xx with "invalid_request_error" (not auth error) means key is valid
    if (res.ok) return true;
    const data = await res.json().catch(() => ({}));
    // 401 = bad key, anything else (400, 429) = key works
    return res.status !== 401 && data?.error?.type !== 'authentication_error';
  } catch {
    return false;
  }
}
