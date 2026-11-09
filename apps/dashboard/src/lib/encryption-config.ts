/**
 * Central resolution and boot-time validation for the integration encryption
 * secret used to encrypt OAuth / API-key cookie payloads (Aikido, Anthropic,
 * Snyk).
 *
 * Mirrors the fail-fast philosophy of packages/backend/src/config.ts
 * (assertSecure): a misconfigured production deploy must never boot with a
 * missing, empty, default, or too-short encryption secret.
 */

// Dev-only fallback. Rejected in production (see assertEncryptionSecureOrThrow).
const DEV_ENCRYPTION_SECRET = 'dev-integration-encryption-key';

// Known weak / default values that must never be used in production. Includes
// the legacy per-integration defaults that previously lived in aikido.ts and
// anthropic.ts so an accidental carry-over is also rejected.
const WEAK_ENCRYPTION_SECRETS = new Set([
  '',
  DEV_ENCRYPTION_SECRET,
  'aikido-default-secret',
  'anthropic-default-secret',
  'replace-me-generate-with-openssl-rand-hex-32',
]);

// A strong secret should be at least 32 characters (e.g. `openssl rand -hex 32`
// yields 64 hex chars). Anything shorter is treated as too weak for production.
const MIN_SECRET_LENGTH = 32;

let warnedLegacy = false;

/**
 * Resolve the integration encryption secret from the environment.
 *
 * Reads INTEGRATION_ENCRYPTION_KEY with NO hardcoded fallback. During the
 * transition away from the legacy SNYK_ENCRYPTION_SECRET name, if the new var
 * is unset but the legacy one is set, the legacy value is used and a one-time
 * deprecation warning is emitted.
 *
 * Returns an empty string when nothing is configured; callers relying on this
 * for security should run assertEncryptionSecureOrThrow() at boot.
 */
export function getIntegrationEncryptionSecret(): string {
  const next = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (next != null && next !== '') {
    return next;
  }

  const legacy = process.env.SNYK_ENCRYPTION_SECRET;
  if (legacy != null && legacy !== '') {
    if (!warnedLegacy) {
      warnedLegacy = true;
      console.warn(
        '[encryption-config] SNYK_ENCRYPTION_SECRET is deprecated; ' +
          'set INTEGRATION_ENCRYPTION_KEY instead. Falling back to the legacy value for now.',
      );
    }
    return legacy;
  }

  return '';
}

/**
 * Fail-fast on insecure integration encryption secrets in production.
 *
 * In production, throws when the resolved secret is missing, empty, a known
 * default, or too short. Outside production a dev default is permitted but a
 * warning is emitted so the weak value is visible in logs.
 */
export function assertEncryptionSecureOrThrow(): void {
  const secret = getIntegrationEncryptionSecret();
  const isProduction = process.env.NODE_ENV === 'production';

  const isWeak =
    WEAK_ENCRYPTION_SECRETS.has(secret) || secret.length < MIN_SECRET_LENGTH;

  if (!isProduction) {
    if (isWeak) {
      console.warn(
        '[encryption-config] INTEGRATION_ENCRYPTION_KEY is missing or weak; ' +
          'using a development-only value. Set a strong 32+ byte secret before deploying.',
      );
    }
    return;
  }

  if (isWeak) {
    throw new Error(
      'Insecure configuration: INTEGRATION_ENCRYPTION_KEY must be set to a strong, ' +
        'non-default value of at least 32 characters in production',
    );
  }
}
