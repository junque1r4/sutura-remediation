import { Worker } from 'bullmq';
import { ValidatedFixPipeline } from '@sutura/fix-engine';
import type { NormalizedFinding, SerializedToolchain } from '@sutura/common';
import { isKillSwitchOn } from '@sutura/common';
import { ensureSandboxImagesPulled } from '@sutura/sandbox-runner';
import { getRedisConnection } from '../connection';
import { getConfig } from '../../config';
import { getFinding, updateFindingStatus, updateFindingVerdict } from '../../db/findings';
import { getOrganization } from '../../db/organizations';
import { getConnectionSecret } from '../../db/connections';
import {
  insertRunningAttempt as dbInsertRunningAttempt,
  updateFixAttempt,
  listAttemptsByFinding,
} from '../../db/fix-attempts';
import { createSandboxLog } from '../../db/sandbox-logs';
import { createTokenUsage } from '../../db/token-usage';
import { logAction } from '../../db/audit-log';
import { getRepoPromptSecret, getDerivedToolchain } from '../../db/repo-prompts';
import { getInstallationToken } from '../../github/app-auth';
import type { DbFinding } from '../../db/types';
import type { ValidationJobData } from '../queues';
import { decryptSecret } from '../../lib/secret-encryption';
import { runStartupCleanup } from './startup-cleanup';

function dbFindingToNormalized(row: DbFinding, ownerFallback?: string): NormalizedFinding {
  let lineRange: [number, number] | undefined;
  if (row.line_range) {
    const match = row.line_range.match(/\[(\d+),(\d+)\]/);
    if (match) lineRange = [parseInt(match[1], 10), parseInt(match[2], 10)];
  }
  return {
    externalId: row.external_id,
    scanner: row.scanner_source as NormalizedFinding['scanner'],
    title: row.title,
    description: row.description ?? '',
    severity: row.severity,
    cvssScore: row.cvss_score ?? undefined,
    epssScore: row.epss_score ?? undefined,
    cweId: row.cwe_id ?? undefined,
    cveId: row.cve_id ?? undefined,
    filePath: row.file_path ?? undefined,
    lineRange,
    repo: qualifyRepo(row.repo, ownerFallback),
    packageName: row.package_name ?? undefined,
    currentVersion: row.current_version ?? undefined,
    fixedVersion: row.fixed_version ?? undefined,
    rawPayload: row.raw_payload ?? {},
  };
}

/**
 * Aikido / Snyk often surface bare repo names (e.g. "ExampleApp.FrontEnd.v2").
 * GitHub's tarball API needs `owner/repo`. When the org has a GitHub App
 * installation we know the owner; prefix it so the pipeline can fetch.
 */
function qualifyRepo(repo: string, ownerFallback?: string): string {
  if (repo.includes('/')) return repo;
  if (!ownerFallback) return repo;
  return `${ownerFallback}/${repo}`;
}

/**
 * Validated-fix kill switch (SUTURA_VALIDATED_FIX_DISABLED). When engaged, the
 * worker must not run any fix: it records an audit entry and returns the
 * kill_switch result, short-circuiting before any finding/org lookup, LLM call,
 * or sandbox work. Extracted so this safety branch is unit-testable without a
 * Redis-backed Worker; returns null when the switch is off (proceed normally).
 */
export async function killSwitchShortCircuit(
  orgId: string,
  findingId: string,
): Promise<{ ok: false; reason: 'kill_switch' } | null> {
  if (!isKillSwitchOn()) return null;
  await logAction({
    org_id: orgId,
    actor: 'validation-worker',
    action: 'validated_fix.killed',
    resource_type: 'finding',
    resource_id: findingId,
    metadata_json: { reason: 'kill_switch' },
  }).catch(() => {});
  return { ok: false, reason: 'kill_switch' as const };
}

