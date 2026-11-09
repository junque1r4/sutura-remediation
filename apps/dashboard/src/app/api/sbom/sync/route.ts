import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/lib/auth/server';
import { getValidAikidoToken } from '@/lib/aikido';
import { getConnectionSecretWithToken } from '@/lib/connections-client.server';
import { query } from '@/lib/db';
import {
  listAikidoCodeRepos,
  fetchRepoSbom,
  parseSbom,
  upsertComponents,
  refreshVulnsForOrg,
  mapWithConcurrency,
} from '@/lib/sbom';

export const runtime = 'nodejs';
// Aikido fan-out + OSV cross-ref can take a while on large orgs.
export const maxDuration = 300;

interface SyncRunRow {
  id: string;
}

export async function POST(): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.activeOrgId;
  if (!orgId) {
    return NextResponse.json({ error: 'No active organization' }, { status: 400 });
  }

  // Insert the run row up-front so the UI can poll progress.
  const runInsert = await query<SyncRunRow>(
    `INSERT INTO sbom_sync_runs (org_id, status) VALUES ($1, 'running') RETURNING id::text AS id`,
    [orgId],
  );
  const runId = runInsert.rows[0].id;

  let accessToken: string;
  try {
    const secret = await getConnectionSecretWithToken('aikido', {
      userId: session.user.id,
      email: session.user.email,
      orgId,
      role: session.membership?.role ?? 'viewer',
    });
    if (!secret) {
      throw new Error('Aikido is not connected');
    }
    const [clientId, clientSecret] = secret.secret.split(':');
    accessToken = await getValidAikidoToken(clientId, clientSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Aikido auth failed';
    await query(
      `UPDATE sbom_sync_runs
         SET status = 'error', finished_at = now(), error_message = $2
       WHERE id = $1`,
      [runId, message],
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }

  let repos: Awaited<ReturnType<typeof listAikidoCodeRepos>>;
  try {
    repos = await listAikidoCodeRepos(accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list Aikido repos';
    await query(
      `UPDATE sbom_sync_runs
         SET status = 'error', finished_at = now(), error_message = $2
       WHERE id = $1`,
      [runId, message],
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }

  let reposSynced = 0;
  let reposFailed = 0;
  let componentsUpserted = 0;

  await mapWithConcurrency(repos, 4, async (repo) => {
    try {
      const sbom = await fetchRepoSbom(accessToken, repo.id);
      const components = parseSbom(sbom);
      const upserted = await upsertComponents(orgId, String(repo.id), repo.name, components);
      reposSynced++;
      componentsUpserted += upserted;
    } catch (err) {
      reposFailed++;
      console.error(`[SBOM sync] repo ${repo.id} (${repo.name}) failed:`, err);
    }
  });

  let vulnsFound = 0;
  try {
    vulnsFound = await refreshVulnsForOrg(orgId);
  } catch (err) {
    console.error('[SBOM sync] OSV cross-ref failed:', err);
    // Don't fail the whole run; we still ingested the SBOM successfully.
  }

  await query(
    `UPDATE sbom_sync_runs
       SET status = 'success',
           finished_at = now(),
           repos_synced = $2,
           repos_failed = $3,
           components_upserted = $4,
           vulns_found = $5
     WHERE id = $1`,
    [runId, reposSynced, reposFailed, componentsUpserted, vulnsFound],
  );

  return NextResponse.json({
    runId,
    reposSynced,
    reposFailed,
    componentsUpserted,
    vulnsFound,
  });
}

interface LatestRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  repos_synced: number;
  repos_failed: number;
  components_upserted: number;
  vulns_found: number;
  error_message: string | null;
}

export async function GET(): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.activeOrgId;
  if (!orgId) return NextResponse.json({ lastRun: null });

  const { rows } = await query<LatestRunRow>(
    `SELECT id::text, status, started_at, finished_at,
            repos_synced, repos_failed, components_upserted, vulns_found, error_message
       FROM sbom_sync_runs
      WHERE org_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [orgId],
  );

  return NextResponse.json({ lastRun: rows[0] ?? null });
}
