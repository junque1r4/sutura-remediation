import * as crypto from 'crypto';
import { encryptJson, decryptJson } from './crypto';
import { getIntegrationEncryptionSecret } from './encryption-config';
import type { Finding } from '@/types';

function getEncryptionSecret(): string {
  // Derive from the central integration encryption secret. The 'aikido:' prefix
  // is preserved so previously issued cookies remain decryptable.
  const base = getIntegrationEncryptionSecret();
  return crypto.createHash('sha256').update(`aikido:${base}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AikidoCookieData {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  expiresAt: number;
  connectedAt: string;
}

interface AikidoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface AikidoIssue {
  id: number;
  group_id: number;
  type: string;
  rule: string | null;
  severity: string;
  severity_score: number;
  status: string;
  attack_surface: string | null;
  code_repo_name: string | null;
  container_repo_name: string | null;
  affected_package: string | null;
  affected_file: string | null;
  cve_id: string | null;
  cwe_classes: string[];
  installed_version: string | null;
  patched_versions: string[];
  first_detected_at: number | null;
  start_line: number | null;
  end_line: number | null;
  programming_language: string | null;
  closed_at: number | null;
}

// ---------------------------------------------------------------------------
// 1. authenticateAikido
// ---------------------------------------------------------------------------

export async function authenticateAikido(
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://app.aikido.dev/api/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Aikido auth failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as AikidoTokenResponse;

  // Subtract 60s buffer to refresh before actual expiry
  const expiresAt = Date.now() + data.expires_in * 1000 - 60_000;

  return { accessToken: data.access_token, expiresAt };
}

// ---------------------------------------------------------------------------
// 3. aikidoApiFetch
// ---------------------------------------------------------------------------

export async function aikidoApiFetch<T>(path: string, accessToken: string): Promise<T> {
  const url = path.startsWith('http')
    ? path
    : `https://app.aikido.dev/api/public/v1${path}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Aikido API error: ${response.status} ${body}`);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// 4. validateAikidoConnection
// ---------------------------------------------------------------------------

export async function validateAikidoConnection(accessToken: string): Promise<boolean> {
  try {
    await aikidoApiFetch<unknown>('/issues/export?format=json&filter_status=open', accessToken);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 5. Cookie helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'aikido_connection';

export async function getAikidoConnectionFromCookies(): Promise<AikidoCookieData | null> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);

  if (!cookie) {
    return null;
  }

  return decryptJson<AikidoCookieData>(cookie.value, getEncryptionSecret());
}

export async function setAikidoConnectionCookie(data: AikidoCookieData): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const encrypted = encryptJson(data, getEncryptionSecret());

  cookieStore.set(COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });
}

export async function clearAikidoConnectionCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

// ---------------------------------------------------------------------------
// 6. getValidAikidoToken
// ---------------------------------------------------------------------------

/**
 * Derives a short-lived Aikido OAuth access token on demand from the long-lived
 * clientId/clientSecret (sourced from the DB connection, not a cookie). The
 * access token is never persisted -- it is re-issued per consume.
 */
export async function getValidAikidoToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (!clientId || !clientSecret) {
    throw new Error('Aikido is not connected');
  }
  const { accessToken } = await authenticateAikido(clientId, clientSecret);
  return accessToken;
}

// ---------------------------------------------------------------------------
// 7. fetchAikidoIssues
// ---------------------------------------------------------------------------

export async function fetchAikidoIssues(accessToken: string): Promise<AikidoIssue[]> {
  // Single API call -- returns all open issues at once, no pagination needed
  const raw = await aikidoApiFetch<AikidoIssue[] | { data: AikidoIssue[] }>(
    '/issues/export?format=json&filter_status=open',
    accessToken,
  );

  return Array.isArray(raw) ? raw : raw.data;
}

// ---------------------------------------------------------------------------
// 8. mapAikidoIssueToFinding
// ---------------------------------------------------------------------------

function buildTitle(issue: AikidoIssue): string {
  if (issue.cve_id && issue.affected_package) {
    return `${issue.cve_id} in ${issue.affected_package}`;
  }
  if (issue.rule && issue.affected_file) {
    return `${issue.rule} in ${issue.affected_file}`;
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

export function mapAikidoIssueToFinding(issue: AikidoIssue): Finding {
  let severity = issue.severity as Finding['severity'];
  if (!['critical', 'high', 'medium', 'low'].includes(severity)) {
    severity = 'low';
  }

  const cvssScore = issue.severity_score ? Math.min(issue.severity_score / 10, 10) : null;

  const cweId = issue.cwe_classes?.[0] ?? null;

  const lineRange: [number, number] | null =
    issue.start_line != null && issue.end_line != null
      ? [issue.start_line, issue.end_line]
      : null;

  const status: Finding['status'] = issue.status === 'closed' ? 'fixed'
    : issue.status === 'ignored' ? 'wont_fix'
    : 'open';

  const ingestedAt = issue.first_detected_at
    ? new Date(issue.first_detected_at * 1000).toISOString()
    : new Date().toISOString();

  const title = buildTitle(issue);

  return {
    id: `aikido-${issue.id}`,
    orgId: '',
    externalId: String(issue.id),
    scannerSource: 'aikido',
    title,
    description: title,
    severity,
    cvssScore,
    epssScore: null,
    cweId,
    cveId: issue.cve_id ?? null,
    filePath: issue.affected_file ?? null,
    lineRange,
    repo: issue.code_repo_name ?? issue.container_repo_name ?? 'unknown',
    status,
    ingestedAt,
    resolvedAt: issue.closed_at ? new Date(issue.closed_at * 1000).toISOString() : null,
    packageName: issue.affected_package ?? null,
    currentVersion: issue.installed_version ?? null,
    fixedVersion: issue.patched_versions?.[0] ?? null,
    rawPayload: issue as unknown as Record<string, unknown>,
  };
}
