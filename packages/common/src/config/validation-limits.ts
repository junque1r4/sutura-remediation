/**
 * Cost / safety limits for the validated-fix pipeline.
 * Tuneable centrally; consumed by orchestrator, sandbox runner, and the
 * test-generation agent loop.
 */
/**
 * Read a positive-integer millisecond override from the environment.
 * Heavyweight toolchains (e.g. a .NET SDK download + full solution build in
 * the install phase) need more headroom than the defaults, and the right
 * value is deployment-specific -- so these are tunable without a code change.
 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const VALIDATION_LIMITS = {
  /**
   * Max generate->validate rounds per finding before declaring 'exhausted'.
   * A round is one diff put through the gates; a *remediable* failure (patch,
   * tests, rescan, adversarial) continues the SAME agent conversation in the
   * next round, so a realistic path -- round 1 fixes the primary file, round 2
   * patches a duplicate the bypass agent flagged, round 3 lands -- needs more
   * than the original 3-attempt budget.
   */
  MAX_ATTEMPTS: 5,

  /**
   * Cumulative agent-token ceiling across a finding's remediation rounds. The
   * per-run MAX_TOTAL_INPUT_TOKENS guard still bounds a single round; this stops
   * a pathological multi-round conversation from growing without bound.
   */
  SESSION_TOKEN_CEILING: 1_500_000,

  /** Per-step timeouts in milliseconds. */
  INSTALL_TIMEOUT_MS: envMs('SUTURA_INSTALL_TIMEOUT_MS', 180_000),
  TEST_TIMEOUT_MS: envMs('SUTURA_TEST_TIMEOUT_MS', 180_000),
  SCAN_TIMEOUT_MS: 120_000,
  PATCH_TIMEOUT_MS: 30_000,
  /**
   * Upper bound on a single `putArchive` upload (repo tarball into /work, or a
   * patch/file write). Guards against a docker-socket-proxy connection that
   * dies mid-write: without it the dockerode promise can hang forever, leaving
   * the attempt stuck 'running'. Generous because the repo tarball can be large.
   */
  PUT_ARCHIVE_TIMEOUT_MS: 120_000,

  /** Total budget across all attempts. */
  TOTAL_BUDGET_MS: 15 * 60_000,

  /** Token budget enforced inside the test-generation agent loop. */
  MAX_TOKENS_PER_ATTEMPT: 200_000,
  TEST_AGENT_MAX_ITER: 8,

  /**
   * Adversarial patch-validation caps. The independent grader re-verifies a
   * candidate fix from a fresh workspace; the bypass agent then tries to defeat
   * the fix in the existing post-patch workspace. Both are bounded so a single
   * finding cannot run away with cost.
   */
  GRADER_TIMEOUT_MS: envMs('SUTURA_GRADER_TIMEOUT_MS', 5 * 60_000),
  GRADER_MAX_TOKENS: 4096,
  BYPASS_MAX_ITERATIONS: 8,
  BYPASS_MAX_TOKENS: 4096,
  BYPASS_TIMEOUT_MS: 5 * 60_000,

  /** Sandbox container resource caps (passed to dockerode HostConfig).
   *  Memory must cover tmpfs usage too (/work and $HOME are tmpfs-backed and
   *  charged to the container cgroup), so raise it together with the
   *  SANDBOX_*_TMPFS_MB knobs for heavyweight toolchains. */
  SANDBOX_CPUS: 2,
  SANDBOX_MEMORY_BYTES: envMs('SUTURA_SANDBOX_MEMORY_BYTES', 2 * 1024 * 1024 * 1024),

  /** Cap output captured per sandbox step. */
  MAX_LOG_BYTES: 256 * 1024,

  /**
   * Cap for redacted excerpts of prompt/response text persisted alongside
   * token-usage accounting. Kept small: only a short, secret-scrubbed sample
   * is retained for debugging, never the full payload.
   */
  MAX_TOKEN_EXCERPT_BYTES: 1024,

  /** Env var that, when set to '1', short-circuits the worker on every job. */
  KILL_SWITCH_ENV: 'SUTURA_VALIDATED_FIX_DISABLED',

  /**
   * Env var that, when set to '1', disables the pre-fix verification
   * (exploitability) gate process-wide. The orchestrator then skips the
   * verifier entirely and proceeds straight to fix generation (legacy
   * behaviour), regardless of the per-job `verifyBeforeFix` config flag.
   */
  VERIFY_KILL_SWITCH_ENV: 'SUTURA_VERIFY_DISABLED',

  /**
   * Env var that, when set to '1', disables adversarial patch validation
   * (independent grader + bypass agent) process-wide. The orchestrator then
   * skips both stages and accepts a fix as soon as the rescan reports
   * 'resolved' (legacy behaviour), regardless of the per-job
   * `adversarialValidation` config flag.
   */
  ADVERSARIAL_KILL_SWITCH_ENV: 'SUTURA_ADVERSARIAL_DISABLED',

  /**
   * Env var that, when set to '1', disables cross-scanner signature dedup
   * process-wide. Signatures are still computed and stored on every finding,
   * but upsertFinding never links a new finding to a same-signature canonical
   * from another scanner (duplicate_of stays NULL), and listFindings stops
   * hiding duplicates by default. Restores the pre-dedup behaviour where every
   * scanner's report is an independent, fully-visible row.
   */
  DEDUP_KILL_SWITCH_ENV: 'SUTURA_DEDUP_DISABLED',

  /**
   * Env var that, when set to '1', disables the per-repo dependency-cache
   * prewarm process-wide. The orchestrator then never prewarms or mounts a
   * read-only cache and every attempt runs the legacy per-attempt networked
   * restore, regardless of the per-job `prewarmCache` config flag.
   */
  PREWARM_KILL_SWITCH_ENV: 'SUTURA_PREWARM_DISABLED',
} as const;

export type ValidationLimits = typeof VALIDATION_LIMITS;

export function isKillSwitchOn(): boolean {
  return process.env[VALIDATION_LIMITS.KILL_SWITCH_ENV] === '1';
}

/**
 * Whether the verification-gate kill-switch is engaged. When true the
 * orchestrator never invokes the verification agent.
 */
export function isVerifyKillSwitchOn(): boolean {
  return process.env[VALIDATION_LIMITS.VERIFY_KILL_SWITCH_ENV] === '1';
}

/**
 * Whether the adversarial-validation kill-switch is engaged. When true the
 * orchestrator never invokes the independent grader or the bypass agent.
 */
export function isAdversarialKillSwitchOn(): boolean {
  return process.env[VALIDATION_LIMITS.ADVERSARIAL_KILL_SWITCH_ENV] === '1';
}

/**
 * Whether the dependency-cache prewarm kill-switch is engaged. When true the
 * orchestrator never prewarms or mounts a read-only cache.
 */
export function isPrewarmKillSwitchOn(): boolean {
  return process.env[VALIDATION_LIMITS.PREWARM_KILL_SWITCH_ENV] === '1';
}

/**
 * Whether the cross-scanner dedup kill-switch is engaged. When true,
 * upsertFinding never links duplicates across scanners and listFindings does
 * not hide duplicates by default.
 */
export function isDedupKillSwitchOn(): boolean {
  return process.env[VALIDATION_LIMITS.DEDUP_KILL_SWITCH_ENV] === '1';
}
