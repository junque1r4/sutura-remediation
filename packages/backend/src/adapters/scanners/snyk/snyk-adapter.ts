import type { NormalizedFinding, Severity } from '@sutura/common';
import type { ScannerAdapter, ScannerConfig } from '../scanner-adapter';

// ---------------------------------------------------------------------------
// Snyk API types
// ---------------------------------------------------------------------------

interface SnykIssueData {
  id: string;
  title: string;
  severity: string;
  cvssScore?: number;
  cwe?: string[];
  cve?: string;
  description?: string;
}

interface SnykFixInfo {
  nearestFixedInVersion?: string;
}

interface SnykIssue {
  id: string;
  issueType: string;
  pkgName: string;
  pkgVersions: string[];
  priorityScore: number;
  issueData: SnykIssueData;
  fixInfo?: SnykFixInfo;
}

interface SnykWebhookPayload {
  newIssues: SnykIssue[];
  project: { name: string };
}

interface SnykApiIssue {
  id: string;
  attributes?: {
    title?: string;
    severity?: string;
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
    description?: string;
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const SNYK_API_BASE = 'https://api.snyk.io';

export class SnykAdapter implements ScannerAdapter {
  name = 'snyk';

  normalizeWebhookPayload(payload: unknown): NormalizedFinding[] {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const p = payload as Record<string, unknown>;

    if (!Array.isArray(p.newIssues) || !p.project || typeof p.project !== 'object') {
      return [];
    }

    const webhook = payload as SnykWebhookPayload;
    const projectName = webhook.project.name ?? 'unknown';

    return webhook.newIssues.map((issue) => this.normalizeIssue(issue, projectName));
  }

  async fetchFindings(config: ScannerConfig): Promise<NormalizedFinding[]> {
    const baseUrl = config.baseUrl ?? SNYK_API_BASE;
    const url = `${baseUrl}/rest/orgs/${config.orgId}/issues?version=2024-10-15&limit=100`;

    const response = await fetch(url, {
      headers: {
        Authorization: `token ${config.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Snyk API error: ${response.status}`);
    }

    const raw = (await response.json()) as { data: SnykApiIssue[] };
    const issues = Array.isArray(raw.data) ? raw.data : [];

    return issues.map((issue) => this.normalizeApiIssue(issue));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private normalizeSeverity(severity: string): Severity {
    if (['critical', 'high', 'medium', 'low'].includes(severity)) {
      return severity as Severity;
    }
    return 'low';
  }

  private normalizeIssue(issue: SnykIssue, projectName: string): NormalizedFinding {
    const { issueData } = issue;

    return {
      externalId: issue.id,
      scanner: 'snyk',
      title: issueData.title,
      description: issueData.description ?? issueData.title,
      severity: this.normalizeSeverity(issueData.severity),
      cvssScore: issueData.cvssScore,
      cweId: issueData.cwe?.[0],
      cveId: issueData.cve,
      packageName: issue.pkgName,
      currentVersion: issue.pkgVersions?.[0],
      fixedVersion: issue.fixInfo?.nearestFixedInVersion,
      repo: projectName,
      rawPayload: issue as unknown as Record<string, unknown>,
    };
  }

  private normalizeApiIssue(issue: SnykApiIssue): NormalizedFinding {
    const attrs = issue.attributes ?? {};

    // Extract package info from coordinates
    const firstCoord = attrs.coordinates?.[0];
    const firstRep = firstCoord?.representations?.[0];
    const dep = firstRep?.dependency;

    // Extract CVE/CWE from problems
    let cveId: string | undefined;
    let cweId: string | undefined;
    for (const problem of attrs.problems ?? []) {
      if (problem.source === 'NVD' || problem.type === 'vulnerability') {
        if (problem.id?.startsWith('CVE-')) cveId = problem.id;
        if (problem.id?.startsWith('CWE-')) cweId = problem.id;
      }
    }

    const title = attrs.title ?? `Snyk finding ${issue.id}`;

    return {
      externalId: issue.id,
      scanner: 'snyk',
      title,
      description: attrs.description ?? title,
      severity: this.normalizeSeverity(attrs.severity ?? ''),
      cveId,
      cweId,
      packageName: dep?.package_name,
      currentVersion: dep?.package_version,
      repo: 'unknown',
      rawPayload: issue as unknown as Record<string, unknown>,
    };
  }
}
