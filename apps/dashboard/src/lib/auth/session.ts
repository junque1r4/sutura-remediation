import 'server-only';
import { query } from '@/lib/db';
import { generateToken, hashToken } from './tokens';
import type { Role } from './permissions';

const SESSION_COOKIE = 'sutura_session';
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
}

export interface SessionMembership {
  orgId: string;
  orgName: string;
  role: Role;
}

export interface ActiveSession {
  id: string;
  user: SessionUser;
  activeOrgId: string | null;
  membership: SessionMembership | null;
  expiresAt: Date;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getSessionCookieOptions(maxAgeMs = SESSION_TTL_MS): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

interface CreateSessionInput {
  userId: string;
  activeOrgId?: string | null;
  userAgent?: string | null;
  ip?: string | null;
}

export async function createSession(
  input: CreateSessionInput,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken(32);
  const id = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO user_sessions (id, user_id, active_org_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.userId,
      input.activeOrgId ?? null,
      input.userAgent ?? null,
      input.ip ?? null,
      expiresAt,
    ],
  );
  return { token, expiresAt };
}

interface SessionRow {
  id: string;
  user_id: string;
  active_org_id: string | null;
  expires_at: Date;
  email: string;
  org_name: string | null;
  role: string | null;
}

export async function validateSessionToken(token: string): Promise<ActiveSession | null> {
  if (!token) return null;
  const id = hashToken(token);
  const result = await query<SessionRow>(
    `SELECT s.id, s.user_id, s.active_org_id, s.expires_at,
            u.email,
            o.name AS org_name,
            m.role
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = s.user_id
                              AND m.org_id = s.active_org_id
       LEFT JOIN organizations o ON o.id = s.active_org_id
      WHERE s.id = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;

  // Bump last_active_at no more than once per minute to avoid hammering the DB.
  void query(
    `UPDATE user_sessions
        SET last_active_at = now()
      WHERE id = $1
        AND last_active_at < now() - INTERVAL '1 minute'`,
    [id],
  ).catch(() => {});

  return {
    id: row.id,
    user: { id: row.user_id, email: row.email },
    activeOrgId: row.active_org_id,
    membership:
      row.active_org_id && row.role && row.org_name
        ? { orgId: row.active_org_id, orgName: row.org_name, role: row.role as Role }
        : null,
    expiresAt: row.expires_at,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query(`UPDATE user_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
}

export async function revokeSessionByToken(token: string): Promise<void> {
  if (!token) return;
  await revokeSession(hashToken(token));
}

/**
 * Admin variant: list sessions for any user who shares an organization with
 * the caller. Returns null if the target is not a member of `callerOrgId`
 * (treated as "not found" by the route to avoid leaking existence).
 */
export async function listSessionsForUserAsAdmin(
  targetUserId: string,
  callerOrgId: string,
): Promise<
  | Array<{
      id: string;
      userAgent: string | null;
      ip: string | null;
      createdAt: Date;
      lastActiveAt: Date;
      expiresAt: Date;
    }>
  | null
> {
  const membership = await query<{ id: string }>(
    `SELECT id FROM memberships WHERE user_id = $1 AND org_id = $2 LIMIT 1`,
    [targetUserId, callerOrgId],
  );
  if (membership.rowCount === 0) return null;
  return listSessionsForUser(targetUserId);
}

export async function listSessionsForUser(userId: string): Promise<
  Array<{
    id: string;
    userAgent: string | null;
    ip: string | null;
    createdAt: Date;
    lastActiveAt: Date;
    expiresAt: Date;
    current: boolean;
  }>
> {
  const result = await query<{
    id: string;
    user_agent: string | null;
    ip: string | null;
    created_at: Date;
    last_active_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, user_agent, ip, created_at, last_active_at, expires_at
       FROM user_sessions
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY last_active_at DESC`,
    [userId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    expiresAt: r.expires_at,
    current: false,
  }));
}
