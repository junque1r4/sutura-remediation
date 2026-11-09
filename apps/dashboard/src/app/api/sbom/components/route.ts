import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentSession } from '@/lib/auth/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

interface ComponentRow {
  package_name: string;
  version: string;
  ecosystem: string | null;
  purl: string | null;
  repo_count: number;
  vuln_count: number;
  max_severity: string | null;
}

interface KpiRow {
  total_components: string;
  unique_packages: string;
  vulnerable_components: string;
  repos_covered: string;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function rankSeverity(s: string | null): number {
  return s ? (SEVERITY_RANK[s.toLowerCase()] ?? 0) : 0;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.activeOrgId;
  if (!orgId) return NextResponse.json({ components: [], kpis: emptyKpis() });

  const url = new URL(req.url);
  const search = url.searchParams.get('search')?.trim() ?? '';
  const ecosystem = url.searchParams.get('ecosystem')?.trim() ?? '';
  const hasVuln = url.searchParams.get('has_vuln') === '1';
  const repo = url.searchParams.get('repo')?.trim() ?? '';
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 2000);

  // Aggregate by (package, version) across repos so a lib shared by N repos
  // shows up once with repo_count=N. Severity rank is computed in SQL via a
  // CASE so the client can sort/filter by max_severity.
  const conditions: string[] = ['c.org_id = $1'];
  const params: unknown[] = [orgId];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(`lower(c.package_name) LIKE $${params.length}`);
  }
  if (ecosystem) {
    params.push(ecosystem);
    conditions.push(`c.ecosystem = $${params.length}`);
  }
  if (repo) {
    params.push(repo);
    conditions.push(`c.repo_aikido_id = $${params.length}`);
  }

  params.push(limit);

  const sql = `
    WITH agg AS (
      SELECT
        c.package_name,
        c.version,
        max(c.ecosystem) AS ecosystem,
        max(c.purl)      AS purl,
        count(DISTINCT c.repo_aikido_id)::int AS repo_count,
        count(v.id)::int AS vuln_count,
        max(
          CASE lower(v.severity)
            WHEN 'critical' THEN 4
            WHEN 'high'     THEN 3
            WHEN 'medium'   THEN 2
            WHEN 'low'      THEN 1
            ELSE 0
          END
        ) AS sev_rank
      FROM sbom_components c
      LEFT JOIN sbom_vulnerabilities v ON v.component_id = c.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY c.package_name, c.version
    )
    SELECT
      package_name, version, ecosystem, purl, repo_count, vuln_count,
      CASE sev_rank
        WHEN 4 THEN 'critical'
        WHEN 3 THEN 'high'
        WHEN 2 THEN 'medium'
        WHEN 1 THEN 'low'
        ELSE NULL
      END AS max_severity
    FROM agg
    ${hasVuln ? 'WHERE vuln_count > 0' : ''}
    ORDER BY sev_rank DESC NULLS LAST, vuln_count DESC, package_name ASC
    LIMIT $${params.length}
  `;

  const components = await query<ComponentRow>(sql, params);

  const kpis = await query<KpiRow>(
    `SELECT
       count(*)::text                                          AS total_components,
       count(DISTINCT package_name)::text                      AS unique_packages,
       count(DISTINCT CASE WHEN v.id IS NOT NULL THEN c.id END)::text AS vulnerable_components,
       count(DISTINCT repo_aikido_id)::text                    AS repos_covered
     FROM sbom_components c
     LEFT JOIN sbom_vulnerabilities v ON v.component_id = c.id
     WHERE c.org_id = $1`,
    [orgId],
  );

  return NextResponse.json({
    components: components.rows.map((r) => ({
      packageName: r.package_name,
      version: r.version,
      ecosystem: r.ecosystem,
      purl: r.purl,
      repoCount: r.repo_count,
      vulnCount: r.vuln_count,
      maxSeverity: r.max_severity,
      severityRank: rankSeverity(r.max_severity),
    })),
    kpis: kpis.rows[0] ?? emptyKpis(),
  });
}

function emptyKpis(): KpiRow {
  return {
    total_components: '0',
    unique_packages: '0',
    vulnerable_components: '0',
    repos_covered: '0',
  };
}
