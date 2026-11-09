import type {
  NormalizedFinding,
  Severity,
  FindingStatus,
  TestResult,
  PrStatus,
  FixAttemptStatus,
  ValidationStatus,
  FixAttemptTestFile,
  OrganizationSettings,
  CustomPrompts,
  VerificationVerdict,
} from '@sutura/common';
import { computeSignature } from '@sutura/common';
import { redactSecrets } from '../lib/data-minimization';

// ----- DB row types (snake_case, matches SQL schema) -----

export interface DbOrganization {
  id: string;
  name: string;
  plan: string;
  settings_json: OrganizationSettings;
  custom_prompts_json: CustomPrompts;
  created_at: string;
}

export interface DbFinding {
  id: string;
  org_id: string;
  scanner_source: string;
  external_id: string;
  title: string;
  description: string | null;
  severity: Severity;
  cvss_score: number | null;
  epss_score: number | null;
  cwe_id: string | null;
  cve_id: string | null;
  file_path: string | null;
  line_range: string | null;
  repo: string;
  status: FindingStatus;
  ingested_at: string;
  resolved_at: string | null;
  package_name: string | null;
  current_version: string | null;
  fixed_version: string | null;
  raw_payload: Record<string, unknown> | null;
  // ----- Pre-fix verification gate (migration 012) -----
  verification_verdict: VerificationVerdict | null;
  reachable: boolean | null;
  exploitability: Severity | null;
  verified_at: string | null;
  // ----- Cross-scanner dedup (migration 014) -----
  /** Coarse, scanner-independent fingerprint (see computeSignature). */
  signature: string | null;
  /** Set to the canonical finding's id when this row is a cross-scanner
   *  duplicate of an earlier-ingested finding. NULL for canonical rows. */
  duplicate_of: string | null;
}

export type CiCheckStatus =
  | 'pending'
  | 'success'
  | 'failure'
  | 'error'
  | 'timed_out'
  | 'unavailable';

export interface DbFixAttempt {
  id: string;
  finding_id: string;
  org_id: string;
  prompt_snapshot: string;
  generated_diff: string | null;
  test_result: TestResult | null;
  pr_url: string | null;
  pr_status: PrStatus | null;
  claude_model: string;
  claude_tokens_used: number;
  created_at: string;
  completed_at: string | null;
  attempt_number: number;
  parent_attempt_id: string | null;
  status: FixAttemptStatus;
  test_output: string | null;
  test_files_added: FixAttemptTestFile[] | null;
  validation_status: ValidationStatus | null;
  scan_output: string | null;
  scan_tool: string | null;
  failure_reason: string | null;
  pr_head_sha: string | null;
  ci_check_status: CiCheckStatus | null;
  ci_failure_logs: string | null;
  ci_polled_at: string | null;
  /** Independent grader verdict (adversarial validation). */
  grader_verdict: GraderVerdictJson | null;
  /** Whether the adversarial bypass agent ran for this attempt. */
  bypass_attempted: boolean;
  /** Adversarial bypass agent result. */
  bypass_result: BypassResultJson | null;
}

/** Shape persisted in fix_attempts.grader_verdict (jsonb). */
export interface GraderVerdictJson {
  resolved: boolean;
  verdict: 'pass' | 'fail' | 'inconclusive';
  evidence: string;
  tokensUsed?: number;
  iterations?: number;
}

/** Shape persisted in fix_attempts.bypass_result (jsonb). */
export interface BypassResultJson {
  bypassed: boolean;
  evidence: string;
  tokensUsed?: number;
  iterations?: number;
}

/**
 * Same as DbFixAttempt but with finding metadata pulled in via LEFT JOIN.
 * Used by list/get queries that power the Fix History UI -- the dashboard
 * needs title/repo/severity to render rows without a second roundtrip.
 */
export interface DbFixAttemptWithFinding extends DbFixAttempt {
  finding_title: string | null;
  finding_repo: string | null;
  finding_severity: string | null;
  finding_external_id: string | null;
  finding_scanner: string | null;
}

export type SandboxStep = 'install' | 'tests' | 'patch' | 'scan' | 'cleanup';

export interface DbSandboxLog {
  id: string;
  fix_attempt_id: string;
  step: SandboxStep;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  timed_out: boolean;
  command: string | null;
  created_at: string;
}

export interface CreateSandboxLogInput {
  fix_attempt_id: string;
  step: SandboxStep;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  duration_ms?: number | null;
  timed_out?: boolean;
  command?: string | null;
}

