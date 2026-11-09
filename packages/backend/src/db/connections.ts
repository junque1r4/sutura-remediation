import { getPool } from './client';
import { decryptSecret } from '../lib/secret-encryption';

/**
 * Org-scoped integration connections (migration 015). One row per
 * (org_id, provider). The provider secret is stored encrypted-at-rest in
 * encrypted_secret (see routes/connections.ts -> encryptSecret); this module
 * NEVER decrypts or exposes it in the status mapper. Non-secret display/config
 * lives in masked_identifier + metadata_json.
 */

export type IntegrationProvider = 'anthropic' | 'snyk' | 'aikido';

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  'anthropic',
  'snyk',
  'aikido',
];

export function isIntegrationProvider(value: string): value is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

/** DB row (snake_case, matches the SQL schema). */
export interface DbIntegrationConnection {
  id: string;
  org_id: string;
  provider: IntegrationProvider;
  encrypted_secret: string;
  masked_identifier: string | null;
  metadata_json: Record<string, unknown>;
  connected_by: string | null;
  connected_at: string;
  updated_at: string;
}

export interface UpsertConnectionInput {
  org_id: string;
  provider: IntegrationProvider;
  /** Already-encrypted ("iv:ct:tag") secret. Callers encrypt before this layer. */
  encrypted_secret: string;
  masked_identifier?: string | null;
  metadata_json?: Record<string, unknown>;
  connected_by?: string | null;
}

/** Status shape returned to the dashboard. NEVER includes the secret. */
export interface ConnectionStatus {
  provider: IntegrationProvider;
  connected: true;
  maskedIdentifier: string | null;
  connectedAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Map a DB row to the safe status shape. Deliberately omits encrypted_secret so
 * it can never leak through list/get/status responses.
 */
export function dbConnectionToStatus(row: DbIntegrationConnection): ConnectionStatus {
  return {
    provider: row.provider,
    connected: true,
    maskedIdentifier: row.masked_identifier,
    connectedAt: row.connected_at,
    metadata: row.metadata_json ?? {},
  };
}

/** All configured connections for an org. */
export async function listConnections(orgId: string): Promise<DbIntegrationConnection[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM integration_connections WHERE org_id = $1 ORDER BY provider',
    [orgId],
  );
  return rows as DbIntegrationConnection[];
}

/** Single connection for an org+provider, or null. */
export async function getConnection(
  orgId: string,
  provider: IntegrationProvider,
): Promise<DbIntegrationConnection | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM integration_connections WHERE org_id = $1 AND provider = $2',
    [orgId, provider],
  );
  return (rows[0] as DbIntegrationConnection) ?? null;
}

/** Create or replace a connection (one per org+provider). */
export async function upsertConnection(
  input: UpsertConnectionInput,
): Promise<DbIntegrationConnection> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO integration_connections
       (org_id, provider, encrypted_secret, masked_identifier, metadata_json, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, provider) DO UPDATE SET
       encrypted_secret = EXCLUDED.encrypted_secret,
       masked_identifier = EXCLUDED.masked_identifier,
       metadata_json = EXCLUDED.metadata_json,
       connected_by = EXCLUDED.connected_by,
       updated_at = now()
     RETURNING *`,
    [
      input.org_id,
      input.provider,
      input.encrypted_secret,
      input.masked_identifier ?? null,
      JSON.stringify(input.metadata_json ?? {}),
      input.connected_by ?? null,
    ],
  );
  return rows[0] as DbIntegrationConnection;
}

/**
 * Resolve and DECRYPT the provider secret for an org directly from the DB,
 * for background workers that have no request cookie. Returns null when the
 * provider is not connected (or the stored value can't be decrypted into a
 * usable, non-empty secret -- treated as 'not configured'). The aikido secret
 * is the combined "clientId:clientSecret" string; callers split as needed.
 */
export async function getConnectionSecret(
  orgId: string,
  provider: IntegrationProvider,
): Promise<string | null> {
  const row = await getConnection(orgId, provider);
  if (!row) return null;
  const secret = decryptSecret(row.encrypted_secret);
  return secret && secret.length > 0 ? secret : null;
}

/** Remove a connection. Idempotent (no-op if nothing existed). */
export async function deleteConnection(
  orgId: string,
  provider: IntegrationProvider,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    'DELETE FROM integration_connections WHERE org_id = $1 AND provider = $2',
    [orgId, provider],
  );
}
