import type { OrganizationSettings, CustomPrompts, GitHubIntegration } from '@sutura/common';
import { getPool } from './client';
import type { DbOrganization, CreateOrgInput } from './types';

const DEFAULT_PLAN = 'pilot';

let _singletonOrgId: string | null = null;

/**
 * Resolve the id of the single organization row. Sutura is single-tenant, so
 * there must be exactly one organization. Asserts that invariant (throws if
 * zero or more than one rows exist) and memoizes the result (the org row is
 * immutable for the lifetime of the process). Used for fail-fast at boot and
 * as the trusted org identity for origin-authenticated webhooks.
 */
export async function getSingletonOrgId(): Promise<string> {
  if (_singletonOrgId) return _singletonOrgId;
  const pool = getPool();
  const { rows } = await pool.query('SELECT id FROM organizations LIMIT 2');
  if (rows.length !== 1) {
    throw new Error(
      `Single-tenant invariant violated: expected exactly 1 organization, found ${rows.length}`,
    );
  }
  _singletonOrgId = (rows[0] as { id: string }).id;
  return _singletonOrgId;
}

/**
 * Fetch a single organization by its UUID. Returns null if not found.
 */
export async function getOrganization(id: string): Promise<DbOrganization | null> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [id]);
  return (rows[0] as DbOrganization) ?? null;
}

/**
 * Create a new organization. Defaults plan to 'pilot' if not provided.
 */
export async function createOrganization(input: CreateOrgInput): Promise<DbOrganization> {
  const pool = getPool();
  const { rows } = await pool.query(
    'INSERT INTO organizations (name, plan) VALUES ($1, $2) RETURNING *',
    [input.name, input.plan ?? DEFAULT_PLAN],
  );
  return rows[0] as DbOrganization;
}

/**
 * Update the settings_json column for an organization.
 */
export async function updateSettings(
  id: string,
  settings: OrganizationSettings,
): Promise<DbOrganization> {
  const pool = getPool();
  const { rows } = await pool.query(
    'UPDATE organizations SET settings_json = $1 WHERE id = $2 RETURNING *',
    [JSON.stringify(settings), id],
  );
  return rows[0] as DbOrganization;
}

/**
 * Persist (or clear) the GitHub installation record under
 * settings_json.integrations.github, read-modify-writing the existing settings
 * so unrelated keys are preserved. This mirrors the dashboard's
 * saveInstallationToOrg/clearInstallationFromOrg but runs server-side so the
 * GitHub `installation` webhook can keep the DB in sync without a round-trip
 * through the dashboard. Pass `null` to clear the record (uninstall).
 */
export async function setGithubIntegration(
  id: string,
  github: GitHubIntegration | null,
): Promise<DbOrganization> {
  const pool = getPool();
  const org = await getOrganization(id);
  if (!org) {
    throw new Error(`Organization ${id} not found`);
  }
  const currentSettings = (org.settings_json ?? {}) as unknown as Record<string, unknown>;
  const currentIntegrations = (currentSettings.integrations ?? {}) as Record<string, unknown>;
  const merged = {
    ...currentSettings,
    integrations: { ...currentIntegrations, github },
  };
  const { rows } = await pool.query(
    'UPDATE organizations SET settings_json = $1 WHERE id = $2 RETURNING *',
    [JSON.stringify(merged), id],
  );
  return rows[0] as DbOrganization;
}

/**
 * Update the custom_prompts_json column for an organization.
 */
export async function updateCustomPrompts(
  id: string,
  prompts: CustomPrompts,
): Promise<DbOrganization> {
  const pool = getPool();
  const { rows } = await pool.query(
    'UPDATE organizations SET custom_prompts_json = $1 WHERE id = $2 RETURNING *',
    [JSON.stringify(prompts), id],
  );
  return rows[0] as DbOrganization;
}
