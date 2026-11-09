import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { getConfig } from '../config';

export interface AuthenticatedRequest extends Request {
  orgId: string;
  actor: string;
  userId?: string;
}

interface JwtHeader {
  alg?: string;
  typ?: string;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
  app_metadata?: {
    org_id?: string;
    role?: string;
  };
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function verifyHs256(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(data).digest();
  const given = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

function decodeToken(token: string): { header: JwtHeader; payload: JwtPayload } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return {
      header: JSON.parse(base64UrlDecode(parts[0])) as JwtHeader,
      payload: JSON.parse(base64UrlDecode(parts[1])) as JwtPayload,
    };
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const decoded = decodeToken(token);

  if (!decoded) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const { header, payload } = decoded;
  const config = getConfig();

  // Default-deny: only HS256-signed tokens with a verified signature are
  // accepted. Unsigned (alg:none / missing alg) and any other algorithm are
  // rejected outright -- there is no compatibility path.
  if (header.alg !== 'HS256') {
    res.status(401).json({ error: 'Unsigned tokens are not accepted' });
    return;
  }
  if (!verifyHs256(token, config.JWT_SECRET)) {
    res.status(401).json({ error: 'Invalid token signature' });
    return;
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    res.status(401).json({ error: 'Token expired' });
    return;
  }

  // Identity is read ONLY from the verified payload claims.
  const orgId = payload.app_metadata?.org_id ?? payload.sub;
  const actor = payload.email ?? payload.sub;

  if (!orgId || !actor) {
    res.status(401).json({ error: 'Token missing required claims' });
    return;
  }

  const authed = req as AuthenticatedRequest;
  authed.orgId = orgId;
  authed.actor = actor;
  if (payload.sub && payload.email) {
    // HS256 path: sub is user id when email is also present.
    authed.userId = payload.sub;
  }

  next();
}
