// Dev-only fallback accepted outside production; rejected at boot in
// production by assertSharedSecretsSecureOrThrow below.
const WEAK_JWT_SECRETS = new Set(['', 'dev-secret']);

/**
 * Fail-fast on an insecure JWT secret in production. The dashboard signs
 * backend JWTs with JWT_SECRET (lib/auth/backend-token.ts) to authenticate
 * server-to-server calls; a forgeable default must never reach a production
 * deploy. Outside production the dev default is tolerated.
 */
function assertSharedSecretsSecureOrThrow(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const errors: string[] = [];
  if (WEAK_JWT_SECRETS.has(process.env.JWT_SECRET ?? '')) {
    errors.push('JWT_SECRET must be set to a strong, non-default value in production');
  }
  if (errors.length > 0) {
    throw new Error(`Insecure configuration: ${errors.join('; ')}`);
  }
}

export async function register(): Promise<void> {
  // Only on the Node.js runtime (instrumentation also runs in edge during
  // dev for middleware). DB + argon2 are Node-only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { bootstrapOwnerFromEnv } = await import('./lib/auth/bootstrap');
  try {
    await bootstrapOwnerFromEnv();
  } catch (err) {
    console.error('[bootstrap] failed', err);
  }
  // Fail-fast on an insecure integration encryption secret in production.
  const { assertEncryptionSecureOrThrow } = await import('./lib/encryption-config');
  assertEncryptionSecureOrThrow();
  // Fail-fast on an insecure JWT secret in production.
  assertSharedSecretsSecureOrThrow();
}
