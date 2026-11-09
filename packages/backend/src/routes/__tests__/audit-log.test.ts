import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/audit-log', () => ({
  listAuditLog: vi.fn(),
  logAction: vi.fn(),
}));

vi.mock('../../db/types', () => ({
  dbAuditLogToApiResponse: vi.fn((row) => ({ ...row, _mapped: true })),
}));

import { auditLogRouter } from '../audit-log';
import { listAuditLog } from '../../db/audit-log';
import { dbAuditLogToApiResponse } from '../../db/types';

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

const mockAuditEntry = {
  id: 'entry-1',
  org_id: 'org-1',
  actor: 'user@test.com',
  action: 'finding.status_changed',
  resource_type: 'finding',
  resource_id: 'finding-1',
  metadata_json: { from: 'open', to: 'fixed' },
  created_at: '2024-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /', () => {
  it('calls listAuditLog with orgId and no filters when no query params', async () => {
    vi.mocked(listAuditLog).mockResolvedValue({
      data: [mockAuditEntry],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const handler = getHandler(auditLogRouter, 'get', '/');
    const req = makeReq({ query: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(listAuditLog).toHaveBeenCalledWith('org-1', {
      action: undefined,
      resourceType: undefined,
      search: undefined,
      page: undefined,
      pageSize: undefined,
    });
    // called via .map(), so check first arg only
    expect(vi.mocked(dbAuditLogToApiResponse).mock.calls[0][0]).toEqual(mockAuditEntry);
    expect(res.json).toHaveBeenCalledWith({
      data: [{ ...mockAuditEntry, _mapped: true }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes all filter params to listAuditLog', async () => {
    vi.mocked(listAuditLog).mockResolvedValue({
      data: [],
      total: 0,
      page: 2,
      pageSize: 5,
    });

    const handler = getHandler(auditLogRouter, 'get', '/');
    const req = makeReq({
      query: {
        action: 'finding.status_changed',
        resourceType: 'finding',
        search: 'sql',
        page: '2',
        pageSize: '5',
      },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(listAuditLog).toHaveBeenCalledWith('org-1', {
      action: 'finding.status_changed',
      resourceType: 'finding',
      search: 'sql',
      page: 2,
      pageSize: 5,
    });
  });

  it('parses page and pageSize as integers', async () => {
    vi.mocked(listAuditLog).mockResolvedValue({
      data: [],
      total: 0,
      page: 3,
      pageSize: 50,
    });

    const handler = getHandler(auditLogRouter, 'get', '/');
    const req = makeReq({ query: { page: '3', pageSize: '50' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    const callArgs = vi.mocked(listAuditLog).mock.calls[0][1];
    expect(typeof callArgs.page).toBe('number');
    expect(typeof callArgs.pageSize).toBe('number');
    expect(callArgs.page).toBe(3);
    expect(callArgs.pageSize).toBe(50);
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(listAuditLog).mockRejectedValue(err);

    const handler = getHandler(auditLogRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});
