import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/findings', () => ({
  listFindings: vi.fn(),
  getFinding: vi.fn(),
  // resolveFinding falls back to this when getFinding misses (deep-link
  // `<scanner>-<externalId>` ids). Must be mocked or the fallback throws.
  getFindingByExternal: vi.fn(),
  updateFindingStatus: vi.fn(),
  upsertFindings: vi.fn(),
}));

vi.mock('../../db/types', () => ({
  dbFindingToApiResponse: vi.fn((row) => ({ ...row, _mapped: true })),
}));

import { findingsRouter } from '../findings';
import { listFindings, getFinding, getFindingByExternal, updateFindingStatus } from '../../db/findings';
import { dbFindingToApiResponse } from '../../db/types';

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

const mockDbFinding = {
  id: 'finding-1',
  org_id: 'org-1',
  scanner_source: 'aikido',
  external_id: 'ext-1',
  title: 'SQL Injection',
  description: 'A SQL injection vulnerability',
  severity: 'high',
  cvss_score: 8.5,
  epss_score: 0.1,
  cwe_id: 'CWE-89',
  cve_id: null,
  file_path: '/src/app.ts',
  line_range: null,
  repo: 'org/repo',
  status: 'open',
  ingested_at: '2024-01-01T00:00:00Z',
  resolved_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /', () => {
  it('calls listFindings with orgId and no filters when no query params', async () => {
    vi.mocked(listFindings).mockResolvedValue({
      data: [mockDbFinding],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const handler = getHandler(findingsRouter, 'get', '/');
    const req = makeReq({ query: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(listFindings).toHaveBeenCalledWith('org-1', {
      status: undefined,
      severity: undefined,
      scanner: undefined,
      repo: undefined,
      page: undefined,
      pageSize: undefined,
    });
    // called via .map(), so check first arg only
    expect(vi.mocked(dbFindingToApiResponse).mock.calls[0][0]).toEqual(mockDbFinding);
    expect(res.json).toHaveBeenCalledWith({
      data: [{ ...mockDbFinding, _mapped: true }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes filters from query params to listFindings', async () => {
    vi.mocked(listFindings).mockResolvedValue({
      data: [],
      total: 0,
      page: 2,
      pageSize: 10,
    });

    const handler = getHandler(findingsRouter, 'get', '/');
    const req = makeReq({
      query: { status: 'open', severity: 'high', scanner: 'aikido', repo: 'org/repo', page: '2', pageSize: '10' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(listFindings).toHaveBeenCalledWith('org-1', {
      status: 'open',
      severity: 'high',
      scanner: 'aikido',
      repo: 'org/repo',
      page: 2,
      pageSize: 10,
    });
  });

  it('calls next(err) on listFindings error', async () => {
    const err = new Error('DB error');
    vi.mocked(listFindings).mockRejectedValue(err);

    const handler = getHandler(findingsRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('GET /:id', () => {
  it('returns mapped finding when found', async () => {
    vi.mocked(getFinding).mockResolvedValue(mockDbFinding);

    const handler = getHandler(findingsRouter, 'get', '/:id');
    const req = makeReq({ params: { id: 'finding-1' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(getFinding).toHaveBeenCalledWith('finding-1');
    expect(dbFindingToApiResponse).toHaveBeenCalledWith(mockDbFinding);
    expect(res.json).toHaveBeenCalledWith({ ...mockDbFinding, _mapped: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 when finding not found', async () => {
    vi.mocked(getFinding).mockResolvedValue(null);
    // The deep-link fallback also misses for a genuinely unknown id.
    vi.mocked(getFindingByExternal).mockResolvedValue(null);

    const handler = getHandler(findingsRouter, 'get', '/:id');
    const req = makeReq({ params: { id: 'missing-id' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Finding not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next(err) on getFinding error', async () => {
    const err = new Error('DB error');
    vi.mocked(getFinding).mockRejectedValue(err);

    const handler = getHandler(findingsRouter, 'get', '/:id');
    const req = makeReq({ params: { id: 'finding-1' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('PATCH /:id/status', () => {
  it('calls updateFindingStatus and returns mapped finding', async () => {
    const updated = { ...mockDbFinding, status: 'fixed' };
    // The handler now verifies org ownership via getFinding before mutating.
    vi.mocked(getFinding).mockResolvedValue(mockDbFinding);
    vi.mocked(updateFindingStatus).mockResolvedValue(updated);

    const handler = getHandler(findingsRouter, 'patch', '/:id/status');
    const req = makeReq({ params: { id: 'finding-1' }, body: { status: 'fixed' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(updateFindingStatus).toHaveBeenCalledWith('finding-1', 'fixed');
    expect(dbFindingToApiResponse).toHaveBeenCalledWith(updated);
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when status is missing', async () => {
    const handler = getHandler(findingsRouter, 'patch', '/:id/status');
    const req = makeReq({ params: { id: 'finding-1' }, body: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'status is required' });
    expect(updateFindingStatus).not.toHaveBeenCalled();
  });

  it('calls next(err) on updateFindingStatus error', async () => {
    const err = new Error('DB error');
    vi.mocked(updateFindingStatus).mockRejectedValue(err);

    const handler = getHandler(findingsRouter, 'patch', '/:id/status');
    const req = makeReq({ params: { id: 'finding-1' }, body: { status: 'fixed' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
