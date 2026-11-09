import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getIntegrationEncryptionSecret,
  assertEncryptionSecureOrThrow,
} from '../encryption-config';

const STRONG_SECRET =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('getIntegrationEncryptionSecret', () => {
  it('returns INTEGRATION_ENCRYPTION_KEY when set', () => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', STRONG_SECRET);
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(getIntegrationEncryptionSecret()).toBe(STRONG_SECRET);
  });

  it('returns no hardcoded fallback when env is unset', () => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '');
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(getIntegrationEncryptionSecret()).toBe('');
  });

  it('falls back to the legacy SNYK_ENCRYPTION_SECRET with a one-time deprecation warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '');
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', STRONG_SECRET);
    // First call resolves and warns.
    expect(getIntegrationEncryptionSecret()).toBe(STRONG_SECRET);
    // Second call still resolves; warning is emitted at most once per process.
    expect(getIntegrationEncryptionSecret()).toBe(STRONG_SECRET);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SNYK_ENCRYPTION_SECRET is deprecated');
  });

  it('prefers INTEGRATION_ENCRYPTION_KEY over the legacy var when both are set', () => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', STRONG_SECRET);
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', 'legacy-value');
    expect(getIntegrationEncryptionSecret()).toBe(STRONG_SECRET);
  });
});

describe('assertEncryptionSecureOrThrow in production', () => {
  it('throws when the secret is missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '');
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(() => assertEncryptionSecureOrThrow()).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
  });

  it('throws when the secret is a known default placeholder', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', 'replace-me-generate-with-openssl-rand-hex-32');
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(() => assertEncryptionSecureOrThrow()).toThrow(/Insecure configuration/);
  });

  it('throws when the secret is too short', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', 'short-secret');
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(() => assertEncryptionSecureOrThrow()).toThrow(/Insecure configuration/);
  });

  it('resolves when a strong secret is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', STRONG_SECRET);
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(() => assertEncryptionSecureOrThrow()).not.toThrow();
  });
});

describe('assertEncryptionSecureOrThrow outside production', () => {
  it('does not throw on a missing secret but warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '');
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(() => assertEncryptionSecureOrThrow()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('does not throw or warn on a strong secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', STRONG_SECRET);
    vi.stubEnv('SNYK_ENCRYPTION_SECRET', '');
    expect(() => assertEncryptionSecureOrThrow()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
