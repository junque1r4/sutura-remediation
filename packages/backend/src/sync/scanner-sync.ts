import { getConnection, getConnectionSecret } from '../db/connections';
import { upsertFindings } from '../db/findings';
import { AikidoAdapter } from '../adapters/scanners/aikido/aikido-adapter';
import { SnykAdapter } from '../adapters/scanners/snyk/snyk-adapter';
import type { ScannerConfig } from '../adapters/scanners/scanner-adapter';

export type SyncProvider = 'aikido' | 'snyk';

export const SYNC_PROVIDERS: readonly SyncProvider[] = ['aikido', 'snyk'];

export function isSyncProvider(value: string): value is SyncProvider {
  return (SYNC_PROVIDERS as readonly string[]).includes(value);
}

export interface SyncResult {
  provider: string;
  fetched: number;
  upserted: number;
  skipped?: boolean;
  error?: string;
}

// Snyk exposes regional API hosts; map the stored region to its base URL.
// Unknown / 'us' / absent falls back to the adapter's default (api.snyk.io).
const SNYK_REGION_BASE_URLS: Record<string, string> = {
  eu: 'https://api.eu.snyk.io',
  au: 'https://api.au.snyk.io',
};

/**
 * Assemble the ScannerConfig for a connected provider, or null when the
 * provider is not connected (no secret). For aikido the secret is the combined
 * "clientId:clientSecret" string and orgId is unused by the adapter. For snyk
 * the secret is the API token and the Snyk org id / region live in the
 * connection's metadata_json (see the dashboard snyk/connect route).
 */
async function buildConfig(orgId: string, provider: SyncProvider): Promise<ScannerConfig | null> {
  const secret = await getConnectionSecret(orgId, provider);
  if (!secret) return null;

  if (provider === 'aikido') {
    return { apiKey: secret, orgId: '' };
  }

  // snyk: read non-secret config (snyk org id / region) from metadata_json.
  const connection = await getConnection(orgId, provider);
  const metadata = connection?.metadata_json ?? {};
  const snykOrgId = typeof metadata.orgId === 'string' ? metadata.orgId : '';
  const region = typeof metadata.region === 'string' ? metadata.region : '';
  return {
    apiKey: secret,
    orgId: snykOrgId,
    baseUrl: SNYK_REGION_BASE_URLS[region],
  };
}

function getAdapter(provider: SyncProvider) {
  return provider === 'aikido' ? new AikidoAdapter() : new SnykAdapter();
}

/**
 * Pull issues from one connected scanner and upsert them into the findings
 * table. A not-connected provider yields a skipped result (no throw). Any
 * fetch/upsert error is captured into SyncResult.error so a single bad scanner
 * never aborts a multi-provider syncAll.
 */
export async function syncProvider(orgId: string, provider: SyncProvider): Promise<SyncResult> {
  try {
    const config = await buildConfig(orgId, provider);
    if (!config) {
      return { provider, fetched: 0, upserted: 0, skipped: true };
    }
    const findings = await getAdapter(provider).fetchFindings(config);
    const upserted = await upsertFindings(orgId, findings);
    return { provider, fetched: findings.length, upserted: upserted.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { provider, fetched: 0, upserted: 0, error };
  }
}

/**
 * Sync every supported scanner for the org. Not-connected scanners are skipped
 * and a failing scanner is isolated to its own result.
 */
export async function syncAll(orgId: string): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const provider of SYNC_PROVIDERS) {
    results.push(await syncProvider(orgId, provider));
  }
  return results;
}
