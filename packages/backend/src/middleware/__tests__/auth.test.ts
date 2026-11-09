import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { createHmac } from 'crypto';
import { authMiddleware } from '../auth';
import { loadConfig } from '../../config';

// The middleware reads config.JWT_SECRET via getConfig(); the harness must
// load config before any test runs. NODE_ENV stays at test/dev so the dev
// default secret is permitted.
const TEST_SECRET = 'test-jwt-secret';

beforeAll(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/test';
  process.env.JWT_SECRET = TEST_SECRET;
  loadConfig();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Sign a real HS256 JWT with the test secret. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', TEST_SECRET).update(data).digest());
  return `${data}.${sig}`;
}

/** Build an unsigned alg:none token (the legacy/attack shape). */
function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

/** An HS256-headered token whose signature does not match. */
function makeJwtBadSignature(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${b64url('not-the-real-signature')}`;
}

function mockReq(headers: Record<string, string> = {}): any {
  return { headers };
}

function mockRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authMiddleware', () => {
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn();
  });

  describe('missing / malformed Authorization header', () => {
    it('returns 401 when Authorization header is missing', () => {
      const req = mockReq();
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing or invalid Authorization header' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header lacks "Bearer " prefix', () => {
      const req = mockReq({ authorization: 'Token abc123' });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing or invalid Authorization header' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header is just "Bearer" with no token', () => {
      const req = mockReq({ authorization: 'Bearer' });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('invalid JWT structure', () => {
    it('returns 401 when JWT does not have 3 parts', () => {
      const req = mockReq({ authorization: 'Bearer only.twoparts' });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when JWT payload has malformed base64', () => {
      const req = mockReq({ authorization: 'Bearer header.!!!not-base64!!!.sig' });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('JWT payload missing required claims', () => {
    it('returns 401 when payload has no app_metadata.org_id and no sub', () => {
      const jwt = makeJwt({ email: 'user@example.com' });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token missing required claims' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when payload has no email and no sub (actor missing)', () => {
      const jwt = makeJwt({ app_metadata: { org_id: 'org-1' } });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token missing required claims' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('signature / algorithm enforcement', () => {
    it('rejects an unsigned alg:none token even with valid claims (401)', () => {
      const jwt = makeUnsignedJwt({
        sub: 'user-uuid',
        email: 'attacker@example.com',
        app_metadata: { org_id: 'victim-org' },
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unsigned tokens are not accepted' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects an HS256 token with an invalid signature (401)', () => {
      const jwt = makeJwtBadSignature({
        sub: 'user-uuid',
        email: 'alice@example.com',
        app_metadata: { org_id: 'org-abc' },
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token signature' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects an unsupported algorithm (e.g. RS256) (401)', () => {
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const body = b64url(JSON.stringify({ sub: 'u', email: 'e@x.com' }));
      const req = mockReq({ authorization: `Bearer ${header}.${body}.sig` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unsigned tokens are not accepted' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects an expired but correctly-signed token (401)', () => {
      const jwt = makeJwt({
        sub: 'user-uuid',
        email: 'alice@example.com',
        app_metadata: { org_id: 'org-abc' },
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token expired' });
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts a correctly-signed unexpired token', () => {
      const jwt = makeJwt({
        sub: 'user-uuid',
        email: 'alice@example.com',
        app_metadata: { org_id: 'org-abc' },
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.orgId).toBe('org-abc');
      expect(req.actor).toBe('alice@example.com');
    });
  });

  describe('valid JWT', () => {
    it('extracts orgId from app_metadata.org_id and actor from email', () => {
      const jwt = makeJwt({
        sub: 'user-uuid',
        email: 'alice@example.com',
        app_metadata: { org_id: 'org-abc' },
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(req.orgId).toBe('org-abc');
      expect(req.actor).toBe('alice@example.com');
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('falls back to sub for orgId when app_metadata.org_id is absent', () => {
      const jwt = makeJwt({
        sub: 'user-uuid',
        email: 'alice@example.com',
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(req.orgId).toBe('user-uuid');
      expect(req.actor).toBe('alice@example.com');
      expect(next).toHaveBeenCalledOnce();
    });

    it('falls back to sub for actor when email is absent', () => {
      const jwt = makeJwt({
        sub: 'user-uuid',
        app_metadata: { org_id: 'org-abc' },
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(req.orgId).toBe('org-abc');
      expect(req.actor).toBe('user-uuid');
      expect(next).toHaveBeenCalledOnce();
    });

    it('uses sub for both orgId and actor when only sub is present', () => {
      const jwt = makeJwt({ sub: 'user-uuid' });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(req.orgId).toBe('user-uuid');
      expect(req.actor).toBe('user-uuid');
      expect(next).toHaveBeenCalledOnce();
    });

    it('attaches orgId and actor to the request object', () => {
      const jwt = makeJwt({
        sub: 'sub-id',
        email: 'bob@example.com',
        app_metadata: { org_id: 'org-xyz' },
      });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(req).toHaveProperty('orgId', 'org-xyz');
      expect(req).toHaveProperty('actor', 'bob@example.com');
    });

    it('calls next() on success', () => {
      const jwt = makeJwt({ sub: 'user-uuid', email: 'user@example.com', app_metadata: { org_id: 'org-1' } });
      const req = mockReq({ authorization: `Bearer ${jwt}` });
      const res = mockRes();

      authMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });
  });
});
