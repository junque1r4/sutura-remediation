import { NextResponse } from 'next/server';

import type { Finding } from '@/types';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';
import { getConnectionSecret } from '@/lib/connections-client.server';

const SNYK_API_BASE = 'https://api.snyk.io';

interface SnykApiIssue {
  id: string;
  attributes?: {
    title?: string;
    severity?: string;
    description?: string;
    status?: string;
    created_at?: string;
    coordinates?: Array<{
      representations?: Array<{
        dependency?: { package_name?: string; package_version?: string };
      }>;
    }>;
    problems?: Array<{
      id?: string;
      type?: string;
      source?: string;
    }>;
  };
}

function normalizeSeverity(severity?: string): Finding['severity'] {
  if (severity && ['critical', 'high', 'medium', 'low'].includes(severity)) {
    return severity as Finding['severity'];
  }
  return 'low';
}

function mapIssueToFinding(issue: SnykApiIssue, orgId: string): Finding {
  const attrs = issue.attributes ?? {};

  // Extract CVE/CWE from problems
  let cveId: string | null = null;
  let cweId: string | null = null;
  for (const problem of attrs.problems ?? []) {
    if (problem.id?.startsWith('CVE-')) cveId = problem.id;
    if (problem.id?.startsWith('CWE-')) cweId = problem.id;
  }

  // Extract package info from coordinates
  const firstCoord = attrs.coordinates?.[0];
  const firstRep = firstCoord?.representations?.[0];
  const dep = firstRep?.dependency;

  const title = attrs.title ?? `Snyk finding ${issue.id}`;
  const ingestedAt = attrs.created_at ?? new Date().toISOString();

  const status: Finding['status'] =
    attrs.status === 'resolved' ? 'fixed'
    : attrs.status === 'ignored' ? 'wont_fix'
    : 'open';

  return {
    id: `snyk-${issue.id}`,
    orgId,
    scannerSource: 'snyk',
    externalId: issue.id,
    title,
    description: attrs.description ?? null,
    severity: normalizeSeverity(attrs.severity),
    cvssScore: null,
    epssScore: null,
    cweId,
    cveId,
    filePath: null,
    lineRange: null,
    repo: dep?.package_name ?? 'unknown',
    status,
    ingestedAt,
    resolvedAt: null,
    packageName: dep?.package_name ?? null,
    currentVersion: dep?.package_version ?? null,
    fixedVersion: null,
    rawPayload: null,
  };
}

export async function GET() {
  try {
    await requirePermission('findings:read');
    const secret = await getConnectionSecret('snyk');
    const orgId =
      typeof secret?.metadata.orgId === 'string' ? secret.metadata.orgId : undefined;

    if (!secret || !orgId) {
      return NextResponse.json({ error: 'Snyk is not connected' }, { status: 401 });
    }

    const apiToken = secret.secret;

    const url = `${SNYK_API_BASE}/rest/orgs/${orgId}/issues?version=2024-10-15&limit=100`;
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${apiToken}`,
        Accept: 'application/vnd.api+json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('[Snyk Issues] API error:', response.status, body);
      return NextResponse.json(
        { error: `Snyk API error: ${response.status}` },
        { status: response.status },
      );
    }

    const raw = (await response.json()) as { data?: SnykApiIssue[] };
    const issues = Array.isArray(raw.data) ? raw.data : [];
    const findings: Finding[] = issues.map((issue) => mapIssueToFinding(issue, orgId));

    return NextResponse.json(findings);
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to fetch Snyk issues';
    console.error('[Snyk Issues]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
