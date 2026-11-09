import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentSession } from '@/lib/auth/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

interface MatchRow {
  package_name: string;
  version: string;
  ecosystem: string | null;
  repo_aikido_id: string;
  repo_name: string;
  vuln_count: number;
}

interface LookupBody {
  names?: unknown;
}

function parseNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Strip a leading "@" only when followed by a path (npm scoped) — but the
    // user may also paste "lodash@4.17.20"; split on the last "@" when version
    // is appended. Keep both forms searchable.
    out.add(trimmed.toLowerCase());
  }
  return Array.from(out);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.activeOrgId;
  if (!orgId) return NextResponse.json({ matches: {} });

  let body: LookupBody;
  try {
    body = (await req.json()) as LookupBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const names = parseNames(body.names);
  if (names.length === 0) {
    return NextResponse.json({ matches: {} });
  }

  // Match exact (case-insensitive) on package_name. Also match against the
  // last "/"-segment so a user pasting just "lodash" hits scoped variants
  // like "@types/lodash" only via explicit exact match (not partial).
  const { rows } = await query<MatchRow>(
    `SELECT
       c.package_name,
       c.version,
       c.ecosystem,
       c.repo_aikido_id,
       c.repo_name,
       count(v.id)::int AS vuln_count
     FROM sbom_components c
     LEFT JOIN sbom_vulnerabilities v ON v.component_id = c.id
     WHERE c.org_id = $1
       AND lower(c.package_name) = ANY($2::text[])
     GROUP BY c.package_name, c.version, c.ecosystem, c.repo_aikido_id, c.repo_name
     ORDER BY c.package_name, c.version, c.repo_name`,
    [orgId, names],
  );

  // Group results by the lowercased package_name so the caller can render one
  // section per searched term and surface "not found" entries.
  const matches: Record<
    string,
    Array<{
      packageName: string;
      version: string;
      ecosystem: string | null;
      repoAikidoId: string;
      repoName: string;
      vulnCount: number;
    }>
  > = {};
  for (const term of names) matches[term] = [];

  for (const r of rows) {
    const key = r.package_name.toLowerCase();
    if (!matches[key]) matches[key] = [];
    matches[key].push({
      packageName: r.package_name,
      version: r.version,
      ecosystem: r.ecosystem,
      repoAikidoId: r.repo_aikido_id,
      repoName: r.repo_name,
      vulnCount: r.vuln_count,
    });
  }

  return NextResponse.json({ matches });
}
