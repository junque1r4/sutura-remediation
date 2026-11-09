import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Mock the DB layers the internal routers depend on so the handlers run
// without a real database. The point of these tests is the AUTH boundary
// (authMiddleware in front of /internal), not the query logic.
vi.mock('../../db/token-usage', () => ({
  createTokenUsage: vi.fn().mockResolvedValue({
    id: 'tu-1',
    org_id: 'org-from-token',
    operation: 'analysis',
    model: 'claude',
    input_tokens: 1,
    output_tokens: 2,
    finding_id: null,
    finding_title: null,
    finding_severity: null,
    fix_attempt_id: null,
    cost_usd: '0',
    created_at: new Date().toISOString(),
  }),
  listTokenUsage: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 }),
  getTokenUsageStats: vi.fn().mockResolvedValue({ totalCostUsd: 0 }),
  getFindingCostRanking: vi.fn().mockResolvedValue([]),
  getFindingCostBreakdown: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../db/types', () => ({
  dbTokenUsageToApiResponse: (row: unknown) => row,
}));

vi.mock('../../db/analytics', () => ({
  getOverview: vi.fn().mockResolvedValue({}),
  getTrend: vi.fn().mockResolvedValue([]),
  getFixPerformance: vi.fn().mockResolvedValue([]),
  getRemediationFunnel: vi.fn().mockResolvedValue([]),
  getScannerBreakdown: vi.fn().mockResolvedValue([]),
  getCweBreakdown: vi.fn().mockResolvedValue([]),
  listRepos: vi.fn().mockResolvedValue([]),
}));

import { authMiddleware } from '../../middleware/auth';
import { internalTokenUsageRouter } from '../token-usage';
import { internalAnalyticsRouter } from '../analytics';
import { loadConfig } from '../../config';

const TEST_SECRET = 'test-jwt-secret';

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', TEST_SECRET).update(data).digest());
  return `${data}.${sig}`;
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/test';
  process.env.JWT_SECRET = TEST_SECRET;
  loadConfig();

  const app = express();
  app.use(express.json());
  // Mirror index.ts: internal routers sit BEHIND authMiddleware.
  app.use('/internal', authMiddleware, internalTokenUsageRouter);
  app.use('/internal', authMiddleware, internalAnalyticsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const INTERNAL_GET_PATHS = [
  '/internal/token-usage',
  '/internal/token-usage/stats',
  '/internal/token-usage/ranking',
  '/internal/token-usage/findings/abc',
  '/internal/analytics/overview',
  '/internal/analytics/trend',
  '/internal/analytics/fix-performance',
  '/internal/analytics/repos',
  '/internal/analytics/funnel',
  '/internal/analytics/breakdown/scanner',
  '/internal/analytics/breakdown/cwe',
];

describe('/internal/* JWT enforcement', () => {
  it.each(INTERNAL_GET_PATHS)('returns 401 for %s without an Authorization header', async (path) => {
    const res = await fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when the legacy x-internal-secret header is used instead of a JWT', async () => {
    const res = await fetch(`${baseUrl}/internal/token-usage`, {
      headers: { 'x-internal-secret': 'dev-internal-secret' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unsigned (alg:none) token', async () => {
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ sub: 'u', email: 'e@x.com', app_metadata: { org_id: 'o' } }));
    const res = await fetch(`${baseUrl}/internal/token-usage`, {
      headers: { authorization: `Bearer ${header}.${body}.` },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 for a valid signed JWT (previously this needed only the shared secret)', async () => {
    const jwt = makeJwt({
      sub: 'user-1',
      email: 'alice@example.com',
      app_metadata: { org_id: 'org-from-token', role: 'owner' },
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await fetch(`${baseUrl}/internal/token-usage`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { total: number };
    expect(json.total).toBe(0);
  });

  it('records token usage under the org from the verified token, not a client-supplied orgId', async () => {
    const { createTokenUsage } = await import('../../db/token-usage');
    const jwt = makeJwt({
      sub: 'user-1',
      email: 'alice@example.com',
      app_metadata: { org_id: 'org-from-token', role: 'owner' },
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await fetch(`${baseUrl}/internal/token-usage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      // Attacker tries to override the org via the body; it must be ignored.
      body: JSON.stringify({
        orgId: 'attacker-org',
        operation: 'analysis',
        model: 'claude',
        inputTokens: 1,
        outputTokens: 2,
        prompt: '',
        response: '',
      }),
    });
    expect(res.status).toBe(201);
    expect(createTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: 'org-from-token' }),
    );
  });
});
