import { z } from 'zod';

// Dev-only fallback. Rejected in production (see assertSecure).
const DEV_JWT_SECRET = 'dev-secret';

const WEAK_JWT_SECRETS = new Set(['', DEV_JWT_SECRET]);

// Known weak / default integration encryption secrets. Mirrors the dashboard's
// lib/encryption-config.ts so both sides reject the same values, plus a length
// floor (openssl rand -hex 32 yields 64 hex chars).
const WEAK_ENCRYPTION_SECRETS = new Set([
  '',
  'dev-integration-encryption-key',
  'aikido-default-secret',
  'anthropic-default-secret',
  'replace-me-generate-with-openssl-rand-hex-32',
]);
const MIN_ENCRYPTION_SECRET_LENGTH = 32;

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().default(DEV_JWT_SECRET),
  ANTHROPIC_API_KEY: z.string().default(''),
  PINECONE_API_KEY: z.string().default(''),
  PINECONE_ENVIRONMENT: z.string().default(''),
  VOYAGE_API_KEY: z.string().default(''),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  GITHUB_APP_ID: z.string().default(''),
  GITHUB_PRIVATE_KEY: z.string().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
  AIKIDO_WEBHOOK_SECRET: z.string().default(''),
  AIKIDO_API_KEY: z.string().default(''),
  SNYK_WEBHOOK_SECRET: z.string().default(''),
  SNYK_API_TOKEN: z.string().default(''),
  DASHBOARD_URL: z.string().default('http://localhost:3000'),
  // Encrypts secret fields stored in Redis job payloads (see
  // lib/secret-encryption.ts). Must round-trip with the dashboard's
  // INTEGRATION_ENCRYPTION_KEY. No hardcoded fallback; rejected when weak in
  // production by assertSecure.
  INTEGRATION_ENCRYPTION_KEY: z.string().default(''),
  // Outbound scanner sync (poll + on-demand): pulls issues from connected
  // scanners and upserts them so the DB is the durable source of truth.
  // Default-off; no behavior change until enabled.
  SCANNER_SYNC_ENABLED: z.coerce.boolean().default(false),
  SCANNER_SYNC_INTERVAL_MS: z.coerce.number().default(900000),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

/**
 * Fail-fast on insecure secrets in production. The dev default ('dev-secret')
 * and empty values are forbidden when NODE_ENV === 'production' so a
 * misconfigured deploy never starts with a forgeable JWT_SECRET.
 */
function assertSecure(config: Config): void {
  if (process.env.NODE_ENV !== 'production') return;
  const errors: string[] = [];
  if (WEAK_JWT_SECRETS.has(config.JWT_SECRET)) {
    errors.push('JWT_SECRET must be set to a strong, non-default value in production');
  }
  if (
    WEAK_ENCRYPTION_SECRETS.has(config.INTEGRATION_ENCRYPTION_KEY) ||
    config.INTEGRATION_ENCRYPTION_KEY.length < MIN_ENCRYPTION_SECRET_LENGTH
  ) {
    errors.push(
      'INTEGRATION_ENCRYPTION_KEY must be set to a strong, non-default value of at least 32 characters in production',
    );
  }
  if (errors.length > 0) {
    throw new Error(`Insecure configuration: ${errors.join('; ')}`);
  }
}

export function loadConfig(): Config {
  if (_config) return _config;
  const parsed = envSchema.parse(process.env);
  assertSecure(parsed);
  _config = parsed;
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}