export interface DbCodebaseIndex {
  id: string;
  org_id: string;
  repo: string;
  branch: string;
  last_indexed_at: string | null;
  file_count: number;
  chunk_count: number;
  vector_namespace: string;
}

export type TokenUsageOperation = 'analysis' | 'fix_generation';

export interface DbTokenUsage {
  id: string;
  org_id: string | null;
  operation: TokenUsageOperation;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  finding_id: string | null;
  finding_title: string | null;
  finding_severity: string | null;
  fix_attempt_id: string | null;
  // Nullable since migration 010: only a short, secret-scrubbed excerpt is
  // persisted (or NULL for legacy rows that were cleared).
  prompt: string | null;
  response: string | null;
  created_at: string;
}

export interface CreateTokenUsageInput {
  org_id?: string | null;
  operation: TokenUsageOperation;
  model: string;
  input_tokens: number;
  output_tokens: number;
  finding_id?: string | null;
  finding_title?: string | null;
  finding_severity?: string | null;
  fix_attempt_id?: string | null;
  prompt: string;
  response: string;
}

// AI vulnerability analysis narrative persisted per run (migration 016). The
// markdown is the canonical form the dashboard parses into sections; no
// server-side parsing is done.
export interface DbFindingAnalysis {
  id: string;
  finding_id: string;
  org_id: string;
  analysis_md: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

export interface CreateFindingAnalysisInput {
  finding_id: string;
  org_id: string;
  analysis_md: string;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
}

export interface FindingCostRanking {
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
    operation: TokenUsageOperation;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

export interface TokenUsageFilters {
  operation?: TokenUsageOperation;
  findingId?: string;
  page?: number;
  pageSize?: number;
}

export interface TokenUsageStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byOperation: Array<{
    operation: TokenUsageOperation;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

export interface DbAuditLogEntry {
  id: string;
  org_id: string;
  actor: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

// ----- Filter & pagination types -----

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FindingFilters {
  status?: FindingStatus;
  severity?: Severity;
  scanner?: string;
  repo?: string;
  page?: number;
  pageSize?: number;
  /**
   * Hide cross-scanner duplicates (rows with duplicate_of set). Defaults to
   * true so the list shows one canonical row per underlying issue. Pass false
   * to include duplicates. Ignored when the dedup kill-switch is engaged
   * (no rows are ever linked, so nothing is hidden either way).
   */
  hideDuplicates?: boolean;
}

export interface FixAttemptFilters {
  findingId?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditLogFilters {
  action?: string;
  resourceType?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

// ----- Input types -----

export interface CreateOrgInput {
  name: string;
  plan?: string;
}

export interface CreateFixAttemptInput {
  finding_id: string;
  org_id: string;
  prompt_snapshot: string;
  claude_model: string;
}

export interface CreateRunningAttemptInput {
  finding_id: string;
  org_id: string;
  attempt_number: number;
  parent_attempt_id?: string | null;
  claude_model?: string;
  prompt_snapshot?: string;
}

export interface AuditLogInput {
  org_id: string;
  actor: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  metadata_json?: Record<string, unknown>;
}

export interface UpsertIndexInput {
  org_id: string;
  repo: string;
  branch: string;
  vector_namespace: string;
  file_count?: number;
  chunk_count?: number;
}

// ----- Mappers -----

export function normalizedFindingToDbRow(
  orgId: string,
  finding: NormalizedFinding,
): Omit<
  DbFinding,
  // Server-assigned / lifecycle columns plus the verification-gate columns,
  // which are populated later by the orchestrator -- never on upsert. duplicate_of
  // is resolved by upsertFinding after the row exists, so it is excluded here too.
  | 'id'
  | 'ingested_at'
  | 'resolved_at'
  | 'status'
  | 'verification_verdict'
  | 'reachable'
  | 'exploitability'
  | 'verified_at'
  | 'duplicate_of'
> {
  return {
    org_id: orgId,
    scanner_source: finding.scanner,
    external_id: finding.externalId,
    title: finding.title,
    description: finding.description || null,
    severity: finding.severity,
    cvss_score: finding.cvssScore ?? null,
    epss_score: finding.epssScore ?? null,
    cwe_id: finding.cweId ?? null,
    cve_id: finding.cveId ?? null,
    file_path: finding.filePath ?? null,
    line_range: finding.lineRange ? `[${finding.lineRange[0]},${finding.lineRange[1]}]` : null,
    repo: finding.repo,
    package_name: finding.packageName ?? null,
    current_version: finding.currentVersion ?? null,
    fixed_version: finding.fixedVersion ?? null,
    raw_payload: finding.rawPayload ?? null,
    // Coarse cross-scanner fingerprint, recomputed deterministically on every
    // upsert so it always reflects the latest normalized fields.
    signature: computeSignature(finding),
  };
}

export function dbFindingToApiResponse(row: DbFinding) {
  return {
    id: row.id,
    orgId: row.org_id,
    scannerSource: row.scanner_source,
    externalId: row.external_id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    cvssScore: row.cvss_score,
    epssScore: row.epss_score,
    cweId: row.cwe_id,
    cveId: row.cve_id,
    filePath: row.file_path,
    lineRange: row.line_range,
    repo: row.repo,
    status: row.status,
    ingestedAt: row.ingested_at,
    resolvedAt: row.resolved_at,
    packageName: row.package_name,
    currentVersion: row.current_version,
    fixedVersion: row.fixed_version,
    rawPayload: row.raw_payload,
    verificationVerdict: row.verification_verdict ?? null,
    reachable: row.reachable ?? null,
    exploitability: row.exploitability ?? null,
    verifiedAt: row.verified_at ?? null,
    signature: row.signature ?? null,
    duplicateOf: row.duplicate_of ?? null,
  };
}

export function dbFixAttemptToApiResponse(row: DbFixAttempt | DbFixAttemptWithFinding) {
  const joined = row as Partial<DbFixAttemptWithFinding>;
  return {
    id: row.id,
    findingId: row.finding_id,
    orgId: row.org_id,
    promptSnapshot: row.prompt_snapshot,
    generatedDiff: row.generated_diff,
    testResult: row.test_result,
    prUrl: row.pr_url,
    prStatus: row.pr_status,
    claudeModel: row.claude_model,
    claudeTokensUsed: row.claude_tokens_used,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    attemptNumber: row.attempt_number,
    parentAttemptId: row.parent_attempt_id,
    status: row.status,
    testOutput: row.test_output,
    testFilesAdded: row.test_files_added,
    validationStatus: row.validation_status,
    scanOutput: row.scan_output,
    scanTool: row.scan_tool,
    failureReason: row.failure_reason,
    prHeadSha: row.pr_head_sha,
    ciCheckStatus: row.ci_check_status,
    ciFailureLogs: row.ci_failure_logs,
    ciPolledAt: row.ci_polled_at,
    graderVerdict: row.grader_verdict ?? null,
    bypassAttempted: row.bypass_attempted ?? false,
    bypassResult: row.bypass_result ?? null,
    findingTitle: joined.finding_title ?? null,
    findingRepo: joined.finding_repo ?? null,
    findingSeverity: joined.finding_severity ?? null,
    findingExternalId: joined.finding_external_id ?? null,
    findingScanner: joined.finding_scanner ?? null,
  };
}

export function dbSandboxLogToApiResponse(row: DbSandboxLog) {
  return {
    id: row.id,
    fixAttemptId: row.fix_attempt_id,
    step: row.step,
    exitCode: row.exit_code,
    stdout: row.stdout,
    stderr: row.stderr,
    durationMs: row.duration_ms,
    timedOut: row.timed_out,
    command: row.command,
    createdAt: row.created_at,
  };
}

export function dbTokenUsageToApiResponse(row: DbTokenUsage) {
  return {
    id: row.id,
    orgId: row.org_id,
    operation: row.operation,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: Number(row.cost_usd),
    findingId: row.finding_id,
    findingTitle: row.finding_title,
    findingSeverity: row.finding_severity,
    fixAttemptId: row.fix_attempt_id,
    // Defensively scrub any legacy rows that still contain raw secret-shaped
    // text. New rows are already minimized at write time (see createTokenUsage).
    prompt: row.prompt == null ? null : redactSecrets(row.prompt),
    response: row.response == null ? null : redactSecrets(row.response),
    createdAt: row.created_at,
  };
}

export function dbAnalysisToApiResponse(row: DbFindingAnalysis) {
  return {
    id: row.id,
    findingId: row.finding_id,
    orgId: row.org_id,
    analysisMarkdown: row.analysis_md,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
  };
}

export function dbAuditLogToApiResponse(row: DbAuditLogEntry) {
  return {
    id: row.id,
    orgId: row.org_id,
    actor: row.actor,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
  };
}
