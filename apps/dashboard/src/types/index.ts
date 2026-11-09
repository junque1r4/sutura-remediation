export type {
  NormalizedFinding,
  FixAttempt,
  Organization,
  OrganizationSettings,
  CustomPrompts,
  Severity,
  Scanner,
  FindingStatus,
  TestResult,
  PrStatus,
  VerificationVerdict,
} from '@sutura/common';

import type { VerificationVerdict } from '@sutura/common';

export interface NavItem {
  name: string;
  href: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Finding {
  id: string;
  orgId: string;
  scannerSource: string;
  externalId: string;
  title: string;
  description: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low';
  cvssScore: number | null;
  epssScore: number | null;
  cweId: string | null;
  cveId: string | null;
  filePath: string | null;
  lineRange: [number, number] | null;
  repo: string;
  status: 'open' | 'fixing' | 'fixed' | 'wont_fix' | 'failed';
  ingestedAt: string;
  resolvedAt: string | null;
  packageName: string | null;
  currentVersion: string | null;
  fixedVersion: string | null;
  rawPayload: Record<string, unknown> | null;
  /** Full pre-fix verification verdict (migration 012). Null until verified. */
  verificationVerdict?: VerificationVerdict | null;
  /** Denormalized verdict.reachable for cheap rendering / filtering. */
  reachable?: boolean | null;
  /** Re-assessed exploitability severity from the verification gate. */
  exploitability?: 'critical' | 'high' | 'medium' | 'low' | null;
  /** ISO timestamp the verification verdict was produced. */
  verifiedAt?: string | null;
  /** Coarse cross-scanner fingerprint (migration 014). */
  signature?: string | null;
  /** Canonical finding id when this row is a cross-scanner duplicate; null
   *  for canonical rows. Duplicates are hidden in the findings list by default. */
  duplicateOf?: string | null;
}

export interface FixAttemptRow {
  id: string;
  findingId: string;
  orgId: string;
  promptSnapshot: string;
  generatedDiff: string | null;
  testResult: 'pass' | 'fail' | 'skip' | null;
  prUrl: string | null;
  prStatus: 'open' | 'merged' | 'closed' | 'edited' | null;
  claudeModel: string;
  claudeTokensUsed: number;
  createdAt: string;
  completedAt: string | null;
  attemptNumber: number;
  parentAttemptId: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'exhausted' | 'skipped' | null;
  testOutput: string | null;
  testFilesAdded: Array<{ path: string; content: string }> | null;
  validationStatus: 'resolved' | 'still_vulnerable' | 'inconclusive' | null;
  scanOutput: string | null;
  scanTool: string | null;
  failureReason: string | null;
  /** Joined from findings via the backend's LEFT JOIN. Nullable when the FK
   * points to a deleted finding (shouldn't happen but render gracefully). */
  findingTitle: string | null;
  findingRepo: string | null;
  findingSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  /** Scanner source ("aikido", "snyk", ...) of the parent finding -- used to
   *  build the dashboard-style id `${scanner}-${externalId}` for cross-links. */
  findingScanner: string | null;
  findingExternalId: string | null;
  /** @deprecated Use findingRepo. Kept for older callers / tests. */
  repo?: string;
  /** GitHub commit SHA for the PR's head -- used by the CI watcher to poll
   *  check_runs. Populated only after submitMultiFile succeeds. Phase 2. */
  prHeadSha?: string | null;
  /** Aggregate verdict of the PR's GitHub Actions checks. Phase 2. */
  ciCheckStatus?: 'pending' | 'success' | 'failure' | 'error' | 'timed_out' | null;
  /** Trimmed CI failure logs (head/tail of each failed job). Phase 2. */
  ciFailureLogs?: string | null;
}

export interface Repository {
  id: string;
  orgId: string;
  repo: string;
  branch: string;
  lastIndexedAt: string | null;
  fileCount: number;
  chunkCount: number;
  vectorNamespace: string;
  openFindings: number;
  worstSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
}

export interface AuditLogEntry {
  id: string;
  orgId: string;
  actor: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
}

export interface StatCardData {
  label: string;
  value: number | string;
  color?: string;
  trend?: 'up' | 'down' | 'flat';
  trendValue?: string;
}

export interface GitHubRepo {
  id: number;
  fullName: string; // "acme/backend"
  name: string; // "backend"
  owner: string; // "acme"
  defaultBranch: string;
  isPrivate: boolean;
  language: string | null;
  description: string | null;
  updatedAt: string;
  htmlUrl: string;
}

export interface GitHubInstallation {
  installationId: number;
  account: string; // org or user login
  avatarUrl: string;
  appSlug: string;
  targetType: 'Organization' | 'User';
}

export interface SnykConnection {
  orgId: string;
  orgName: string;
  region: string;
}

export interface AikidoConnection {
  clientId: string;
  connectedAt: string;
}
