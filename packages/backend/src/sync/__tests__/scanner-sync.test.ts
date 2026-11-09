import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connections', () => ({
  getConnectionSecret: vi.fn(),
  getConnection: vi.fn(),
}));

vi.mock('../../db/findings', () => ({
  upsertFindings: vi.fn(),
}));

const fetchFindings = vi.fn();
vi.mock('../../adapters/scanners/aikido/aikido-adapter', () => ({
  AikidoAdapter: vi.fn(function () {
    return { fetchFindings };
  }),
}));
vi.mock('../../adapters/scanners/snyk/snyk-adapter', () => ({
  SnykAdapter: vi.fn(function () {
    return { fetchFindings };
  }),
}));

import { syncProvider, syncAll } from '../scanner-sync';
import { getConnectionSecret, getConnection } from '../../db/connections';
import { upsertFindings } from '../../db/findings';

const ORG = 'org-1';

const finding = (id: string) => ({ externalId: id, scanner: 'aikido', title: id }) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncProvider', () => {
  it('fetches and upserts, returning fetched/upserted counts', async () => {
    (getConnectionSecret as any).mockResolvedValue('client:secret');
    fetchFindings.mockResolvedValue([finding('1'), finding('2')]);
    (upsertFindings as any).mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    const result = await syncProvider(ORG, 'aikido');

    expect(result).toEqual({ provider: 'aikido', fetched: 2, upserted: 2 });
    expect(upsertFindings).toHaveBeenCalledWith(ORG, [finding('1'), finding('2')]);
  });

  it('skips when the provider is not connected', async () => {
    (getConnectionSecret as any).mockResolvedValue(null);

    const result = await syncProvider(ORG, 'aikido');

    expect(result).toEqual({ provider: 'aikido', fetched: 0, upserted: 0, skipped: true });
    expect(fetchFindings).not.toHaveBeenCalled();
    expect(upsertFindings).not.toHaveBeenCalled();
  });

  it('captures a fetch error into SyncResult.error without throwing', async () => {
    (getConnectionSecret as any).mockResolvedValue('client:secret');
    fetchFindings.mockRejectedValue(new Error('Aikido API error: 500'));

    const result = await syncProvider(ORG, 'aikido');

    expect(result).toEqual({
      provider: 'aikido',
      fetched: 0,
      upserted: 0,
      error: 'Aikido API error: 500',
    });
  });

  it('assembles the snyk config from metadata_json (org id + region base url)', async () => {
    (getConnectionSecret as any).mockResolvedValue('snyk-token');
    (getConnection as any).mockResolvedValue({
      metadata_json: { orgId: 'snyk-org', region: 'eu' },
    });
    fetchFindings.mockResolvedValue([finding('1')]);
    (upsertFindings as any).mockResolvedValue([{ id: 'a' }]);

    const result = await syncProvider(ORG, 'snyk');

    expect(result).toEqual({ provider: 'snyk', fetched: 1, upserted: 1 });
    expect(fetchFindings).toHaveBeenCalledWith({
      apiKey: 'snyk-token',
      orgId: 'snyk-org',
      baseUrl: 'https://api.eu.snyk.io',
    });
  });

  it('leaves snyk baseUrl undefined for the us region (adapter default)', async () => {
    (getConnectionSecret as any).mockResolvedValue('snyk-token');
    (getConnection as any).mockResolvedValue({
      metadata_json: { orgId: 'snyk-org', region: 'us' },
    });
    fetchFindings.mockResolvedValue([]);
    (upsertFindings as any).mockResolvedValue([]);

    await syncProvider(ORG, 'snyk');

    expect(fetchFindings).toHaveBeenCalledWith({
      apiKey: 'snyk-token',
      orgId: 'snyk-org',
      baseUrl: undefined,
    });
  });
});

describe('syncAll', () => {
  it('isolates a failing provider so the other still syncs', async () => {
    (getConnectionSecret as any).mockResolvedValue('secret');
    (getConnection as any).mockResolvedValue({ metadata_json: { orgId: 'snyk-org' } });
    // aikido runs first and throws; snyk succeeds.
    fetchFindings.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([finding('1')]);
    (upsertFindings as any).mockResolvedValue([{ id: 'a' }]);

    const results = await syncAll(ORG);

    expect(results).toEqual([
      { provider: 'aikido', fetched: 0, upserted: 0, error: 'boom' },
      { provider: 'snyk', fetched: 1, upserted: 1 },
    ]);
  });
});
