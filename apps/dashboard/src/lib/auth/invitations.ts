import 'server-only';
import { query } from '@/lib/db';
import { generateToken, hashToken } from './tokens';
import type { Role } from './permissions';

const INVITATION_TTL_DAYS = 7;

export interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
  org_name?: string;
  inviter_email?: string;
}

export async function createInvitation(input: {
  orgId: string;
  email: string;
  role: Role;
  invitedBy: string;
}): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = generateToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const result = await query<{ id: string }>(
    `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.orgId,
      input.email.toLowerCase(),
      input.role,
      tokenHash,
      input.invitedBy,
      expiresAt,
    ],
  );
  return { id: result.rows[0].id, token, expiresAt };
}

export async function getInvitationByToken(token: string): Promise<InvitationRow | null> {
  const hash = hashToken(token);
  const result = await query<InvitationRow>(
    `SELECT i.id, i.org_id, i.email, i.role, i.invited_by,
            i.expires_at, i.accepted_at, i.created_at,
            o.name AS org_name,
            u.email AS inviter_email
       FROM invitations i
       JOIN organizations o ON o.id = i.org_id
       JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1
        AND i.accepted_at IS NULL
        AND i.expires_at > now()
      LIMIT 1`,
    [hash],
  );
  return result.rows[0] ?? null;
}

export async function markInvitationAccepted(id: string): Promise<void> {
  await query(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [id]);
}

export async function listInvitationsForOrg(orgId: string): Promise<InvitationRow[]> {
  const result = await query<InvitationRow>(
    `SELECT i.id, i.org_id, i.email, i.role, i.invited_by,
            i.expires_at, i.accepted_at, i.created_at,
            u.email AS inviter_email
       FROM invitations i
       JOIN users u ON u.id = i.invited_by
      WHERE i.org_id = $1
        AND i.accepted_at IS NULL
        AND i.expires_at > now()
      ORDER BY i.created_at DESC`,
    [orgId],
  );
  return result.rows;
}

export async function revokeInvitation(id: string, orgId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM invitations WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  return result.rowCount > 0;
}

/**
 * Regenerate the token + expiry of an existing invitation. Returns the new
 * token (caller emails it) and updated row, or null if the invitation no
 * longer exists for this org or has already been accepted.
 */
export async function resendInvitation(
  id: string,
  orgId: string,
): Promise<{ token: string; row: InvitationRow } | null> {
  const token = generateToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const result = await query<InvitationRow>(
    `UPDATE invitations
        SET token_hash = $1, expires_at = $2
      WHERE id = $3 AND org_id = $4 AND accepted_at IS NULL
      RETURNING id, org_id, email, role, invited_by,
                expires_at, accepted_at, created_at`,
    [tokenHash, expiresAt, id, orgId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { token, row };
}
