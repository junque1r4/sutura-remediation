import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * runStartupCleanup wires the per-repo dependency-cache GC into worker boot.
 * The gcCacheVolumes function itself is unit-tested in sandbox-runner; here we
 * lock the WIRING: that boot actually calls it, with the TTL derived from
 * SANDBOX_CACHE_TTL_DAYS, and that the documented "0 disables GC" value reaches
 * gcCacheVolumes as 0 (not silently coerced back to the 14-day default).
 * Docker and Postgres are mocked so no daemon/DB is touched.
 */
const gcCacheVolumes = vi.fn(async () => [] as string[]);
vi.mock('@sutura/sandbox-runner', () => ({
  gcCacheVolumes,
  getDockerConnectionOptions: () => ({}),
}));

vi.mock('dockerode', () => ({
  default: class {
    listContainers = async () => [];
    getContainer = () => ({ remove: async () => undefined });
  },
}));

vi.mock('../../../db/client', () => ({
  getPool: () => ({ query: async () => ({ rowCount: 0, rows: [] }) }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL = process.env.SANDBOX_CACHE_TTL_DAYS;

beforeEach(() => {
  gcCacheVolumes.mockClear();
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SANDBOX_CACHE_TTL_DAYS;
  else process.env.SANDBOX_CACHE_TTL_DAYS = ORIGINAL;
});

describe('runStartupCleanup cache-GC wiring', () => {
  it('calls gcCacheVolumes once with the default 14-day TTL when unset', async () => {
    vi.resetModules();
    delete process.env.SANDBOX_CACHE_TTL_DAYS;
    const { runStartupCleanup } = await import('../startup-cleanup');
    await runStartupCleanup();
    expect(gcCacheVolumes).toHaveBeenCalledTimes(1);
    expect(gcCacheVolumes).toHaveBeenCalledWith(expect.anything(), 14 * DAY_MS);
  });

  it('passes a custom TTL through (7 days)', async () => {
    vi.resetModules();
    process.env.SANDBOX_CACHE_TTL_DAYS = '7';
    const { runStartupCleanup } = await import('../startup-cleanup');
    await runStartupCleanup();
    expect(gcCacheVolumes).toHaveBeenCalledWith(expect.anything(), 7 * DAY_MS);
  });

  it('passes 0 through verbatim so "0 disables GC" actually holds', async () => {
    vi.resetModules();
    process.env.SANDBOX_CACHE_TTL_DAYS = '0';
    const { runStartupCleanup } = await import('../startup-cleanup');
    await runStartupCleanup();
    expect(gcCacheVolumes).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('never throws even if gcCacheVolumes rejects (best-effort boot)', async () => {
    vi.resetModules();
    delete process.env.SANDBOX_CACHE_TTL_DAYS;
    gcCacheVolumes.mockRejectedValueOnce(new Error('docker down'));
    const { runStartupCleanup } = await import('../startup-cleanup');
    await expect(runStartupCleanup()).resolves.toBeUndefined();
  });
});