export function startValidationWorker(): Worker {
  // Recover from prior crashes: mark ghost 'running' rows as failed and remove
  // leaked sutura-sbx-* containers from dead worker processes. Fire-and-forget
  // so a slow docker/postgres call can't delay worker boot.
  runStartupCleanup().catch((err) =>
    console.warn('[validation-worker] startup cleanup failed:', err),
  );

  // Best-effort image presence check; logged once per process start.
  ensureSandboxImagesPulled()
    .then((res) => {
      if (res.missingRequired.length > 0) {
        console.warn(
          '[validation-worker] missing required sandbox images:',
          res.missingRequired.join(', '),
          '- the worker will fail-fast on its first job. Build them per packages/sandbox-runner/README.md.',
        );
      }
      if (res.missingOptional.length > 0) {
        console.warn(
          '[validation-worker] missing optional sandbox images:',
          res.missingOptional.join(', '),
          '- repos needing them fall back to sandbox-base; build via scripts/setup-sandbox.sh to enable.',
        );
      }
    })
    .catch((err) => console.warn('[validation-worker] image probe failed:', err));

  return new Worker<ValidationJobData>(
    'validation-queue',
    async (job) => {
      const {
        findingId,
        orgId,
        customPrompts,
        maxAttempts,
        targetBranch,
        reviewers,
        priorAnalysis,
      } = job.data;
      // Forwarded credentials are encrypted in the Redis payload (see
      // enqueueValidationJob). Decrypt at job start; decryptSecret returns
      // plaintext / absent values unchanged so old in-flight jobs still work.
      const aikidoApiKey = job.data.aikidoApiKey
        ? decryptSecret(job.data.aikidoApiKey)
        : undefined;
      const anthropicApiKey = job.data.anthropicApiKey
        ? decryptSecret(job.data.anthropicApiKey)
        : undefined;
      console.warn(
        `[validation-worker] job ${job.id} finding=${findingId} priorAnalysis bytes=${priorAnalysis?.length ?? 0}`,
      );

      const killed = await killSwitchShortCircuit(orgId, findingId);
      if (killed) return killed;

      const config = getConfig();
      const finding = await getFinding(findingId);
      if (!finding) throw new Error(`Finding ${findingId} not found`);
      const org = await getOrganization(orgId);
      if (!org) throw new Error(`Organization ${orgId} not found`);

      // Resolve credentials. Priority: dashboard-forwarded job payload ->
      // org-scoped DB connection (decrypted from integration_connections) ->
      // env config. Workers no longer depend on a request cookie; when the
      // dashboard doesn't forward a key (cron / server-only flows) we read the
      // DB connection directly. config.* remains the final fallback.
      const resolvedAnthropicKey =
        anthropicApiKey ||
        (await getConnectionSecret(orgId, 'anthropic').catch(() => null)) ||
        config.ANTHROPIC_API_KEY;
      const resolvedAikidoKey =
        aikidoApiKey ||
        (await getConnectionSecret(orgId, 'aikido').catch(() => null)) ||
        config.AIKIDO_API_KEY ||
        undefined;

      // Mint a short-lived GitHub App installation token. Falls back to empty
      // string when the org has not connected the App; the pipeline will fail
      // fast with a clear error from Octokit instead of silently using a stale
      // PAT.
      const installationId = org.settings_json?.integrations?.github?.installationId;
      const ghAccount = org.settings_json?.integrations?.github?.account;
      let githubToken = '';
      if (installationId) {
        try {
          githubToken = await getInstallationToken(installationId);
        } catch (err) {
          console.warn('[validation-worker] failed to mint installation token:', err);
        }
      } else {
        console.warn(
          `[validation-worker] org ${orgId} has no GitHub App installation; PR step will fail`,
        );
      }

      await updateFindingStatus(findingId, 'fixing');

      // Set when the pre-fix verification gate rejects the finding. We then
      // leave the finding in 'wont_fix' instead of letting the generic
      // exhausted -> 'failed' status update below clobber it.
      let markedWontFix = false;

      const normalizedFinding = dbFindingToNormalized(finding, ghAccount);
      let repoTestEnvPrompt: string | undefined;
      let repoToolchain: SerializedToolchain | undefined;
      try {
        // Scoped strictly to THIS finding's repo within THIS org -- a prompt can
        // never leak into another repository's run.
        repoTestEnvPrompt =
          (await getRepoPromptSecret(orgId, normalizedFinding.repo, 'test_environment')) ??
          undefined;
        repoToolchain = (await getDerivedToolchain(orgId, normalizedFinding.repo)) ?? undefined;
      } catch (err) {
        console.warn('[validation-worker] repo prompt lookup failed (continuing without):', err);
      }

      const pipeline = new ValidatedFixPipeline();
      let result: Awaited<ReturnType<ValidatedFixPipeline['execute']>>;
      try {
        result = await pipeline.execute({
        finding: normalizedFinding,
        findingDbId: findingId,
        orgId,
        config: {
          // Resolved above: forwarded job key -> org DB connection -> env.
          anthropicApiKey: resolvedAnthropicKey,
          voyageApiKey: config.VOYAGE_API_KEY,
          pineconeApiKey: config.PINECONE_API_KEY,
          githubToken,
          // Resolved above: forwarded job key -> org DB connection -> env.
          // Without any of these, the pipeline transparently falls back to OSS
          // scanners.
          aikidoApiKey: resolvedAikidoKey,
          priorAnalysis,
          targetBranch,
          reviewers,
          customPrompts: (customPrompts ?? org.custom_prompts_json) as Record<string, never>,
          maxAttempts,
          // Pre-fix verification gate. Default-safe: on unless the per-org
          // setting explicitly disables it. The orchestrator additionally
          // requires an Anthropic key and an unset SUTURA_VERIFY_DISABLED
          // kill-switch before it actually runs the verifier.
          verifyBeforeFix: org.settings_json?.verifyBeforeFix !== false,
          // Adversarial patch validation (independent grader + bypass agent).
          // Default-safe: on unless the per-org setting explicitly disables it.
          // The orchestrator additionally requires an Anthropic key and an unset
          // SUTURA_ADVERSARIAL_DISABLED kill-switch before it actually runs.
          adversarialValidation: org.settings_json?.adversarialValidation !== false,
          // Per-repo dependency-cache prewarm. Default OFF (opt-in): only when
          // the org explicitly enables it. Even then the orchestrator only
          // applies it to code fixes with a developer-taught toolchain and the
          // SUTURA_PREWARM_DISABLED kill-switch can force it off globally.
          prewarmCache: org.settings_json?.prewarmCache === true,
          repoToolchain,
          repoTestEnvPrompt,
        },
        persistence: {
          insertRunningAttempt: async (input) => {
            const row = await dbInsertRunningAttempt({
              finding_id: input.findingId,
              org_id: input.orgId,
              attempt_number: input.attemptNumber,
              parent_attempt_id: input.parentAttemptId,
              prompt_snapshot: input.promptSnapshot,
              claude_model: input.claudeModel,
            });
            return { id: row.id };
          },
          updateAttempt: async (id, updates) => {
            await updateFixAttempt(id, {
              generated_diff: updates.generatedDiff,
              test_result: updates.testResult,
              test_output: updates.testOutput,
              test_files_added: updates.testFilesAdded ?? null,
              validation_status: updates.validationStatus,
              scan_output: updates.scanOutput,
              scan_tool: updates.scanTool,
              pr_url: updates.prUrl,
              pr_status: updates.prStatus,
              claude_tokens_used: updates.claudeTokensUsed,
              claude_model: updates.claudeModel,
              prompt_snapshot: updates.promptSnapshot,
              status: updates.status,
              failure_reason: updates.failureReason,
              completed_at: updates.completedAt,
              pr_head_sha: updates.prHeadSha,
              ci_check_status: updates.ciCheckStatus,
              ci_failure_logs: updates.ciFailureLogs,
              ci_polled_at: updates.ciPolledAt,
            });
          },
          recordSandboxLog: async (input) => {
            await createSandboxLog({
              fix_attempt_id: input.fixAttemptId,
              step: input.step,
              exit_code: input.exitCode ?? null,
              stdout: input.stdout ?? null,
              stderr: input.stderr ?? null,
              duration_ms: input.durationMs ?? null,
              timed_out: input.timedOut ?? false,
              command: input.command ?? null,
            });
          },
          recordTokenUsage: async (input) => {
            await createTokenUsage({
              org_id: input.orgId,
              operation: 'fix_generation',
              model: input.model,
              input_tokens: input.inputTokens,
              output_tokens: input.outputTokens,
              finding_id: finding.external_id,
              finding_title: finding.title,
              finding_severity: finding.severity,
              fix_attempt_id: input.fixAttemptId,
              prompt: input.prompt,
              response: input.response,
            }).catch(() => {});
          },
          updateFindingVerification: async (input) => {
            await updateFindingVerdict(input.findingId, input.verdict).catch((e) =>
              console.warn('[validation-worker] failed to persist verification verdict:', e),
            );
          },
          markFindingWontFix: async (input) => {
            markedWontFix = true;
            await updateFindingStatus(input.findingId, 'wont_fix').catch(() => {});
            await logAction({
              org_id: input.orgId,
              actor: 'validation-worker',
              action: 'validated_fix.skipped_verification',
              resource_type: 'finding',
              resource_id: input.findingId,
              metadata_json: { reason: input.reason },
            }).catch(() => {});
          },
          recordGraderVerdict: async (input) => {
            await updateFixAttempt(input.fixAttemptId, {
              grader_verdict: input.verdict,
            }).catch((e) =>
              console.warn('[validation-worker] failed to persist grader verdict:', e),
            );
          },
          recordBypassAttempt: async (input) => {
            await updateFixAttempt(input.fixAttemptId, {
              bypass_attempted: true,
              bypass_result: input.result,
            }).catch((e) =>
              console.warn('[validation-worker] failed to persist bypass result:', e),
            );
          },
        },
      });
      } catch (err) {
        // The pipeline threw before its own per-attempt catch could persist a
        // failure (e.g. a transient docker socket error during workspace setup,
        // or workspace creation timing out). Guarantee the UI sees *why* instead
        // of a stuck 'running' row: mark any running attempt failed (or write a
        // synthetic one), then rethrow so BullMQ records the job as failed.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[validation-worker] job ${job.id} threw before persisting a result:`, err);
        try {
          const existing = await listAttemptsByFinding(findingId);
          const running = existing.filter((a) => a.status === 'running');
          if (running.length > 0) {
            for (const a of running) {
              await updateFixAttempt(a.id, {
                status: 'failed',
                failure_reason: `worker_exception: ${reason}`.slice(0, 500),
                completed_at: new Date().toISOString(),
              });
            }
          } else {
            const synthetic = await dbInsertRunningAttempt({
              finding_id: findingId,
              org_id: orgId,
              attempt_number: 1,
              parent_attempt_id: null,
            });
            await updateFixAttempt(synthetic.id, {
              status: 'failed',
              failure_reason: `worker_exception: ${reason}`.slice(0, 500),
              completed_at: new Date().toISOString(),
            });
          }
        } catch (persistErr) {
          console.warn('[validation-worker] failed to persist worker-exception row:', persistErr);
        }
        await updateFindingStatus(findingId, 'open').catch(() => {});
        throw err;
      }

      // When the pipeline aborts before the retry loop (kill switch, triage
      // skip, tarball fetch fails, sandbox_unavailable) it returns
      // attempts=0 and never inserts a fix_attempts row. Persist a synthetic
      // failed row so the UI surfaces *why* nothing happened instead of
      // polling forever against an empty list.
      if (!result.ok && result.attempts === 0) {
        try {
          const synthetic = await dbInsertRunningAttempt({
            finding_id: findingId,
            org_id: orgId,
            attempt_number: 1,
            parent_attempt_id: null,
          });
          // A 'skipped' result is a deliberate, neutral decline (gate judged the
          // finding not exploitable/unreachable, or triage below threshold) --
          // record it as a neutral 'skipped' attempt with a specific reason, not
          // a red 'failed'/'exhausted' row.
          const skipped = result.reason === 'skipped';
          await updateFixAttempt(synthetic.id, {
            status: skipped ? 'skipped' : 'failed',
            failure_reason: skipped ? (result.skipReason ?? 'skipped') : result.reason,
            test_output: result.lastFailure?.output?.slice(-4000) ?? '',
            completed_at: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('[validation-worker] failed to persist synthetic failure row:', e);
        }
      }

      if (result.ok) {
        await updateFindingStatus(findingId, 'fixed');
      } else if (markedWontFix) {
        // Verification gate already set the finding to 'wont_fix'; don't clobber
        // it with the generic exhausted -> 'failed' transition.
      } else if (result.reason === 'exhausted') {
        await updateFindingStatus(findingId, 'failed');
      } else {
        // kill_switch / sandbox_unavailable / skipped (e.g. triage below
        // threshold): a neutral decline, not a failure -- keep the finding open.
        await updateFindingStatus(findingId, 'open').catch(() => {});
      }

      await logAction({
        org_id: orgId,
        actor: 'validation-worker',
        action: result.ok ? 'validated_fix.opened' : 'validated_fix.failed',
        resource_type: 'finding',
        resource_id: findingId,
        metadata_json: {
          attempts: result.attempts,
          ...(result.ok
            ? { prUrl: result.prUrl, attemptId: result.attemptId }
            : { reason: result.reason, lastFailure: result.lastFailure }),
        },
      }).catch(() => {});

      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
      // Bumped from 20 -> 45 min to fit CI polling (up to 10 min per attempt)
      // inside one lock with maxAttempts=3 -- gives ~15 min of headroom.
      // BullMQ extends the lock automatically while the job is active; this
      // duration is the safety net for crashed workers.
      lockDuration: 45 * 60_000,
    },
  );
}
