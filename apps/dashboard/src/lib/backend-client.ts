import type { Finding, FixAttemptRow, AuditLogEntry, PaginatedResponse, Repository } from '@/types';
import type { NormalizedFinding, Scanner } from '@sutura/common';

/**
 * Convert the dashboard's Finding shape to the backend's NormalizedFinding.
 * The backend uses this when a dashboard-only finding needs to be upserted
 * into `findings` so a fix_attempt can FK to it.
 */
function findingToNormalized(f: Finding): NormalizedFinding {
  return {
    externalId: f.externalId,
    scanner: f.scannerSource as Scanner,
    title: f.title,
    description: f.description ?? '',
    severity: f.severity,
    cvssScore: f.cvssScore ?? undefined,
    epssScore: f.epssScore ?? undefined,
    cweId: f.cweId ?? undefined,
    cveId: f.cveId ?? undefined,
    filePath: f.filePath ?? undefined,
    lineRange: f.lineRange ?? undefined,
    repo: f.repo,
    packageName: f.packageName ?? undefined,
    currentVersion: f.currentVersion ?? undefined,
    fixedVersion: f.fixedVersion ?? undefined,
    rawPayload: f.rawPayload ?? {},
  };
}

/**
 * Call the backend from the browser via the same-origin `/api/backend` proxy.
 * The proxy signs an HS256 token server-side from the authenticated session, so
 * JWT_SECRET never reaches the client bundle.
 *
 * This module is browser-only by design. Server code (RSC / route handlers /
 * server actions) must use `backend-client.server`, which signs the token
 * directly and keeps the `server-only` auth modules out of the client layer.
 * Mixing both paths in one module pulls `server-only` into every client bundle
 * that imports a fetcher and breaks the production build.
 */
