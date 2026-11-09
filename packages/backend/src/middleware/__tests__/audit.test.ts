import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mockLogAction is available inside the vi.mock factory
const { mockLogAction } = vi.hoisted(() => ({ mockLogAction: vi.fn() }));

vi.mock('../../db/audit-log', () => ({
  logAction: mockLogAction,
}));

import { auditMiddleware } from '../audit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(method: string, path: string, extras: Record<string, unknown> = {}): any {
  return { method, path, ...extras };
}

function mockRes(statusCode = 200): any {
  const listeners: Record<string, Function[]> = {};
  const res: any = { statusCode };
  res.on = vi.fn((event: string, cb: Function) => {
    listeners[event] = listeners[event] || [];
    listeners[event].push(cb);
    return res;
  });
  res._emit = (event: string) => listeners[event]?.forEach((cb) => cb());
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auditMiddleware', () => {
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn();
    vi.clearAllMocks();
  });

  describe('non-mutating methods — no audit logging', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('%s request skips audit and calls next', (method) => {
      const req = mockReq(method, '/some/path');
      const res = mockRes();

      auditMiddleware(req, res, next);

      expect(res.on).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('mutating methods — registers finish listener', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s request registers a finish listener',
      (method) => {
        const req = mockReq(method, '/api/resource', { orgId: 'org-1', actor: 'user@example.com' });
        const res = mockRes();

        auditMiddleware(req, res, next);

        expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
        expect(next).toHaveBeenCalledOnce();
      },
    );
  });

  describe('finish listener — triggers logAction on success', () => {
    it('calls logAction with correct data on POST 200', async () => {
      mockLogAction.mockResolvedValue(undefined);

      const req = mockReq('POST', '/api/findings', { orgId: 'org-1', actor: 'alice@example.com' });
      const res = mockRes(201);

      auditMiddleware(req, res, next);
      res._emit('finish');

      // logAction is async — flush microtask queue
      await vi.waitFor(() => expect(mockLogAction).toHaveBeenCalledOnce());

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-1',
          actor: 'alice@example.com',
          action: 'POST /api/findings',
        }),
      );
    });

    it('passes method, path and status in metadata_json', async () => {
      mockLogAction.mockResolvedValue(undefined);

      const req = mockReq('DELETE', '/api/findings/42', { orgId: 'org-2', actor: 'bob@example.com' });
      const res = mockRes(204);

      auditMiddleware(req, res, next);
      res._emit('finish');

      await vi.waitFor(() => expect(mockLogAction).toHaveBeenCalledOnce());

      const arg = mockLogAction.mock.calls[0][0];
      expect(arg.metadata_json).toEqual({ method: 'DELETE', path: '/api/findings/42', status: 204 });
    });
  });

  describe('finish listener — skips logAction on error status', () => {
    it.each([400, 401, 403, 404, 500])(
      'does NOT call logAction when statusCode is %i',
      (statusCode) => {
        const req = mockReq('POST', '/api/findings', { orgId: 'org-1', actor: 'user@example.com' });
        const res = mockRes(statusCode);

        auditMiddleware(req, res, next);
        res._emit('finish');

        expect(mockLogAction).not.toHaveBeenCalled();
      },
    );
  });

  describe('finish listener — skips logAction when auth info is missing', () => {
    it('does not call logAction when orgId is missing from request', () => {
      const req = mockReq('POST', '/api/findings', { actor: 'user@example.com' });
      const res = mockRes(200);

      auditMiddleware(req, res, next);
      res._emit('finish');

      expect(mockLogAction).not.toHaveBeenCalled();
    });

    it('does not call logAction when actor is missing from request', () => {
      const req = mockReq('POST', '/api/findings', { orgId: 'org-1' });
      const res = mockRes(200);

      auditMiddleware(req, res, next);
      res._emit('finish');

      expect(mockLogAction).not.toHaveBeenCalled();
    });
  });

  describe('logAction failure is swallowed', () => {
    it('does not throw when logAction rejects', async () => {
      mockLogAction.mockRejectedValue(new Error('DB failure'));

      const req = mockReq('PUT', '/api/findings/1', { orgId: 'org-1', actor: 'user@example.com' });
      const res = mockRes(200);

      auditMiddleware(req, res, next);

      // Should not throw
      expect(() => res._emit('finish')).not.toThrow();

      // Give the rejected promise a chance to settle; no unhandled rejection should surface
      await new Promise((r) => setTimeout(r, 10));
    });
  });
});
