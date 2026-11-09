import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Full set of valid env vars required by the schema
const VALID_ENV: Record<string, string> = {
  PORT: '4000',
  DATABASE_URL: 'postgres://localhost/testdb',
  JWT_SECRET: 'super-secret',
  ANTHROPIC_API_KEY: 'anthropic-key',
  PINECONE_API_KEY: 'pinecone-key',
  PINECONE_ENVIRONMENT: 'us-east-1',
  VOYAGE_API_KEY: 'voyage-key',
  REDIS_URL: 'redis://localhost:6380',
  GITHUB_APP_ID: 'github-app-id',
  GITHUB_PRIVATE_KEY: 'github-private-key',
  GITHUB_WEBHOOK_SECRET: 'github-webhook-secret',
  AIKIDO_WEBHOOK_SECRET: 'aikido-secret',
  SNYK_WEBHOOK_SECRET: 'snyk-secret',
  SNYK_API_TOKEN: 'snyk-token',
  DASHBOARD_URL: 'http://localhost:3000',
};

// Minimum valid env — only required fields; optional fields use defaults
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://localhost/testdb',
  ANTHROPIC_API_KEY: 'anthropic-key',
  PINECONE_API_KEY: 'pinecone-key',
  PINECONE_ENVIRONMENT: 'us-east-1',
  VOYAGE_API_KEY: 'voyage-key',
  GITHUB_APP_ID: 'github-app-id',
  GITHUB_PRIVATE_KEY: 'github-private-key',
  GITHUB_WEBHOOK_SECRET: 'github-webhook-secret',
};

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  // Clear env so tests start clean
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  // Reset module registry so the _config singleton is cleared between tests
  vi.resetModules();
});

afterEach(() => {
  // Restore original env
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config', () => {
  describe('loadConfig', () => {
    it('parses all env vars correctly when all are provided', async () => {
      Object.assign(process.env, VALID_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();

      expect(config.PORT).toBe(4000);
      expect(config.DATABASE_URL).toBe('postgres://localhost/testdb');
      expect(config.JWT_SECRET).toBe('super-secret');
      expect(config.ANTHROPIC_API_KEY).toBe('anthropic-key');
      expect(config.PINECONE_API_KEY).toBe('pinecone-key');
      expect(config.PINECONE_ENVIRONMENT).toBe('us-east-1');
      expect(config.VOYAGE_API_KEY).toBe('voyage-key');
      expect(config.REDIS_URL).toBe('redis://localhost:6380');
      expect(config.GITHUB_APP_ID).toBe('github-app-id');
      expect(config.GITHUB_PRIVATE_KEY).toBe('github-private-key');
      expect(config.GITHUB_WEBHOOK_SECRET).toBe('github-webhook-secret');
      expect(config.DASHBOARD_URL).toBe('http://localhost:3000');
    });

    it('throws a ZodError when DATABASE_URL is missing', async () => {
      Object.assign(process.env, VALID_ENV);
      delete process.env.DATABASE_URL;
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow();
    });

    it('coerces PORT string to a number', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      process.env.PORT = '8080';
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.PORT).toBe(8080);
      expect(typeof config.PORT).toBe('number');
    });

    it('applies default PORT=3001 when PORT is not set', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.PORT).toBe(3001);
    });

    it('applies default REDIS_URL when not provided', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.REDIS_URL).toBe('redis://localhost:6379');
    });

    it('applies default JWT_SECRET when not provided', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.JWT_SECRET).toBe('dev-secret');
    });

    it('applies default DASHBOARD_URL when not provided', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.DASHBOARD_URL).toBe('http://localhost:3000');
    });

    it('applies default empty string for AIKIDO_WEBHOOK_SECRET', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.AIKIDO_WEBHOOK_SECRET).toBe('');
    });

    it('applies default empty string for SNYK_WEBHOOK_SECRET', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.SNYK_WEBHOOK_SECRET).toBe('');
    });

    it('applies default empty string for SNYK_API_TOKEN', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const config = loadConfig();
      expect(config.SNYK_API_TOKEN).toBe('');
    });

    it('returns the same singleton instance on subsequent calls', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      const first = loadConfig();
      const second = loadConfig();
      expect(first).toBe(second);
    });
  });

  describe('assertSecure (production boot validation)', () => {
    // A strong, non-default value (>= 32 chars) for secrets validated in prod.
    const STRONG = 'a'.repeat(64);
    const STRONG_ENV: Record<string, string> = {
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      JWT_SECRET: STRONG,
      INTEGRATION_ENCRYPTION_KEY: STRONG,
    };

    it('accepts strong secrets in production', async () => {
      Object.assign(process.env, STRONG_ENV);
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).not.toThrow();
    });

    it('rejects the default JWT_SECRET in production', async () => {
      Object.assign(process.env, STRONG_ENV);
      delete process.env.JWT_SECRET; // falls back to dev default
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('rejects a missing INTEGRATION_ENCRYPTION_KEY in production', async () => {
      Object.assign(process.env, STRONG_ENV);
      delete process.env.INTEGRATION_ENCRYPTION_KEY; // defaults to ''
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
    });

    it('rejects a too-short INTEGRATION_ENCRYPTION_KEY in production', async () => {
      Object.assign(process.env, STRONG_ENV);
      process.env.INTEGRATION_ENCRYPTION_KEY = 'short';
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
    });

    it('rejects a known placeholder INTEGRATION_ENCRYPTION_KEY in production', async () => {
      Object.assign(process.env, STRONG_ENV);
      process.env.INTEGRATION_ENCRYPTION_KEY = 'replace-me-generate-with-openssl-rand-hex-32';
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
    });

    it('does not enforce secret strength outside production', async () => {
      // No NODE_ENV=production, dev defaults / empty values are tolerated.
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).not.toThrow();
    });
  });

  describe('getConfig', () => {
    it('throws if loadConfig was never called', async () => {
      const { getConfig } = await import('../config');

      expect(() => getConfig()).toThrow('Config not loaded. Call loadConfig() first.');
    });

    it('returns config after loadConfig has been called', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig, getConfig } = await import('../config');

      loadConfig();
      const config = getConfig();
      expect(config.DATABASE_URL).toBe('postgres://localhost/testdb');
    });

    it('returns the same object reference as loadConfig', async () => {
      Object.assign(process.env, REQUIRED_ENV);
      const { loadConfig, getConfig } = await import('../config');

      const fromLoad = loadConfig();
      const fromGet = getConfig();
      expect(fromGet).toBe(fromLoad);
    });
  });
});
