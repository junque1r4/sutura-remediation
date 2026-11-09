import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory cookie store mock for next/headers cookies()
// ---------------------------------------------------------------------------

interface StoredCookie {
  name: string;
  value: string;
}

const store = new Map<string, StoredCookie>();

const cookieStore = {
  get(name: string): StoredCookie | undefined {
    return store.get(name);
  },
  set(name: string, value: string): void {
    store.set(name, { name, value });
  },
  delete(name: string): void {
    store.delete(name);
  },
};

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

// A strong secret so the central resolver is happy in any environment.
process.env.INTEGRATION_ENCRYPTION_KEY = 'test-integration-encryption-key-0123456789abcdef';

import {
  setSnykConnectionCookie,
  getSnykConnectionFromCookies,
  clearSnykConnectionCookie,
  type SnykCookieData,
} from '../lib';

const COOKIE_NAME = 'snyk_connection';

const sample: SnykCookieData = {
  apiToken: 'super-secret-snyk-token-abc123',
  orgId: 'org-1234',
  orgName: 'Acme Security',
  connectedAt: '2026-06-05T00:00:00.000Z',
};

describe('snyk connection cookie helpers', () => {
  beforeEach(() => {
    store.clear();
  });

  it('writes an encrypted value that is not readable plaintext JSON', async () => {
    await setSnykConnectionCookie(sample);

    const raw = store.get(COOKIE_NAME)?.value ?? '';
    expect(raw).not.toBe('');

    // The raw cookie must not contain the token or other plaintext fields.
    expect(raw).not.toContain(sample.apiToken);
    expect(raw).not.toContain(sample.orgName);

    // It must not be parseable as the plaintext JSON payload.
    let parsedAsJson = false;
    try {
      const obj = JSON.parse(raw) as Partial<SnykCookieData>;
      parsedAsJson = obj.apiToken === sample.apiToken;
    } catch {
      parsedAsJson = false;
    }
    expect(parsedAsJson).toBe(false);

    // Format should be the AES-GCM "iv:ct:authTag" hex triple.
    expect(raw.split(':')).toHaveLength(3);
  });

  it('round-trips the data back via get', async () => {
    await setSnykConnectionCookie(sample);
    const result = await getSnykConnectionFromCookies();
    expect(result).toEqual(sample);
  });

  it('returns null when the cookie is absent', async () => {
    const result = await getSnykConnectionFromCookies();
    expect(result).toBeNull();
  });

  it('returns null for a malformed cookie without crashing', async () => {
    store.set(COOKIE_NAME, { name: COOKIE_NAME, value: 'not-a-valid-encrypted-cookie' });
    const result = await getSnykConnectionFromCookies();
    expect(result).toBeNull();
  });

  it('returns null for a tampered (auth-tag-failing) cookie', async () => {
    await setSnykConnectionCookie(sample);
    const raw = store.get(COOKIE_NAME)!.value;
    const [iv, ct, tag] = raw.split(':');
    // Flip a hex char in the ciphertext to break the auth tag.
    const tampered = ct.startsWith('a') ? `b${ct.slice(1)}` : `a${ct.slice(1)}`;
    store.set(COOKIE_NAME, { name: COOKIE_NAME, value: `${iv}:${tampered}:${tag}` });

    const result = await getSnykConnectionFromCookies();
    expect(result).toBeNull();
  });

  it('clears the cookie', async () => {
    await setSnykConnectionCookie(sample);
    await clearSnykConnectionCookie();
    expect(store.has(COOKIE_NAME)).toBe(false);
  });
});
