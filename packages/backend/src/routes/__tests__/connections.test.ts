import { describe, it, expect, vi, beforeEach } from 'vitest';

// A strong key so secret-encryption.ts actually encrypts (the route calls the
// real helper -- only the db layer is mocked, so we can assert ciphertext).
process.env.INTEGRATION_ENCRYPTION_KEY =
  'test-integration-key-0123456789abcdef0123456789abcdef';

vi.mock('../../db/connections', async () => {
  const actual = await vi.importActual<typeof import('../../db/connections')>(
    '../../db/connections',
  );
  return {
    ...actual,
    listConnections: vi.fn(),
    getConnection: vi.fn(),
    upsertConnection: vi.fn(),
    deleteConnection: vi.fn(),
  };
});

import { connectionsRouter, internalConnectionsRouter } from '../connections';
import {
  listConnections,
  getConnection,
  upsertConnection,
  deleteConnection,
} from '../../db/connections';
import { decryptSecret } from '../../lib/secret-encryption';

function makeReq(overrides: any = {}): any {
  return {
    query: {},
    params: {},
    body: {},
    orgId: 'org-1',
    actor: 'user@test.com',
    headers: {},
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res;
}

function makeNext(): any {
  return vi.fn();
}

function getHandler(router: any, method: string, path: string): Function {
  const layer = router.stack.find((l: any) => {
    if (!l.route) return false;
    return l.route.path === path && l.route.methods[method];
  });
  if (!layer) throw new Error(`No ${method} ${path} handler found`);
  return layer.route.stack[0].handle;
}

const mockRow = {
  id: 'conn-1',
  org_id: 'org-1',
  provider: 'snyk' as const,
  encrypted_secret: 'should-never-leak',
  masked_identifier: 'Acme Org',
  metadata_json: { orgId: 'snyk-org', orgName: 'Acme Org', region: 'us' },
  connected_by: 'user@test.com',
  connected_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /', () => {
  it('returns status array without secrets', async () => {
    vi.mocked(listConnections).mockResolvedValue([mockRow]);
    const handler = getHandler(connectionsRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(listConnections).toHaveBeenCalledWith('org-1');
    const body = res.json.mock.calls[0][0];
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toEqual({
      provider: 'snyk',
      connected: true,
      maskedIdentifier: 'Acme Org',
      connectedAt: '2026-01-01T00:00:00Z',
      metadata: mockRow.metadata_json,
    });
    expect(JSON.stringify(body)).not.toContain('should-never-leak');
    expect(JSON.stringify(body)).not.toContain('encrypted_secret');
  });
});

describe('GET /:provider', () => {
  it('returns status for a connected provider (no secret)', async () => {
    vi.mocked(getConnection).mockResolvedValue(mockRow);
    const handler = getHandler(connectionsRouter, 'get', '/:provider');
    const req = makeReq({ params: { provider: 'snyk' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(getConnection).toHaveBeenCalledWith('org-1', 'snyk');
    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('should-never-leak');
  });

  it('404 when not connected', async () => {
    vi.mocked(getConnection).mockResolvedValue(null);
    const handler = getHandler(connectionsRouter, 'get', '/:provider');
    const req = makeReq({ params: { provider: 'snyk' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('400 on unknown provider', async () => {
    const handler = getHandler(connectionsRouter, 'get', '/:provider');
    const req = makeReq({ params: { provider: 'bogus' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getConnection).not.toHaveBeenCalled();
  });
});

describe('PUT /:provider', () => {
  it('encrypts the secret before storing and never echoes it', async () => {
    vi.mocked(upsertConnection).mockResolvedValue(mockRow);
    const handler = getHandler(connectionsRouter, 'put', '/:provider');
    const req = makeReq({
      params: { provider: 'snyk' },
      body: {
        secret: 'snyk-plaintext-token',
        maskedIdentifier: 'Acme Org',
        metadata: { orgId: 'snyk-org' },
      },
    });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(upsertConnection).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(upsertConnection).mock.calls[0][0];
    // Stored value is ciphertext in iv:ct:tag shape, not the plaintext.
    expect(arg.encrypted_secret).not.toBe('snyk-plaintext-token');
    expect(arg.encrypted_secret).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i);
    expect(decryptSecret(arg.encrypted_secret)).toBe('snyk-plaintext-token');
    expect(arg.org_id).toBe('org-1');
    expect(arg.connected_by).toBe('user@test.com');

    // Response is status shape; no plaintext or ciphertext.
    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('snyk-plaintext-token');
    expect(JSON.stringify(body)).not.toContain('should-never-leak');
  });

  it('400 on empty secret (before encrypting)', async () => {
    const handler = getHandler(connectionsRouter, 'put', '/:provider');
    const req = makeReq({ params: { provider: 'snyk' }, body: { secret: '' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it('400 on missing secret', async () => {
    const handler = getHandler(connectionsRouter, 'put', '/:provider');
    const req = makeReq({ params: { provider: 'snyk' }, body: {} });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it('400 on unknown provider', async () => {
    const handler = getHandler(connectionsRouter, 'put', '/:provider');
    const req = makeReq({ params: { provider: 'bogus' }, body: { secret: 'x' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(upsertConnection).not.toHaveBeenCalled();
  });
});

describe('DELETE /:provider', () => {
  it('204 and idempotent', async () => {
    vi.mocked(deleteConnection).mockResolvedValue(undefined);
    const handler = getHandler(connectionsRouter, 'delete', '/:provider');
    const req = makeReq({ params: { provider: 'aikido' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(deleteConnection).toHaveBeenCalledWith('org-1', 'aikido');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('400 on unknown provider', async () => {
    const handler = getHandler(connectionsRouter, 'delete', '/:provider');
    const req = makeReq({ params: { provider: 'bogus' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(deleteConnection).not.toHaveBeenCalled();
  });
});

describe('internal GET /connections/:provider/secret', () => {
  it('returns the decrypted secret scoped to the JWT org', async () => {
    // Round-trip: store ciphertext, expect the handler to decrypt it.
    const { encryptSecret } = await import('../../lib/secret-encryption');
    vi.mocked(getConnection).mockResolvedValue({
      ...mockRow,
      provider: 'anthropic',
      encrypted_secret: encryptSecret('sk-ant-secret'),
      metadata_json: {},
    });
    const handler = getHandler(
      internalConnectionsRouter,
      'get',
      '/connections/:provider/secret',
    );
    const req = makeReq({ params: { provider: 'anthropic' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(getConnection).toHaveBeenCalledWith('org-1', 'anthropic');
    expect(res.json).toHaveBeenCalledWith({
      provider: 'anthropic',
      secret: 'sk-ant-secret',
      metadata: {},
    });
  });

  it('404 when not connected', async () => {
    vi.mocked(getConnection).mockResolvedValue(null);
    const handler = getHandler(
      internalConnectionsRouter,
      'get',
      '/connections/:provider/secret',
    );
    const req = makeReq({ params: { provider: 'anthropic' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('400 on unknown provider', async () => {
    const handler = getHandler(
      internalConnectionsRouter,
      'get',
      '/connections/:provider/secret',
    );
    const req = makeReq({ params: { provider: 'bogus' } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
