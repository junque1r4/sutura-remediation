import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/codebase-indices', () => ({
  listIndices: vi.fn(),
  upsertIndex: vi.fn(),
}));

vi.mock('../../queue/enqueue', () => ({
  enqueueIndexJob: vi.fn(),
}));

import { repositoriesRouter } from '../repositories';
import { listIndices } from '../../db/codebase-indices';
import { enqueueIndexJob } from '../../queue/enqueue';

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

function getHandlerByMethod(router: any, method: string): Function {
  // Find the first route matching the given HTTP method
  const layer = router.stack.find((l: any) => {
    if (!l.route) return false;
    return l.route.methods[method];
  });
  if (!layer) throw new Error(`No ${method} handler found`);
  return layer.route.stack[0].handle;
}

function getHandler(router: any, method: string, path: string): Function {
  const layer = router.stack.find((l: any) => {
    if (!l.route) return false;
    return l.route.path === path && l.route.methods[method];
  });
  if (!layer) throw new Error(`No ${method} ${path} handler found`);
  return layer.route.stack[0].handle;
}

const mockIndex = {
  id: 'index-1',
  org_id: 'org-1',
  repo: 'org/repo',
  branch: 'main',
  last_indexed_at: '2024-01-01T00:00:00Z',
  file_count: 42,
  chunk_count: 200,
  vector_namespace: 'org-1-org-repo',
};

const expectedMappedIndex = {
  id: 'index-1',
  orgId: 'org-1',
  repo: 'org/repo',
  branch: 'main',
  lastIndexedAt: '2024-01-01T00:00:00Z',
  fileCount: 42,
  chunkCount: 200,
  vectorNamespace: 'org-1-org-repo',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /', () => {
  it('calls listIndices and returns mapped response', async () => {
    vi.mocked(listIndices).mockResolvedValue([mockIndex]);

    const handler = getHandler(repositoriesRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(listIndices).toHaveBeenCalledWith('org-1');
    expect(res.json).toHaveBeenCalledWith([expectedMappedIndex]);
    expect(next).not.toHaveBeenCalled();
  });

  it('maps snake_case fields to camelCase', async () => {
    vi.mocked(listIndices).mockResolvedValue([mockIndex]);

    const handler = getHandler(repositoriesRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    const result = res.json.mock.calls[0][0][0];
    expect(result.orgId).toBe('org-1');
    expect(result.lastIndexedAt).toBe('2024-01-01T00:00:00Z');
    expect(result.fileCount).toBe(42);
    expect(result.chunkCount).toBe(200);
    expect(result.vectorNamespace).toBe('org-1-org-repo');
    // Should not have raw snake_case fields
    expect(result.org_id).toBeUndefined();
    expect(result.last_indexed_at).toBeUndefined();
  });

  it('returns empty array when no indices', async () => {
    vi.mocked(listIndices).mockResolvedValue([]);

    const handler = getHandler(repositoriesRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(listIndices).mockRejectedValue(err);

    const handler = getHandler(repositoriesRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('POST /*repo/index', () => {
  // The route uses Express 5 / path-to-regexp v8 syntax /*repo/index.
  // Extract the POST handler by method since it's the only POST on this router.

  it('calls enqueueIndexJob and returns 202 with jobId', async () => {
    vi.mocked(enqueueIndexJob).mockResolvedValue('job-42');

    const handler = getHandlerByMethod(repositoriesRouter, 'post');
    const req = makeReq({
      params: { repo: 'org/repo' },
      body: { githubToken: 'ghp_token123', branch: 'develop' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(enqueueIndexJob).toHaveBeenCalledWith({
      repo: 'org/repo',
      branch: 'develop',
      orgId: 'org-1',
      githubToken: 'ghp_token123',
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ jobId: 'job-42', message: 'Index job enqueued' });
    expect(next).not.toHaveBeenCalled();
  });

  it('defaults branch to "main" when not provided', async () => {
    vi.mocked(enqueueIndexJob).mockResolvedValue('job-43');

    const handler = getHandlerByMethod(repositoriesRouter, 'post');
    const req = makeReq({
      params: { repo: 'org/repo' },
      body: { githubToken: 'ghp_token123' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(enqueueIndexJob).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'main' }),
    );
  });

  it('returns 400 when githubToken is missing', async () => {
    const handler = getHandlerByMethod(repositoriesRouter, 'post');
    const req = makeReq({
      params: { repo: 'org/repo' },
      body: {},
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'githubToken is required' });
    expect(enqueueIndexJob).not.toHaveBeenCalled();
  });

  it('calls next(err) on enqueueIndexJob error', async () => {
    const err = new Error('Queue error');
    vi.mocked(enqueueIndexJob).mockRejectedValue(err);

    const handler = getHandlerByMethod(repositoriesRouter, 'post');
    const req = makeReq({
      params: { repo: 'org/repo' },
      body: { githubToken: 'ghp_token123' },
    });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
