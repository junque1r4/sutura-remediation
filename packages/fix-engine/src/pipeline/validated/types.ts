import type {
  CustomPrompts,
  NormalizedFinding,
  FixAttemptTestFile,
  SerializedToolchain,
  VerificationVerdict,
} from '@sutura/common';

export interface ValidatedFixConfig {
  anthropicApiKey: string;
  voyageApiKey: string;
  pineconeApiKey: string;
  githubToken: string;
  targetBranch?: string;
  reviewers?: string[];
  customPrompts?: CustomPrompts;
  /** Override iteration cap; defaults to VALIDATION_LIMITS.MAX_ATTEMPTS. */
  maxAttempts?: number;
  /**
   * Aikido API key (`client_id:client_secret`). When provided, the rescan
   * step calls Aikido's local CLI inside the sandbox; otherwise (or on CLI
   * absence) it falls back to OSS scanners.
   */
  aikidoApiKey?: string;
  /**
   * Markdown produced by the dashboard's Analyze flow (Risk Assessment / Root
   * Cause / Recommended Fix / Proposed Diff / References). When provided, the
   * orchestrator prepends a `## Prior Analysis` section to the base prompt so
   * the fix agent sees it as priming context. Capped at ~12 KB at injection
   * time.
   */
  priorAnalysis?: string;
  /**
   * Hard cap for the post-PR CI watcher. Defaults to 10 minutes inside
   * awaitCiVerdict; the worker's lockDuration (45 min) is sized assuming
   * three attempts * (sandbox time + this).
   */
  ciTimeoutMs?: number;
  /**
   * Run the pre-fix exploitability / verification gate before generating a fix.
   * Treated as ON when undefined (default-safe enable). Set to `false` to skip
   * the verifier and proceed straight to fix generation (legacy behaviour).
   * Even when on, the verifier only runs if an Anthropic key/client is present
   * and the SUTURA_VERIFY_DISABLED kill-switch is not engaged.
   */
  verifyBeforeFix?: boolean;
  /**
   * Run adversarial patch validation (independent grader + bypass agent) after
   * the rescan reports 'resolved' and before opening a PR. Treated as ON when
   * undefined (default-safe enable). Set to `false` to accept a fix as soon as
   * the rescan passes (legacy behaviour). Even when on, the grader/bypass only
   * run if an Anthropic key/client is present and the SUTURA_ADVERSARIAL_DISABLED
   * kill-switch is not engaged.
   */
  adversarialValidation?: boolean;
  /** Developer-taught sandbox toolchain for repos manifest detection can't
   *  handle. Decrypted + schema-validated by the caller (validation worker).
   *  In-memory only: never persisted by the pipeline. */
  repoToolchain?: SerializedToolchain;
  /** Decrypted repo-scoped test-environment prompt. Injected ONLY into the
   *  test-generation agent's system prompt for this run. Never persisted,
   *  never included in PR bodies or generated files. */
  repoTestEnvPrompt?: string;
  /**
   * Prewarm a per-repo dependency cache before the attempt loop, then mount it
   * read-only on every attempt so each attempt's restore runs offline
   * (--network=none) against the cache instead of re-paying a networked
   * install. Default OFF (undefined/false) -- the legacy per-attempt networked
   * restore runs unchanged. Only applied for code fixes with a developer-taught
   * toolchain (restoreNeedsPatch false); SCA/dep fixes always use the legacy
   * post-patch networked restore since the patch changes the manifests. Even
   * when on, a global SUTURA_PREWARM_DISABLED kill-switch forces it off.
   */
  prewarmCache?: boolean;
}

export interface AttemptFailure {
  stage: 'patch' | 'install' | 'tests' | 'rescan' | 'exception' | 'ci' | 'adversarial_validation';
  output: string;
}

/** Result of the independent grader re-verifying a candidate fix. */
export interface GraderVerdict {
  /** True only when the rescan verdict was 'resolved' AND the tests passed. */
  resolved: boolean;
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Human-readable summary of what the grader observed. */
  evidence: string;
  tokensUsed?: number;
  iterations?: number;
}

