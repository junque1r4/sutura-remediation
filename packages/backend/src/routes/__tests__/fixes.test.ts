import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/fix-attempts', () => ({
  listFixAttemptsByOrg: vi.fn(),
  getFixAttempt: vi.fn(),
}));

vi.mock('../../db/types', () => ({
  dbFixAttemptToApiResponse: vi.fn((row) => ({ ...row, _mapped: true })),
}));

vi.mock('../../queue/enqueue', () => ({
  enqueueFixJob: vi.fn(),
}));

import { fixesRouter } from '../fixes';
import { listFixAttemptsByOrg, getFixAttempt } from '../../db/fix-attempts';
import { dbFixAttemptToApiResponse } from '../../db/types';
import { enqueueFixJob } from '../../queue/enqueue';

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

const mockFixAttempt = {
  id: 'attempt-1',
  finding_id: 'finding-1',
  org_id: 'org-1',
  prompt_snapshot: 'Fix this issue',
  generated_diff: null,
  test_result: null,
  pr_url: null,
  pr_status: null,
  claude_model: 'claude-sonnet-4-20250514',
  claude_tokens_used: 0,
  created_at: '2024-01-01T00:00:00Z',
  completed_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /', () => {
  it('calls listFixAttemptsByOrg with orgId and filters', async () => {
    vi.mocked(listFixAttemptsByOrg).mockResolvedValue({
      data: [mockFixAttempt],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const handler = getHandler(fixesRouter, 'get', '/');
    const req = makeReq({ query: { findingId: 'finding-1', page: '1', pageSize: '20' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(listFixAttemptsByOrg).toHaveBeenCalledWith('org-1', {
      findingId: 'finding-1',
      page: 1,
      pageSize: 20,
    });
    // called via .map(), so check first arg only
    expect(vi.mocked(dbFixAttemptToApiResponse).mock.calls[0][0]).toEqual(mockFixAttempt);
    expect(res.json).toHaveBeenCalledWith({
      data: [{ ...mockFixAttempt, _mapped: true }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes undefined page/pageSize when not provided', async () => {
    vi.mocked(listFixAttemptsByOrg).mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });

    const handler = getHandler(fixesRouter, 'get', '/');
    const req = makeReq({ query: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(listFixAttemptsByOrg).toHaveBeenCalledWith('org-1', {
      findingId: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(listFixAttemptsByOrg).mockRejectedValue(err);

    const handler = getHandler(fixesRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('GET /:id', () => {
  it('returns mapped fix attempt when found', async () => {
    vi.mocked(getFixAttempt).mockResolvedValue(mockFixAttempt);

    const handler = getHandler(fixesRouter, 'get', '/:id');
    const req = makeReq({ params: { id: 'attempt-1' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(getFixAttempt).toHaveBeenCalledWith('attempt-1');
    expect(dbFixAttemptToApiResponse).toHaveBeenCalledWith(mockFixAttempt);
    expect(res.json).toHaveBeenCalledWith({ ...mockFixAttempt, _mapped: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 when fix attempt not found', async () => {
    vi.mocked(getFixAttempt).mockResolvedValue(null);

    const handler = getHandler(fixesRouter, 'get', '/:id');
    const req = makeReq({ params: { id: 'missing-id' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Fix attempt not found' });
  });

  it('returns 404 when attempt belongs to a different org', async () => {
    vi.mocked(getFixAttempt).mockResolvedValue({ ...mockFixAttempt, org_id: 'other-org' });

    const handler = getHandler(fixesRouter, 'get', '/:id');
    const req = makeReq({ params: { id: 'attempt-1' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Fix attempt not found' });
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(getFixAttempt).mockRejectedValue(err);

    const handler = getHandler(fixesRouter, 'get', '/:id');
    const req = makeReq({ params: { id: 'attempt-1' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('POST /', () => {
  it('calls enqueueFixJob and returns 202 with jobId', async () => {
    vi.mocked(enqueueFixJob).mockResolvedValue('job-123');

    const handler = getHandler(fixesRouter, 'post', '/');
    const req = makeReq({ body: { findingId: 'finding-1' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(enqueueFixJob).toHaveBeenCalledWith({ findingId: 'finding-1', orgId: 'org-1' });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ jobId: 'job-123', message: 'Fix job enqueued' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when findingId is missing', async () => {
    const handler = getHandler(fixesRouter, 'post', '/');
    const req = makeReq({ body: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'findingId is required' });
    expect(enqueueFixJob).not.toHaveBeenCalled();
  });

  it('calls next(err) on enqueueFixJob error', async () => {
    const err = new Error('Queue error');
    vi.mocked(enqueueFixJob).mockRejectedValue(err);

    const handler = getHandler(fixesRouter, 'post', '/');
    const req = makeReq({ body: { findingId: 'finding-1' } });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
