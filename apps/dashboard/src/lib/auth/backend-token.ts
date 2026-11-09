import 'server-only';
import { createHmac } from 'crypto';

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set');
  return secret;
}

export interface BackendTokenClaims {
  sub: string; // user id
  email: string;
  org_id: string;
  role: string;
}

export function signBackendToken(claims: BackendTokenClaims): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      sub: claims.sub,
      email: claims.email,
      app_metadata: { org_id: claims.org_id, role: claims.role },
      iat: now,
      // 5 minute expiry -- this is regenerated per request.
      exp: now + 5 * 60,
    }),
  );
  const data = `${header}.${payload}`;
  const sig = base64url(createHmac('sha256', getSecret()).update(data).digest());
  return `${data}.${sig}`;
}
