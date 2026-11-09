import { getPool } from './client';
import { encryptSecret, decryptSecret } from '../lib/secret-encryption';
import {
  validateSerializedToolchain,
  REPO_PROMPT_MAX_LENGTH,
  type SerializedToolchain,
  type RepoPromptStatus,
  type RepoToolchainCheckResult,
  type RepoToolchainStatus,
} from '@sutura/common';

const PREVIEW_LEN = 80;

function buildPreview(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? '';
  return firstLine.length > PREVIEW_LEN ? `${firstLine.slice(0, PREVIEW_LEN)}…` : firstLine;
}

export async function upsertRepoPrompt(input: {
  orgId: string;
  repo: string;
  kind: 'test_environment';
  prompt: string;
  createdBy?: string;
}): Promise<RepoPromptStatus> {
  if (input.prompt.length === 0 || input.prompt.length > REPO_PROMPT_MAX_LENGTH) {
    throw new Error(`prompt must be 1..${REPO_PROMPT_MAX_LENGTH} characters`);
  }
  const { rows } = await getPool().query(
    `INSERT INTO repo_prompts (org_id, repo, kind, encrypted_prompt, prompt_preview, prompt_length, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id, repo, kind) DO UPDATE
       SET encrypted_prompt = EXCLUDED.encrypted_prompt,
           prompt_preview = EXCLUDED.prompt_preview,
           prompt_length = EXCLUDED.prompt_length,
           created_by = EXCLUDED.created_by,
           updated_at = now()
     RETURNING repo, kind, prompt_preview, prompt_length, updated_at`,
    [input.orgId, input.repo, input.kind, encryptSecret(input.prompt), buildPreview(input.prompt), input.prompt.length, input.createdBy ?? null],
  );
  return rowToStatus(rows[0]);
}

/** Public mapper: deliberately never touches encrypted_prompt. */
function rowToStatus(row: Record<string, unknown>): RepoPromptStatus {
  return {
    repo: String(row.repo),
    kind: 'test_environment',
    hasPrompt: true,
    preview: String(row.prompt_preview ?? ''),
    promptLength: Number(row.prompt_length ?? 0),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

export async function listRepoPrompts(orgId: string): Promise<RepoPromptStatus[]> {
  const { rows } = await getPool().query(
    `SELECT repo, kind, prompt_preview, prompt_length, updated_at
       FROM repo_prompts WHERE org_id = $1 ORDER BY repo`,
    [orgId],
  );
  return rows.map(rowToStatus);
}

/** Worker/check-route only: returns the decrypted prompt. NEVER expose via API. */
export async function getRepoPromptSecret(
  orgId: string,
  repo: string,
  kind: 'test_environment',
): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT encrypted_prompt FROM repo_prompts WHERE org_id = $1 AND repo = $2 AND kind = $3`,
    [orgId, repo, kind],
  );
  if (rows.length === 0) return null;
  return decryptSecret(String(rows[0].encrypted_prompt));
}

export async function deleteRepoPrompt(orgId: string, repo: string, kind: 'test_environment'): Promise<void> {
  await getPool().query(`DELETE FROM repo_prompts WHERE org_id = $1 AND repo = $2 AND kind = $3`, [orgId, repo, kind]);
  // A derived toolchain without its source prompt is stale -- downgrade.
  await getPool().query(
    `UPDATE repo_toolchain_checks
        SET status = 'needs_prompt', derived_config_encrypted = NULL, detail = 'prompt deleted', checked_at = now()
      WHERE org_id = $1 AND repo = $2 AND status = 'custom_ready'`,
    [orgId, repo],
  );
}

export async function upsertToolchainCheck(input: {
  orgId: string;
  repo: string;
  status: RepoToolchainStatus;
  language?: string | null;
  testFramework?: string | null;
  derivedConfig?: SerializedToolchain | null;
  detail?: string | null;
}): Promise<RepoToolchainCheckResult> {
  const encrypted = input.derivedConfig ? encryptSecret(JSON.stringify(input.derivedConfig)) : null;
  const { rows } = await getPool().query(
    `INSERT INTO repo_toolchain_checks (org_id, repo, status, language, test_framework, derived_config_encrypted, detail, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (org_id, repo) DO UPDATE
       SET status = EXCLUDED.status, language = EXCLUDED.language, test_framework = EXCLUDED.test_framework,
           derived_config_encrypted = EXCLUDED.derived_config_encrypted, detail = EXCLUDED.detail, checked_at = now()
     RETURNING repo, status, language, test_framework, detail, checked_at`,
    [input.orgId, input.repo, input.status, input.language ?? null, input.testFramework ?? null, encrypted, input.detail ?? null],
  );
  return rowToCheckResult(rows[0]);
}

function rowToCheckResult(row: Record<string, unknown>): RepoToolchainCheckResult {
  return {
    repo: String(row.repo),
    status: row.status as RepoToolchainStatus,
    language: (row.language as string | null) ?? null,
    testFramework: (row.test_framework as string | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    checkedAt: String(row.checked_at),
  };
}

export async function listToolchainChecks(orgId: string): Promise<RepoToolchainCheckResult[]> {
  const { rows } = await getPool().query(
    `SELECT repo, status, language, test_framework, detail, checked_at
       FROM repo_toolchain_checks WHERE org_id = $1 ORDER BY repo`,
    [orgId],
  );
  return rows.map(rowToCheckResult);
}

/** Worker only: decrypt + re-validate the derived toolchain. Returns null when
 *  absent or invalid (tampered/stale rows must not reach the sandbox). */
export async function getDerivedToolchain(orgId: string, repo: string): Promise<SerializedToolchain | null> {
  const { rows } = await getPool().query(
    `SELECT derived_config_encrypted FROM repo_toolchain_checks
      WHERE org_id = $1 AND repo = $2 AND status = 'custom_ready'`,
    [orgId, repo],
  );
  const encrypted = rows[0]?.derived_config_encrypted;
  if (!encrypted) return null;
  try {
    return validateSerializedToolchain(JSON.parse(decryptSecret(String(encrypted))));
  } catch {
    return null;
  }
}