/** Result of the adversarial bypass agent attempting to defeat a fix. */
export interface BypassResult {
  /** True only with concrete evidence that the fix can be defeated. */
  bypassed: boolean;
  evidence: string;
  tokensUsed?: number;
  iterations?: number;
}

export interface ValidatedFixSuccess {
  ok: true;
  attemptId: string;
  prUrl: string;
  branchName: string;
  attempts: number;
  testFiles: FixAttemptTestFile[];
}

export interface ValidatedFixFailure {
  ok: false;
  reason: 'exhausted' | 'kill_switch' | 'sandbox_unavailable' | 'skipped';
  /**
   * Short machine code explaining a `reason: 'skipped'` outcome, surfaced as the
   * attempt's failure_reason (e.g. 'not_exploitable', 'unreachable',
   * 'below_threshold'). Only set when `reason === 'skipped'`. A skip is a
   * deliberate, neutral decline -- not a failure -- so the UI renders it neutrally.
   */
  skipReason?: string;
  lastFailure?: AttemptFailure;
  attempts: number;
}

export type ValidatedFixResult = ValidatedFixSuccess | ValidatedFixFailure;

/** Persistence callbacks the orchestrator calls; backend provides DB-backed impls. */
export interface ValidatedFixPersistence {
  insertRunningAttempt(input: {
    findingId: string;
    orgId: string;
    attemptNumber: number;
    parentAttemptId: string | null;
    promptSnapshot?: string;
    claudeModel?: string;
  }): Promise<{ id: string }>;
  updateAttempt(
    id: string,
    updates: {
      generatedDiff?: string;
      testResult?: 'pass' | 'fail' | 'skip';
      testOutput?: string;
      testFilesAdded?: FixAttemptTestFile[];
      validationStatus?: 'resolved' | 'still_vulnerable' | 'inconclusive';
      scanOutput?: string;
      scanTool?: string;
      prUrl?: string;
      prStatus?: 'open';
      claudeTokensUsed?: number;
      claudeModel?: string;
      promptSnapshot?: string;
      status?: 'running' | 'succeeded' | 'failed' | 'exhausted' | 'skipped';
      failureReason?: string;
      completedAt?: string;
      prHeadSha?: string;
      ciCheckStatus?: 'pending' | 'success' | 'failure' | 'error' | 'timed_out' | 'unavailable';
      ciFailureLogs?: string | null;
      ciPolledAt?: string;
    },
  ): Promise<void>;
  recordSandboxLog(input: {
    fixAttemptId: string;
    step: 'install' | 'tests' | 'patch' | 'scan' | 'cleanup';
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    timedOut?: boolean;
    command?: string;
  }): Promise<void>;
  recordTokenUsage?(input: {
    findingId: string;
    fixAttemptId: string;
    orgId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    prompt: string;
    response: string;
  }): Promise<void>;
  /**
   * Persist the pre-fix verification verdict on the finding row. Optional so
   * existing callers / tests need not implement it; the orchestrator no-ops
   * when absent.
   */
  updateFindingVerification?(input: {
    findingId: string;
    orgId: string;
    verdict: VerificationVerdict;
  }): Promise<void>;
  /**
   * Mark a finding as won't-fix because the verification gate rejected it.
   * Optional for the same reason as above.
   */
  markFindingWontFix?(input: {
    findingId: string;
    orgId: string;
    reason: string;
  }): Promise<void>;
  /**
   * Persist the independent grader's verdict on the attempt row. Optional so
   * existing callers / tests need not implement it; the orchestrator no-ops
   * when absent.
   */
  recordGraderVerdict?(input: {
    fixAttemptId: string;
    verdict: GraderVerdict;
  }): Promise<void>;
  /**
   * Persist the bypass agent's result on the attempt row. Optional for the same
   * reason as above.
   */
  recordBypassAttempt?(input: {
    fixAttemptId: string;
    result: BypassResult;
  }): Promise<void>;
}

export interface ValidatedFixDeps {
  finding: NormalizedFinding;
  /** UUID of the row in `findings` -- used as fix_attempts.finding_id. */
  findingDbId: string;
  orgId: string;
  config: ValidatedFixConfig;
  persistence: ValidatedFixPersistence;
}
