import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentSession } from '@/lib/auth/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

interface RepoRow {
  component_id: string;
  repo_aikido_id: string;
  repo_name: string;
  scope: string | null;
  last_seen_at: string;
}

interface VulnRow {
  osv_id: string;
  severity: string | null;
  summary: string | null;
  fixed_versions: string[];
  details_url: string | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.activeOrgId;
  if (!orgId) return NextResponse.json({ repos: [], vulns: [] });

  const url = new URL(req.url);
  const name = url.searchParams.get('name')?.trim();
  const version = url.searchParams.get('version')?.trim();
  if (!name || !version) {
    return NextResponse.json({ error: 'name and version required' }, { status: 400 });
  }

  const repos = await query<RepoRow>(
    `SELECT id::text AS component_id, repo_aikido_id, repo_name, scope, last_seen_at
       FROM sbom_components
      WHERE org_id = $1 AND package_name = $2 AND version = $3
      ORDER BY repo_name ASC`,
    [orgId, name, version],
  );

  if (repos.rows.length === 0) {
    return NextResponse.json({ repos: [], vulns: [] });
  }

  const componentIds = repos.rows.map((r) => r.component_id);
  const vulns = await query<VulnRow>(
    `SELECT DISTINCT osv_id, severity, summary, fixed_versions, details_url
       FROM sbom_vulnerabilities
      WHERE component_id = ANY($1::bigint[])
      ORDER BY osv_id ASC`,
    [componentIds],
  );

  return NextResponse.json({
    repos: repos.rows.map((r) => ({
      repoAikidoId: r.repo_aikido_id,
      repoName: r.repo_name,
      scope: r.scope,
      lastSeenAt: r.last_seen_at,
    })),
    vulns: vulns.rows.map((v) => ({
      osvId: v.osv_id,
      severity: v.severity,
      summary: v.summary,
      fixedVersions: v.fixed_versions,
      detailsUrl: v.details_url,
    })),
  });
}
