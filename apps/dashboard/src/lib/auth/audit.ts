import 'server-only';
import { query } from '@/lib/db';

interface AuditInput {
  orgId: string;
  userId: string;
  actor: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface AuditRow {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata_json: Record<string, unknown> | null;
  created_at: Date;
}

export async function listAuditForUserInOrg(
  userId: string,
  orgId: string,
  opts: { limit?: number } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const result = await query<AuditRow>(
    `SELECT id, action, resource_type, resource_id, metadata_json, created_at
       FROM audit_log
      WHERE user_id = $1 AND org_id = $2
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    [userId, orgId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata_json ?? {},
    createdAt: r.created_at,
  }));
}

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (org_id, user_id, actor, action, resource_type, resource_id, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.orgId,
        input.userId,
        input.actor,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    // Audit writes should never block the user request.
    console.error('[audit] write failed', err);
  }
}
