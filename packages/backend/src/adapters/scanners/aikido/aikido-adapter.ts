import type { NormalizedFinding, Severity } from '@sutura/common';
import type { ScannerAdapter, ScannerConfig } from '../scanner-adapter';

// ---------------------------------------------------------------------------
// Aikido API types
// ---------------------------------------------------------------------------

interface AikidoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface AikidoIssue {
  id: number;
  group_id: number;
  type: string;
  rule: string | null;
  severity: string;
  severity_score: number;
  status: string;
  code_repo_name: string | null;
  container_repo_name: string | null;
  attack_surface: string | null;
  affected_package: string | null;
  affected_file: string | null;
  cve_id: string | null;
  cwe_classes: string[];
  installed_version: string | null;
  patched_versions: string[];
  first_detected_at: number | null;
  start_line: number | null;
  end_line: number | null;
}

interface AikidoWebhookPayload {
  event_type: string;
  payload: {
    issue_id: number;
    type: string;
    severity_score: number;
    severity: string;
    status: string;
    title?: string;
    code_repo_name?: string;
    affected_file?: string;
    cwe_classes?: string[];
    affected_package?: string;
    installed_version?: string;
    patched_versions?: string[];
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const AIKIDO_API_BASE = 'https://app.aikido.dev/api';

export class AikidoAdapter implements ScannerAdapter {
  name = 'aikido';

  async fetchFindings(config: ScannerConfig): Promise<NormalizedFinding[]> {
    const accessToken = await this.authenticate(config.apiKey);
    const issues = await this.fetchAllIssues(accessToken);
    return issues.map((issue) => this.normalize(issue));
  }

  normalizeWebhookPayload(payload: unknown): NormalizedFinding[] {
    const webhook = payload as AikidoWebhookPayload;

    if (!webhook.event_type || !webhook.payload) {
      return [];
    }

    const p = webhook.payload;

    return [
      {
        externalId: String(p.issue_id),
        scanner: 'aikido',
        title: p.title ?? `Aikido finding #${p.issue_id}`,
        description: p.title ?? `Aikido finding #${p.issue_id}`,
        severity: this.normalizeSeverity(p.severity),
        cvssScore: p.severity_score ? Math.min(p.severity_score / 10, 10) : undefined,
        cweId: p.cwe_classes?.[0],
        filePath: p.affected_file,
        repo: p.code_repo_name ?? 'unknown',
        packageName: p.affected_package ?? undefined,
        currentVersion: p.installed_version ?? undefined,
        fixedVersion: p.patched_versions?.[0],
        rawPayload: webhook as unknown as Record<string, unknown>,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async authenticate(apiKey: string): Promise<string> {
    const separatorIndex = apiKey.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error('Aikido API key must be in format client_id:client_secret');
    }

    const clientId = apiKey.slice(0, separatorIndex);
    const clientSecret = apiKey.slice(separatorIndex + 1);
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch(`${AIKIDO_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`Aikido auth failed: ${response.status}`);
    }

    const data = (await response.json()) as AikidoTokenResponse;
    return data.access_token;
  }

  private async fetchAllIssues(accessToken: string): Promise<AikidoIssue[]> {
    // Single API call -- export endpoint returns all open issues at once
    const response = await fetch(
      `${AIKIDO_API_BASE}/public/v1/issues/export?format=json&filter_status=open`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Aikido API error: ${response.status}`);
    }

    const raw = (await response.json()) as AikidoIssue[] | { data: AikidoIssue[] };
    return Array.isArray(raw) ? raw : raw.data;
  }

  private buildTitle(issue: AikidoIssue): string {
    if (issue.cve_id && issue.affected_package) {
      return `${issue.cve_id} in ${issue.affected_package}`;
    }
    if (issue.rule && issue.affected_file) {
      const filename = issue.affected_file.split('/').pop() ?? issue.affected_file;
      return `${issue.rule} in ${filename}`;
    }
    if (issue.rule) {
      return issue.rule;
    }
    if (issue.affected_package && issue.installed_version) {
      return `Vulnerable ${issue.affected_package}@${issue.installed_version}`;
    }
    if (issue.affected_package) {
      return `Vulnerability in ${issue.affected_package}`;
    }
    if (issue.cve_id) {
      return issue.cve_id;
    }
    return `${issue.type} finding #${issue.id}`;
  }

  private normalize(issue: AikidoIssue): NormalizedFinding {
    const title = this.buildTitle(issue);
    return {
      externalId: String(issue.id),
      scanner: 'aikido',
      title,
      description: title,
      severity: this.normalizeSeverity(issue.severity),
      cvssScore: issue.severity_score ? Math.min(issue.severity_score / 10, 10) : undefined,
      cweId: issue.cwe_classes?.[0],
      cveId: issue.cve_id ?? undefined,
      filePath: issue.affected_file ?? undefined,
      lineRange:
        issue.start_line != null && issue.end_line != null
          ? [issue.start_line, issue.end_line]
          : undefined,
      repo: issue.code_repo_name ?? issue.container_repo_name ?? 'unknown',
      packageName: issue.affected_package ?? undefined,
      currentVersion: issue.installed_version ?? undefined,
      fixedVersion: issue.patched_versions?.[0],
      rawPayload: issue as unknown as Record<string, unknown>,
    };
  }

  private normalizeSeverity(severity: string): Severity {
    if (['critical', 'high', 'medium', 'low'].includes(severity)) {
      return severity as Severity;
    }
    return 'low';
  }
}
