import 'server-only';

export interface OsvQuery {
  ecosystem: string;
  name: string;
  version: string;
}

export interface OsvVuln {
  id: string;
  severity: string | null;
  summary: string | null;
  fixedVersions: string[];
  detailsUrl: string | null;
}

export interface OsvResult extends OsvQuery {
  vulns: OsvVuln[];
}

const BATCH_SIZE = 1000;
const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns';

// Map of purl prefixes -> OSV ecosystem identifiers.
// https://google.github.io/osv.dev/data/#supported-ecosystems
const PURL_TO_OSV: Array<[RegExp, string]> = [
  [/^pkg:npm\//, 'npm'],
  [/^pkg:pypi\//, 'PyPI'],
  [/^pkg:maven\//, 'Maven'],
  [/^pkg:gem\//, 'RubyGems'],
  [/^pkg:golang\//, 'Go'],
  [/^pkg:cargo\//, 'crates.io'],
  [/^pkg:nuget\//, 'NuGet'],
  [/^pkg:composer\//, 'Packagist'],
  [/^pkg:hex\//, 'Hex'],
  [/^pkg:pub\//, 'Pub'],
  [/^pkg:cocoapods\//, 'CocoaPods'],
  [/^pkg:swift\//, 'SwiftURL'],
];

export function ecosystemFromPurl(purl: string | null | undefined): string | null {
  if (!purl) return null;
  for (const [regex, eco] of PURL_TO_OSV) {
    if (regex.test(purl)) return eco;
  }
  return null;
}

interface OsvBatchResponse {
  results: Array<{
    vulns?: Array<{ id: string; modified?: string }>;
  }>;
}

interface OsvVulnDetail {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    ranges?: Array<{
      events?: Array<{ fixed?: string }>;
    }>;
  }>;
}

// Severity normalization: OSV exposes severity via database_specific.severity
// ("CRITICAL"/"HIGH"/"MODERATE"/"LOW") on GHSAs, otherwise a CVSS vector.
function normalizeSeverity(detail: OsvVulnDetail): string | null {
  const dbSev = detail.database_specific?.severity?.toLowerCase();
  if (dbSev === 'critical') return 'critical';
  if (dbSev === 'high') return 'high';
  if (dbSev === 'moderate' || dbSev === 'medium') return 'medium';
  if (dbSev === 'low') return 'low';
  const cvss = detail.severity?.find((s) => s.type?.startsWith('CVSS'));
  if (cvss?.score) return cvss.score;
  return null;
}

function collectFixedVersions(detail: OsvVulnDetail): string[] {
  const out = new Set<string>();
  for (const a of detail.affected ?? []) {
    for (const r of a.ranges ?? []) {
      for (const ev of r.events ?? []) {
        if (ev.fixed) out.add(ev.fixed);
      }
    }
  }
  return Array.from(out);
}

function detailsUrlFor(id: string): string {
  if (id.startsWith('GHSA-')) return `https://github.com/advisories/${id}`;
  if (id.startsWith('CVE-')) return `https://nvd.nist.gov/vuln/detail/${id}`;
  return `https://osv.dev/vulnerability/${id}`;
}

async function fetchVulnDetail(id: string): Promise<OsvVulnDetail | null> {
  try {
    const res = await fetch(`${OSV_VULN_URL}/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return (await res.json()) as OsvVulnDetail;
  } catch {
    return null;
  }
}

async function batchChunk(queries: OsvQuery[]): Promise<OsvResult[]> {
  const res = await fetch(OSV_BATCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: queries.map((q) => ({
        package: { name: q.name, ecosystem: q.ecosystem },
        version: q.version,
      })),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OSV querybatch failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as OsvBatchResponse;

  // Collect distinct vuln IDs across all queries, fetch detail once each,
  // then map back to each (ecosystem, name, version) query.
  const distinctIds = new Set<string>();
  for (const r of data.results ?? []) {
    for (const v of r.vulns ?? []) distinctIds.add(v.id);
  }

  const detailById = new Map<string, OsvVulnDetail>();
  await Promise.all(
    Array.from(distinctIds).map(async (id) => {
      const d = await fetchVulnDetail(id);
      if (d) detailById.set(id, d);
    }),
  );

  return queries.map((q, i) => {
    const hit = data.results?.[i];
    const vulns: OsvVuln[] = (hit?.vulns ?? []).map((v) => {
      const d = detailById.get(v.id);
      return {
        id: v.id,
        severity: d ? normalizeSeverity(d) : null,
        summary: d?.summary ?? null,
        fixedVersions: d ? collectFixedVersions(d) : [],
        detailsUrl: detailsUrlFor(v.id),
      };
    });
    return { ...q, vulns };
  });
}

export async function osvBatchQuery(queries: OsvQuery[]): Promise<OsvResult[]> {
  const out: OsvResult[] = [];
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const chunk = queries.slice(i, i + BATCH_SIZE);
    const part = await batchChunk(chunk);
    out.push(...part);
  }
  return out;
}
