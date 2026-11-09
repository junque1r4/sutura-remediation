import 'server-only';
import { query } from '@/lib/db';
import type { Role } from './permissions';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, password_hash,
            email_verified_at, last_login_at, created_at
       FROM users
      WHERE email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, password_hash,
            email_verified_at, last_login_at, created_at
       FROM users
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  emailVerified?: boolean;
}): Promise<UserRow> {
  const result = await query<UserRow>(
    `INSERT INTO users (email, password_hash, email_verified_at)
     VALUES ($1, $2, $3)
     RETURNING id, email, password_hash,
               email_verified_at, last_login_at, created_at`,
    [
      input.email,
      input.passwordHash,
      input.emailVerified ? new Date() : null,
    ],
  );
  return result.rows[0];
}

export async function recordLoginSuccess(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET last_login_at = now()
      WHERE id = $1`,
    [userId],
  );
}

export async function updatePasswordHash(userId: string, hash: string): Promise<void> {
  await query(
    `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
    [hash, userId],
  );
}

export interface MembershipRow {
  id: string;
  user_id: string;
  org_id: string;
  role: Role;
  org_name: string;
}

export async function listMembershipsForUser(userId: string): Promise<MembershipRow[]> {
  const result = await query<MembershipRow>(
    `SELECT m.id, m.user_id, m.org_id, m.role, o.name AS org_name
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY m.joined_at ASC`,
    [userId],
  );
  return result.rows;
}

export async function getMembership(
  userId: string,
  orgId: string,
): Promise<MembershipRow | null> {
  const result = await query<MembershipRow>(
    `SELECT m.id, m.user_id, m.org_id, m.role, o.name AS org_name
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id = $2`,
    [userId, orgId],
  );
  return result.rows[0] ?? null;
}

export async function createMembership(input: {
  userId: string;
  orgId: string;
  role: Role;
  invitedBy?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO memberships (user_id, org_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [input.userId, input.orgId, input.role, input.invitedBy ?? null],
  );
}

export interface OrgMemberRow {
  user_id: string;
  email: string;
  role: Role;
  joined_at: Date;
  invited_by_email: string | null;
  last_login_at: Date | null;
  email_verified_at: Date | null;
}

export async function listMembersForOrg(orgId: string): Promise<OrgMemberRow[]> {
  const result = await query<OrgMemberRow>(
    `SELECT u.id AS user_id, u.email, m.role, m.joined_at,
            ib.email AS invited_by_email,
            u.last_login_at, u.email_verified_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN users ib ON ib.id = m.invited_by
      WHERE m.org_id = $1
      ORDER BY m.joined_at ASC`,
    [orgId],
  );
  return result.rows;
}

export interface MemberDetail {
  userId: string;
  email: string;
  role: Role;
  joinedAt: Date;
  invitedByEmail: string | null;
  lastLoginAt: Date | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  activeSessionCount: number;
}

interface MemberDetailRow {
  user_id: string;
  email: string;
  role: Role;
  joined_at: Date;
  invited_by_email: string | null;
  last_login_at: Date | null;
  email_verified_at: Date | null;
  created_at: Date;
  active_session_count: string;
}

export async function getMemberDetail(
  userId: string,
  orgId: string,
): Promise<MemberDetail | null> {
  const result = await query<MemberDetailRow>(
    `SELECT u.id AS user_id, u.email, m.role, m.joined_at,
            ib.email AS invited_by_email,
            u.last_login_at, u.email_verified_at, u.created_at,
            (SELECT COUNT(*)::text FROM user_sessions s
              WHERE s.user_id = u.id
                AND s.revoked_at IS NULL
                AND s.expires_at > now()) AS active_session_count
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN users ib ON ib.id = m.invited_by
      WHERE m.user_id = $1 AND m.org_id = $2`,
    [userId, orgId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    joinedAt: row.joined_at,
    invitedByEmail: row.invited_by_email,
    lastLoginAt: row.last_login_at,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    activeSessionCount: Number(row.active_session_count ?? '0'),
  };
}

export async function updateMembershipRole(
  userId: string,
  orgId: string,
  role: Role,
): Promise<boolean> {
  const result = await query(
    `UPDATE memberships SET role = $1 WHERE user_id = $2 AND org_id = $3`,
    [role, userId, orgId],
  );
  return result.rowCount > 0;
}

export async function removeMembership(userId: string, orgId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM memberships WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId],
  );
  return result.rowCount > 0;
}

export async function countOwners(orgId: string): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`,
    [orgId],
  );
  return Number(result.rows[0]?.n ?? '0');
}
