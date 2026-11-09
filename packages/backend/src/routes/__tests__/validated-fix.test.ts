import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/findings', () => ({
  getFinding: vi.fn(),
  getFindingByExternal: vi.fn(),
  upsertFinding: vi.fn(),
}));

vi.mock('../../db/fix-attempts', () => ({
  listAttemptsByFinding: vi.fn(),
  getFixAttempt: vi.fn(),
}));

vi.mock('../../db/sandbox-logs', () => ({
  listSandboxLogs: vi.fn(),
}));

vi.mock('../../db/types', () => ({
  dbFixAttemptToApiResponse: vi.fn((row) => row),
  dbSandboxLogToApiResponse: vi.fn((row) => row),
}));

vi.mock('../../queue/enqueue', () => ({
  enqueueValidationJob: vi.fn(),
  cancelValidationJob: vi.fn(),
}));

import { validatedFixRouter } from '../validated-fix';
import { getFinding } from '../../db/findings';
import { enqueueValidationJob } from '../../queue/enqueue';

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

const UUID = '11111111-1111-1111-1111-111111111111';

function makeDbFinding(overrides: any = {}): any {
  return {
    id: UUID,
    org_id: 'org-1',
    scanner_source: 'aikido',
    external_id: 'ext-1',
    title: 'Vuln',
    description: 'desc',
    severity: 'high',
    repo: 'org/repo',
    status: 'open',
    raw_payload: null,
    ingested_at: '2024-01-01T00:00:00Z',
    resolved_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /findings/:id/validated-fix advisory gate', () => {
  it('returns 400 and does not enqueue for an advisory container finding', async () => {
    (getFinding as any).mockResolvedValue(
      makeDbFinding({
        repo: 'unknown',
        raw_payload: {
          container_repo_name: 'myorg/myimage',
          attack_surface: 'docker_container',
          code_repo_name: null,
        },
      }),
    );

    const handler = getHandler(validatedFixRouter, 'post', '/findings/:id/validated-fix');
    const req = makeReq({ params: { id: UUID } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('advisory') }),
    );
    expect(enqueueValidationJob).not.toHaveBeenCalled();
  });

  it('enqueues (202) for a code-repo finding', async () => {
    (getFinding as any).mockResolvedValue(
      makeDbFinding({
        repo: 'org/repo',
        raw_payload: { code_repo_name: 'org/repo' },
      }),
    );
    (enqueueValidationJob as any).mockResolvedValue('job-1');

    const handler = getHandler(validatedFixRouter, 'post', '/findings/:id/validated-fix');
    const req = makeReq({ params: { id: UUID } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(enqueueValidationJob).toHaveBeenCalledTimes(1);
    expect(enqueueValidationJob).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: UUID, orgId: 'org-1' }),
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ jobId: 'job-1', findingId: UUID });
  });

  it('returns 404 when the finding cannot be resolved', async () => {
    (getFinding as any).mockResolvedValue(null);

    const handler = getHandler(validatedFixRouter, 'post', '/findings/:id/validated-fix');
    const req = makeReq({ params: { id: UUID } });
    const res = makeRes();
    await handler(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(enqueueValidationJob).not.toHaveBeenCalled();
  });
});