async function backendFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (typeof window === 'undefined') {
    throw new Error(
      'backend-client is browser-only; import backend-client.server for server-side calls.',
    );
  }
  // `path` always starts with `/api/`; map it to `/api/backend/...` so the
  // same-origin proxy forwards it to the backend.
  const proxyPath = `/api/backend${path.replace(/^\/api/, '')}`;
  const res = await fetch(proxyPath, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Same-origin call to a dashboard Next.js API route. Used for endpoints
// that the dashboard proxies to the backend with a server-to-server secret.
async function dashboardFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Backend error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

// Findings
export async function fetchFindings(params?: {
  status?: string;
  severity?: string;
  scanner?: string;
  repo?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<Finding>> {
  const query = buildQuery(params ?? {});
  return backendFetch<PaginatedResponse<Finding>>(`/api/findings${query}`);
}

export async function fetchFinding(id: string): Promise<Finding> {
  return backendFetch<Finding>(`/api/findings/${encodeURIComponent(id)}`);
}

export async function updateFindingStatus(id: string, status: string): Promise<void> {
  await backendFetch<unknown>(`/api/findings/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

// Fixes
export async function fetchFixes(params?: {
  findingId?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<FixAttemptRow>> {
  const query = buildQuery(params ?? {});
  return backendFetch<PaginatedResponse<FixAttemptRow>>(`/api/fixes${query}`);
}

export async function fetchFixAttempt(id: string): Promise<FixAttemptRow> {
  return backendFetch<FixAttemptRow>(`/api/fixes/${encodeURIComponent(id)}`);
}

export async function triggerFix(findingId: string): Promise<{ jobId: string }> {
  return backendFetch<{ jobId: string }>('/api/fixes', {
    method: 'POST',
    body: JSON.stringify({ findingId }),
  });
}

// Validated fix
export interface ValidatedFixAttempt {
  id: string;
  findingId: string;
  attemptNumber: number;
  parentAttemptId: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'exhausted' | 'skipped' | null;
  testResult: 'pass' | 'fail' | 'skip' | null;
  validationStatus: 'resolved' | 'still_vulnerable' | 'inconclusive' | null;
  scanTool: string | null;
  prUrl: string | null;
  failureReason: string | null;
  testFilesAdded: Array<{ path: string; content: string }> | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ValidatedFixStatus {
  findingId: string;
  currentAttempt: number;
  running: boolean;
  attempts: ValidatedFixAttempt[];
}

export async function triggerValidatedFix(
  findingId: string,
  opts: {
    targetBranch?: string;
    reviewers?: string[];
    priorAnalysis?: string;
    /**
     * Pass the dashboard Finding object so the backend can upsert it into
     * the `findings` table when no backend row exists yet (the common case
     * for cookie-only Aikido findings). The backend resolves the URL `:id`
     * to a backend UUID first; if that fails AND `finding` is provided, it
     * upserts and uses the new UUID.
     */
    finding?: Finding;
  } = {},
): Promise<{ jobId: string; findingId: string }> {
  const body = {
    targetBranch: opts.targetBranch,
    reviewers: opts.reviewers,
    priorAnalysis: opts.priorAnalysis,
    finding: opts.finding ? findingToNormalized(opts.finding) : undefined,
  };

  // Try the same-origin Next.js proxy first; it can attach the Aikido
  // credential from the encrypted aikido_connection cookie. If the proxy
  // isn't deployed yet, fall back to a direct backend call.
  try {
    const res = await fetch(
      `/api/findings/${encodeURIComponent(findingId)}/validated-fix/trigger`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (res.ok) return res.json() as Promise<{ jobId: string; findingId: string }>;
    if (res.status === 404) {
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        return backendFetch<{ jobId: string; findingId: string }>(
          `/api/findings/${encodeURIComponent(findingId)}/validated-fix`,
          { method: 'POST', body: JSON.stringify(body) },
        );
      }
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Backend error: ${res.status}`);
  } catch (e) {
    if (e instanceof TypeError) {
      return backendFetch<{ jobId: string; findingId: string }>(
        `/api/findings/${encodeURIComponent(findingId)}/validated-fix`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    }
    throw e;
  }
}

export async function fetchValidatedFixStatus(findingId: string): Promise<ValidatedFixStatus> {
  return backendFetch<ValidatedFixStatus>(
    `/api/findings/${encodeURIComponent(findingId)}/validated-fix/status`,
  );
}

export async function cancelValidatedFix(
  findingId: string,
  jobId: string,
): Promise<{ cancelled: boolean }> {
  return backendFetch<{ cancelled: boolean }>(
    `/api/findings/${encodeURIComponent(findingId)}/validated-fix/cancel`,
    { method: 'POST', body: JSON.stringify({ jobId }) },
  );
}

export interface SandboxLogEntry {
  id: string;
  fixAttemptId: string;
  step: 'install' | 'tests' | 'patch' | 'scan' | 'cleanup';
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  durationMs: number | null;
  timedOut: boolean;
  command: string | null;
  createdAt: string;
}

export async function fetchSandboxLogs(
  fixAttemptId: string,
): Promise<{ data: SandboxLogEntry[] }> {
  return backendFetch<{ data: SandboxLogEntry[] }>(
    `/api/fix-attempts/${encodeURIComponent(fixAttemptId)}/sandbox-logs`,
  );
}

export interface TestOutputResponse {
  testResult: 'pass' | 'fail' | 'skip' | null;
  validationStatus: 'resolved' | 'still_vulnerable' | 'inconclusive' | null;
  scanTool: string | null;
  testOutput: string | null;
  scanOutput: string | null;
  testFilesAdded: Array<{ path: string; content: string }> | null;
  durations: { testsMs: number | null; scanMs: number | null };
}

export async function fetchTestOutput(fixAttemptId: string): Promise<TestOutputResponse> {
  return backendFetch<TestOutputResponse>(
    `/api/fix-attempts/${encodeURIComponent(fixAttemptId)}/test-output`,
  );
}

// Repositories
export async function fetchRepositories(): Promise<{ data: Repository[] }> {
  return backendFetch<{ data: Repository[] }>('/api/repositories');
}

export async function triggerReindex(repo: string, branch: string): Promise<{ jobId: string }> {
  return backendFetch<{ jobId: string }>('/api/repositories/reindex', {
    method: 'POST',
    body: JSON.stringify({ repo, branch }),
  });
}

// Audit Log
export async function fetchAuditLog(params?: {
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<AuditLogEntry>> {
  const query = buildQuery(params ?? {});
  return backendFetch<PaginatedResponse<AuditLogEntry>>(`/api/audit-log${query}`);
}

// Organization
export async function fetchOrganization(): Promise<{
  id: string;
  name: string;
  plan: string;
  settings: Record<string, unknown>;
  customPrompts: Record<string, string>;
}> {
  return backendFetch('/api/org');
}

export async function updateOrgSettings(settings: Record<string, unknown>): Promise<void> {
  await backendFetch<unknown>('/api/org/settings', {
    method: 'PATCH',
    body: JSON.stringify({ settings }),
  });
}

export async function updateOrgPrompts(prompts: Record<string, string>): Promise<void> {
  await backendFetch<unknown>('/api/org/prompts', {
    method: 'PATCH',
    body: JSON.stringify({ prompts }),
  });
}

// Token Usage
export interface TokenUsageRow {
  id: string;
  orgId: string | null;
  operation: 'analysis' | 'fix_generation';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  findingId: string | null;
  fixAttemptId: string | null;
  prompt: string;
  response: string;
  createdAt: string;
}

export interface TokenUsageStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byOperation: Array<{
    operation: 'analysis' | 'fix_generation';
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

export async function fetchTokenUsage(params?: {
  operation?: 'analysis' | 'fix_generation';
  findingId?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<TokenUsageRow>> {
  const query = buildQuery(params ?? {});
  return dashboardFetch<PaginatedResponse<TokenUsageRow>>(`/api/token-usage${query}`);
}

export async function fetchTokenUsageStats(): Promise<TokenUsageStats> {
  return dashboardFetch<TokenUsageStats>('/api/token-usage/stats');
}

export interface FindingCostRankingRow {
  findingId: string;
  findingTitle: string | null;
  findingSeverity: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  lastActivity: string;
}

export interface FindingCostBreakdown {
  findingId: string;
  findingTitle: string | null;
  findingSeverity: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  byOperation: Array<{
    operation: 'analysis' | 'fix_generation';
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  /** Cost of the most recent token_usage row for this finding, or null if none. */
  lastRun: {
    operation: 'analysis' | 'fix_generation';
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    createdAt: string;
  } | null;
}

export async function fetchTokenCostRanking(limit = 100): Promise<{ data: FindingCostRankingRow[] }> {
  return dashboardFetch<{ data: FindingCostRankingRow[] }>(`/api/token-usage/ranking?limit=${limit}`);
}

export async function fetchFindingTokenCost(findingId: string): Promise<FindingCostBreakdown> {
  return dashboardFetch<FindingCostBreakdown>(
    `/api/token-usage/findings/${encodeURIComponent(findingId)}`,
  );
}
