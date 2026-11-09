import {
  VALIDATION_LIMITS,
  isKillSwitchOn,
  isVerifyKillSwitchOn,
  isAdversarialKillSwitchOn,
  isPrewarmKillSwitchOn,
} from '@sutura/common';
import type { FixAttemptTestFile, VerificationVerdict } from '@sutura/common';
import {
  DockerSandboxRunner,
  runSecurityScan,
  type SandboxRunner,
  type WorkspaceHandle,
} from '@sutura/sandbox-runner';
import { triage } from '../triage';
import { generateFixAgentic, type FixConversation } from '../generator';
import { generatePrNarrative } from '../pr-narrative';
import { submitMultiFile } from '../submitter';
import { awaitCiVerdict } from '../ci-watcher';
import { fetchRepoTarball } from './repo-tarball';
import { runTestGenerationAgent } from './test-generator';
import { runVerificationAgent } from './verifier';
import { runAdversarialGrader } from './grader';
import { runBypassAgent } from './bypass-agent';
import { ensureWarmCache } from './prewarm';
import { resolveProjectScope, looksLikeNoTestsToRun } from './scope';
import type {
  AttemptFailure,
  ValidatedFixDeps,
  ValidatedFixResult,
} from './types';

const TAIL_BYTES = 16 * 1024;

export class ValidatedFixPipeline {
  private runner: SandboxRunner;

  constructor(runner?: SandboxRunner) {
    this.runner = runner ?? new DockerSandboxRunner();
  }

  async execute(deps: ValidatedFixDeps): Promise<ValidatedFixResult> {
    const { finding, findingDbId, orgId, config, persistence } = deps;
    const maxAttempts = config.maxAttempts ?? VALIDATION_LIMITS.MAX_ATTEMPTS;

    if (isKillSwitchOn()) {
      return { ok: false, reason: 'kill_switch', attempts: 0 };
    }

    const triageResult = triage(finding);
    if (!triageResult.shouldFix) {
      // Below the auto-fix threshold -- a deliberate decline, not a failure.
      return {
        ok: false,
        reason: 'skipped',
        skipReason: 'below_threshold',
        attempts: 0,
        lastFailure: { stage: 'exception', output: triageResult.reason ?? 'triage skip' },
      };
    }

    let tarball: Buffer;
    let resolvedBranch: string;
    try {
      const fetched = await fetchRepoTarball(
        finding.repo,
        config.targetBranch,
        config.githubToken,
      );
      tarball = fetched.tarball;
      resolvedBranch = fetched.ref;
    } catch (err) {
      return {
        ok: false,
        reason: 'sandbox_unavailable',
        attempts: 0,
        lastFailure: { stage: 'exception', output: String(err) },
      };
    }

    let parentAttemptId: string | null = null;
    let lastFailure: AttemptFailure | null = null;
    // Verification verdict is computed once (attempt 1) and reused on retries.
    let verdict: VerificationVerdict | null = null;

    // ---- remediation-loop state (persists across rounds) ----
    // A round is one generate->validate pass. A *remediable* failure (patch,
    // tests, rescan, adversarial) keeps the warm workspace AND the agent
    // conversation, so the next round resets the source tree and continues the
    // same conversation -- the model still holds every file it read, and the
    // bypass agent's evidence drives a focused follow-up edit instead of a cold
    // restart. An *environmental* failure (install, workspace creation, disk,
    // exception) tears the workspace down and rebuilds it fresh next round.
    let workspace: WorkspaceHandle | null = null;
    let priorMessages: FixConversation | undefined;
    let sessionTokens = 0;
    let restoreNeedsPatch = false;
    let scopeCwd: string | null = null;
    let treeSnapshotted = false;
    let verificationDone = false;

    // ---- prewarm the per-repo dependency cache (once, before the loop) ----
    // When eligible, run the networked restore ONCE on a clean tree to populate
    // a per-repo cache volume, then mount it read-only on every attempt so each
    // attempt's restore runs offline (--network=none) against the cache. Only
    // for code fixes (restoreNeedsPatch false) with a developer-taught toolchain
    // -- SCA/dep fixes change the manifests, so their restore must stay
    // networked and post-patch. Default OFF; fully inert unless prewarmCache is
    // set and the SUTURA_PREWARM_DISABLED kill-switch is not engaged.
    let warmCacheVolume: string | null = null;
    const prewarmEligible =
      config.prewarmCache === true &&
      !isPrewarmKillSwitchOn() &&
      !!config.repoToolchain &&
      config.repoToolchain.restoreNeedsPatch !== true;
    if (prewarmEligible) {
      try {
        const warm = await ensureWarmCache({
          runner: this.runner,
          tarball,
          orgId,
          repo: finding.repo,
          toolchainOverride: config.repoToolchain,
          log: (m) => console.warn(m),
        });
        if (warm.ok) warmCacheVolume = warm.volume;
        else console.warn(`[validated-fix] prewarm not usable, falling back to networked restore: ${warm.error ?? ''}`);
      } catch (err) {
        // Prewarm is best-effort: on any failure fall back to the legacy
        // per-attempt networked restore so the pipeline never regresses.
        console.warn('[validated-fix] prewarm threw, falling back to networked restore:', err);
      }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Stop once the finding's cumulative agent-token budget is spent.
      if (sessionTokens >= VALIDATION_LIMITS.SESSION_TOKEN_CEILING) {
        console.warn('[validated-fix] session token ceiling reached; stopping remediation');
        break;
      }

      // ---- ensure a clean workspace for this round ----
      // Reuse the warm workspace from a prior *remediable* round by reverting
      // that round's diff to a clean source tree (dependency/build caches in the
      // snapshot survive, so we skip re-extraction + re-restore). If reset is
      // unavailable or fails, degrade to a fresh rebuild -- the agent
      // conversation is still reused, which is where the token cost lives.
      let freshBuild = false;
      if (workspace && treeSnapshotted) {
        try {
          await this.runner.resetTree(workspace);
          console.warn(`[validated-fix] reusing warm workspace (resetTree) for round ${attempt}`);
        } catch (err) {
          console.warn('[validated-fix] tree reset failed, rebuilding workspace:', err);
          await this.runner.cleanup(workspace).catch(() => {});
          workspace = null;
        }
      } else if (workspace) {
        await this.runner.cleanup(workspace).catch(() => {});
        workspace = null;
      }

      if (!workspace) {
        freshBuild = true;
        treeSnapshotted = false;
        try {
          // Mount the prewarmed cache READ-ONLY when available so this round's
          // restore resolves offline from it; otherwise legacy networked restore.
          workspace = await this.runner.createWorkspace(
            tarball,
            config.repoToolchain || warmCacheVolume
              ? {
                  toolchainOverride: config.repoToolchain,
                  cacheVolume: warmCacheVolume ?? undefined,
                  cacheReadOnly: warmCacheVolume ? true : undefined,
                }
              : undefined,
          );
        } catch (err) {
          if (attempt === 1) {
            return {
              ok: false,
              reason: 'sandbox_unavailable',
              attempts: 0,
              lastFailure: { stage: 'exception', output: String(err) },
            };
          }
          lastFailure = {
            stage: 'exception',
            output: `workspace creation failed: ${String(err)}`,
          };
          continue;
        }
      }

      // Non-null handle for the rest of the round. Teardown sites set the outer
      // `workspace` back to null to force a rebuild next round.
      if (!workspace) continue; // unreachable: build either set it or continued
      const ws: WorkspaceHandle = workspace;

      // ---- pre-fix verification (exploitability) gate ----
      // Run once, before any fix generation, and cache the verdict for reuse.
      // Default-safe: only when enabled, not kill-switched, and a credential is
      // available -- otherwise the pipeline behaves as it did before the gate.
      if (freshBuild && !verificationDone && this.verificationEnabled(config)) {
        verificationDone = true;
        try {
          verdict = await runVerificationAgent({
            anthropicApiKey: config.anthropicApiKey,
            finding,
            workspace: ws,
            runner: this.runner,
          });
        } catch (err) {
          // Never let verification failure block a real fix; proceed without a
          // verdict (legacy behaviour) on unexpected errors.
          console.warn('[validated-fix] verification agent threw, proceeding:', err);
          verdict = null;
        }

        if (verdict) {
          await persistence.updateFindingVerification?.({
            findingId: findingDbId,
            orgId,
            verdict,
          });

          const skip =
            verdict.isReal === false ||
            (verdict.reachable === false && verdict.confidence === 'high');
          if (skip) {
            const reason = verdict.isReal === false
              ? `Verification gate: finding judged not a real vulnerability. ${verdict.reasoning}`
              : `Verification gate: vulnerable code judged unreachable (high confidence). ${verdict.reasoning}`;
            await persistence.markFindingWontFix?.({ findingId: findingDbId, orgId, reason });
            await this.runner.cleanup(ws).catch(() => {});
            workspace = null;
            // Gate decline is a neutral skip, not a failure: the finding is
            // marked wont_fix and the attempt row renders neutrally, not red.
            return {
              ok: false,
              reason: 'skipped',
              skipReason: verdict.isReal === false ? 'not_exploitable' : 'unreachable',
              attempts: 0,
              lastFailure: { stage: 'exception', output: reason },
            };
          }
        }
      }

      const row = await persistence.insertRunningAttempt({
        findingId: findingDbId,
        orgId,
        attemptNumber: attempt,
        parentAttemptId,
      });

      try {
          // ---- toolchain + restore/build scope (computed once per workspace) ----
          // Code fixes (the default) restore the CLEAN tree before the patch so
          // the untrusted patch+test phase runs fully air-gapped; dependency/SCA
          // fixes (whose patch edits the manifest) restore after. We also scope
          // restore + build/test to just the project that contains the finding
          // (nearest enclosing manifest): a bare whole-solution restore drags in
          // unrelated heavyweight graphs that blow the install timeout. Both are
          // stable for the tarball, so on a reused (remediated) workspace we keep
          // the values computed on the fresh build.
          if (freshBuild) {
            const toolchain = await this.runner.detectToolchain(ws);
            restoreNeedsPatch = toolchain.restoreNeedsPatch;
            scopeCwd = restoreNeedsPatch
              ? null
              : await resolveProjectScope(this.runner, ws, finding.filePath);
            if (scopeCwd) {
              console.warn(`[validated-fix] scoping restore+build to ${scopeCwd}`);
            }
          }

          // ---- restore (clean tree) -- code fixes, fresh build only ----
          // Networked normally. When a prewarmed read-only cache is mounted the
          // restore runs OFFLINE (--network=none): the package manager resolves
          // entirely from /cache and writes only the project-local restore state
          // into /work (e.g. obj/project.assets.json), so the build+test phase
          // can run --no-restore air-gapped. On a reused workspace the snapshot
          // already holds the restored state, so this is skipped.
          if (freshBuild && !restoreNeedsPatch) {
            const restoreOpts: { offline?: boolean; cwd?: string } = {};
            if (warmCacheVolume) restoreOpts.offline = true;
            if (scopeCwd) restoreOpts.cwd = scopeCwd;
            const restoreRes = await this.runner.restore(
              ws,
              undefined,
              Object.keys(restoreOpts).length ? restoreOpts : undefined,
            );
            await persistence.recordSandboxLog({
              fixAttemptId: row.id,
              step: 'install', // persisted label kept as 'install' (the dependency step)
              exitCode: restoreRes.exitCode,
              stdout: restoreRes.stdout,
              stderr: restoreRes.stderr,
              durationMs: restoreRes.durationMs,
              timedOut: restoreRes.timedOut,
              command: restoreRes.command,
            });
            if (restoreRes.exitCode !== 0) {
              // Clean-tree restore failure is environmental (not the diff's
              // fault): tear the workspace down and rebuild fresh next round.
              lastFailure = { stage: 'install', output: restoreFailureOutput(restoreRes) };
              await this.failAttempt(persistence, row.id, 'install_failed', lastFailure);
              parentAttemptId = row.id;
              await this.runner.cleanup(ws).catch(() => {});
              workspace = null;
              continue;
            }
          }

          // ---- snapshot the clean, warm tree for cheap per-round resets ----
          // Taken after the restore so resolved dependencies are committed and
          // survive a reset. On failure we simply rebuild each round instead.
          if (freshBuild) {
            try {
              await this.runner.snapshotTree(ws);
              treeSnapshotted = true;
              console.warn('[validated-fix] snapshotTree ok; warm workspace reuse enabled');
            } catch (err) {
              console.warn('[validated-fix] snapshotTree failed; rounds will rebuild:', err);
              treeSnapshotted = false;
            }
          }

          const generated = await generateFixAgentic({
            finding,
            priorAnalysis: config.priorAnalysis,
            retryFeedback: lastFailure
              ? { attemptNumber: attempt, stage: lastFailure.stage, output: lastFailure.output }
              : undefined,
            // Continue the SAME conversation across remediable rounds: the model
            // keeps every file it read and the feedback above drives a focused
            // follow-up edit (e.g. patch the duplicate the bypass agent flagged).
            priorMessages,
            runner: this.runner,
            workspace: ws,
            anthropicApiKey: config.anthropicApiKey,
          });
          priorMessages = generated.messages;
          sessionTokens += generated.tokensUsed;
          await persistence.updateAttempt(row.id, {
            generatedDiff: generated.diff,
            promptSnapshot: generated.promptSnapshot,
            claudeModel: generated.model,
            claudeTokensUsed: generated.tokensUsed,
          });
          await persistence.recordTokenUsage?.({
            findingId: findingDbId,
            fixAttemptId: row.id,
            orgId,
            model: generated.model,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
            prompt: generated.promptSnapshot,
            response: generated.responseText,
          });

          if (!generated.diff) {
            lastFailure = { stage: 'patch', output: 'generator emitted no diff' };
            await this.failAttempt(persistence, row.id, 'no_diff', lastFailure);
            parentAttemptId = row.id;
            continue;
          }

          // ---- patch ----
          const patchResult = await this.runner.applyPatch(ws, generated.diff);
          await persistence.recordSandboxLog({
            fixAttemptId: row.id,
            step: 'patch',
            exitCode: patchResult.ok ? 0 : 1,
            stderr: patchResult.rejects,
            command: patchResult.command,
          });
          if (!patchResult.ok) {
            lastFailure = { stage: 'patch', output: patchResult.rejects ?? 'patch rejected' };
            await this.failAttempt(persistence, row.id, 'patch_reject', lastFailure);
            parentAttemptId = row.id;
            continue;
          }

          // ---- test generation ----
          const tests = await runTestGenerationAgent({
            finding,
            generated,
            workspace: ws,
            runner: this.runner,
            anthropicApiKey: config.anthropicApiKey,
            repoTestEnvPrompt: config.repoTestEnvPrompt,
          });
          await persistence.updateAttempt(row.id, {
            testFilesAdded: tests.files,
          });

          // ---- restore (patched tree) -- networked, dependency/SCA fixes only ----
          // For these the patch edits the manifest, so restore must run after
          // the patch. It still runs the package manager only (no test runner),
          // and build+test below stay air-gapped.
          if (restoreNeedsPatch) {
            const restoreRes = await this.runner.restore(ws);
            await persistence.recordSandboxLog({
              fixAttemptId: row.id,
              step: 'install',
              exitCode: restoreRes.exitCode,
              stdout: restoreRes.stdout,
              stderr: restoreRes.stderr,
              durationMs: restoreRes.durationMs,
              timedOut: restoreRes.timedOut,
              command: restoreRes.command,
            });
            if (restoreRes.exitCode !== 0) {
              lastFailure = { stage: 'install', output: restoreFailureOutput(restoreRes) };
              await this.failAttempt(persistence, row.id, 'install_failed', lastFailure);
              parentAttemptId = row.id;
              continue;
            }
          }

          // Guard the host disk before the (potentially large) offline build.
          await this.runner.assertDiskUnderCeiling(ws).catch((err) => {
            throw new Error(`disk guard: ${err instanceof Error ? err.message : String(err)}`);
          });

          // Validation facts captured for the PR's evidence section.
          let testsOutcome: 'passed' | 'skipped' = 'passed';
          let graderVerdict: string | undefined;
          let bypassChecked = false;

          // ---- tests (build + test, air-gapped: --network=none) ----
          // Scoped to the finding's project when scoping is active: this still
          // compile-verifies the patched project, but a scoped library may have
          // no test project of its own.
          const testRes = await this.runner.runTests(
            ws,
            tests.paths,
            undefined,
            scopeCwd ? { cwd: scopeCwd } : undefined,
          );
          await persistence.recordSandboxLog({
            fixAttemptId: row.id,
            step: 'tests',
            exitCode: testRes.exitCode,
            stdout: testRes.stdout,
            stderr: testRes.stderr,
            durationMs: testRes.durationMs,
            timedOut: testRes.timedOut,
            command: testRes.command,
          });
          if (testRes.exitCode !== 0) {
            // When scoped, the only acceptable non-zero is "the project compiled
            // but has no tests to run" -- the generated regression test is still
            // committed for humans/CI, but it can't execute against a scoped
            // library with no test framework. That's NOT a fix failure: the
            // rescan + adversarial grader remain the authoritative gates. A real
            // compile/test failure (Build FAILED, error CS...) still fails hard.
            const noTestsToRun =
              !!scopeCwd && looksLikeNoTestsToRun(testRes.stdout + '\n' + testRes.stderr);
            if (noTestsToRun) {
              console.warn(
                '[validated-fix] scoped project built but has no runnable tests; ' +
                  'relying on rescan + adversarial gates',
              );
              testsOutcome = 'skipped';
              await persistence.updateAttempt(row.id, {
                testResult: 'skip',
                testOutput: tail(testRes.stdout + '\n' + testRes.stderr),
              });
              // fall through to the rescan gate (do NOT fail the attempt)
            } else {
              lastFailure = { stage: 'tests', output: tail(testRes.stdout + '\n' + testRes.stderr) };
              await persistence.updateAttempt(row.id, {
                testResult: 'fail',
                testOutput: lastFailure.output,
                status: 'failed',
                failureReason: 'tests_failed',
                completedAt: new Date().toISOString(),
              });
              parentAttemptId = row.id;
              continue;
            }
          }

          // ---- rescan ----
          const scan = await runSecurityScan(finding, ws, this.runner, {
            aikidoApiKey: config.aikidoApiKey,
          });
          await persistence.recordSandboxLog({
            fixAttemptId: row.id,
            step: 'scan',
            exitCode: scan.verdict === 'inconclusive' ? -1 : 0,
            stdout: scan.output,
            timedOut: scan.timedOut,
            command: scan.command || `${scan.tool} (no command captured)`,
          });
          if (scan.verdict !== 'resolved') {
            lastFailure = {
              stage: 'rescan',
              output: `${scan.tool}: still ${scan.verdict}. matched=${scan.matched.join(',')}`,
            };
            await persistence.updateAttempt(row.id, {
              testResult: 'pass',
              testOutput: tail(testRes.stdout),
              validationStatus: scan.verdict,
              scanOutput: scan.output,
              scanTool: scan.tool,
              status: 'failed',
              failureReason: 'scan_still_vulnerable',
              completedAt: new Date().toISOString(),
            });
            parentAttemptId = row.id;
            continue;
          }

          // ---- adversarial patch validation ----
          // The rescan says 'resolved', but a single scan can be fooled by a
          // patch that merely masks the symptom, or by a non-deterministic pass.
          // Before trusting the fix we (1) re-verify it independently from a
          // FRESH workspace built off the original tarball (grader), and (2)
          // red-team the patched workspace to prove the vuln is truly gone
          // (bypass agent). Default-safe: only runs when enabled, not
          // kill-switched, and an Anthropic credential is available -- otherwise
          // the pipeline accepts the fix exactly as it did before this gate.
          if (this.adversarialEnabled(config)) {
            const grade = await runAdversarialGrader({
              tarball,
              generated: { diff: generated.diff },
              finding,
              runner: this.runner,
              aikidoApiKey: config.aikidoApiKey,
              toolchainOverride: config.repoToolchain,
            });
            await persistence.recordGraderVerdict?.({
              fixAttemptId: row.id,
              verdict: grade,
            });
            if (!grade.resolved) {
              lastFailure = {
                stage: 'adversarial_validation',
                output: `Independent grader disagreed (${grade.verdict}): ${grade.evidence}`,
              };
              await this.failAttempt(persistence, row.id, 'grader_disagreed', lastFailure);
              parentAttemptId = row.id;
              continue;
            }
            graderVerdict = grade.verdict;

            const bypass = await runBypassAgent({
              workspace: ws,
              finding,
              generated: { diff: generated.diff },
              runner: this.runner,
              anthropicApiKey: config.anthropicApiKey,
            });
            await persistence.recordBypassAttempt?.({
              fixAttemptId: row.id,
              result: bypass,
            });
            if (bypass.bypassed) {
              lastFailure = {
                stage: 'adversarial_validation',
                output: `Bypass agent defeated the fix: ${bypass.evidence}`,
              };
              await this.failAttempt(persistence, row.id, 'bypass_succeeded', lastFailure);
              parentAttemptId = row.id;
              continue;
            }
            bypassChecked = true;
          }

          // ---- persist successful validation BEFORE attempting PR ----
          // The scan/test results are valuable even if PR creation fails
          // (e.g. GitHub App lacks write permission). Save them now so the
          // UI can show "fix validated" on the attempt even when the
          // submitter throws.
          await persistence.updateAttempt(row.id, {
            testResult: 'pass',
            testOutput: tail(testRes.stdout),
            validationStatus: 'resolved',
            scanOutput: scan.output,
            scanTool: scan.tool,
          });

          // ---- open PR ----
          const fixFiles = await this.collectChangedFiles(ws, generated.diff);
          const allFiles = [...fixFiles, ...tests.files];

          // Reviewer-facing narrative: root cause, approach + why, per-file and
          // per-test rationale, and caveats. Best-effort (null -> static body),
          // so PR creation is never blocked on it.
          const narrative = config.anthropicApiKey
            ? await generatePrNarrative({
                finding,
                diff: generated.diff,
                testFiles: tests.files,
                evidence: {
                  scanTool: scan.tool,
                  testsOutcome,
                  bypassChecked,
                  rounds: attempt,
                },
                anthropicApiKey: config.anthropicApiKey,
              })
            : null;

          const pr = await submitMultiFile({
            repo: finding.repo,
            files: allFiles,
            findingId: finding.externalId,
            findingTitle: finding.title,
            severity: finding.severity,
            model: generated.model,
            githubToken: config.githubToken,
            targetBranch: config.targetBranch ?? resolvedBranch,
            reviewers: config.reviewers,
            testFilePaths: tests.files.map((f) => f.path),
            narrative: narrative ?? undefined,
            evidence: {
              scanTool: scan.tool,
              scanResolved: true,
              testsOutcome,
              bypassChecked,
              graderVerdict,
              rounds: attempt,
              tokensUsed: generated.tokensUsed,
            },
          });

          // PR is open but the attempt is not done yet -- the CI watcher
          // decides whether the fix actually builds + passes checks.
          await persistence.updateAttempt(row.id, {
            prUrl: pr.prUrl,
            prStatus: 'open',
            prHeadSha: pr.prHeadSha,
            ciCheckStatus: 'pending',
          });

          // ---- wait for CI verdict ----
          const ciVerdict = await awaitCiVerdict({
            githubToken: config.githubToken,
            repo: finding.repo,
            headSha: pr.prHeadSha,
            timeoutMs: config.ciTimeoutMs,
            onPoll: ({ elapsedMs, statusLine }) => {
              console.log(
                `[ci-watcher] ${finding.repo}@${pr.prHeadSha.slice(0, 7)} ${statusLine} (${Math.round(elapsedMs / 1000)}s elapsed)`,
              );
            },
          });

          await persistence.updateAttempt(row.id, {
            ciCheckStatus: ciVerdict.verdict,
            ciFailureLogs: ciVerdict.failureLogs || null,
            ciPolledAt: ciVerdict.polledAt,
          });

          if (ciVerdict.verdict === 'failure') {
            // Mark this attempt failed and let the loop decide whether to
            // retry or exhaust. On retry, ciFailureLogs flows into the next
            // agent iteration as feedback so the agent sees real CI output.
            lastFailure = { stage: 'ci', output: ciVerdict.failureLogs };
            await persistence.updateAttempt(row.id, {
              status: 'failed',
              failureReason: 'ci_failed',
              completedAt: new Date().toISOString(),
            });
            parentAttemptId = row.id;
            continue;
          }

          // CI passed (or timed out / was unavailable, e.g. missing Checks:
          // Read permission -- we accept and let the user check GitHub
          // directly). PR stays open; mark the attempt succeeded.
          await persistence.updateAttempt(row.id, {
            status: 'succeeded',
            completedAt: new Date().toISOString(),
          });

          await this.runner.cleanup(ws).catch(() => {});
          workspace = null;
          return {
            ok: true,
            attemptId: row.id,
            prUrl: pr.prUrl,
            branchName: pr.branchName,
            attempts: attempt,
            testFiles: tests.files,
          };
        } catch (err) {
          // Unexpected errors are environmental: tear the workspace down and
          // rebuild fresh on the next round.
          lastFailure = { stage: 'exception', output: String(err) };
          await this.failAttempt(persistence, row.id, 'exception', lastFailure);
          parentAttemptId = row.id;
          await this.runner.cleanup(ws).catch(() => {});
          workspace = null;
        }
        // No `finally` cleanup: a *remediable* failure intentionally keeps the
        // workspace warm so the next round can resetTree() and continue the same
        // conversation. Environmental teardown is handled explicitly above.
      }

      // Loop exhausted. Release any workspace still held from the last
      // (remediable) round.
      if (workspace) {
        await this.runner.cleanup(workspace).catch(() => {});
        workspace = null;
      }

      // Mark the last attempt as exhausted (it's currently 'failed').
      if (parentAttemptId) {
        await persistence.updateAttempt(parentAttemptId, {
          status: 'exhausted',
          completedAt: new Date().toISOString(),
        });
      }
      return {
        ok: false,
        reason: 'exhausted',
        attempts: maxAttempts,
        lastFailure: lastFailure ?? undefined,
      };
  }

  /**
   * Whether the pre-fix verification gate should run for this job. Default-safe:
   * the verifier is invoked only when explicitly not disabled (flag undefined or
   * true), the process-wide kill-switch is off, and an Anthropic credential is
   * present. Without a credential the legacy path (no gate) is preserved so
   * existing tests that don't mock a verifier keep passing.
   */
  private verificationEnabled(config: ValidatedFixDeps['config']): boolean {
    if (config.verifyBeforeFix === false) return false;
    if (isVerifyKillSwitchOn()) return false;
    return Boolean(config.anthropicApiKey);
  }

  /**
   * Whether adversarial patch validation (independent grader + bypass agent)
   * should run for this job. Default-safe: invoked only when explicitly not
   * disabled (flag undefined or true), the process-wide kill-switch is off, and
   * an Anthropic credential is present. Without a credential the legacy path
   * (accept on rescan 'resolved') is preserved so existing pipeline tests that
   * don't mock a grader/bypass keep passing.
   */
  private adversarialEnabled(config: ValidatedFixDeps['config']): boolean {
    if (config.adversarialValidation === false) return false;
    if (isAdversarialKillSwitchOn()) return false;
    return Boolean(config.anthropicApiKey);
  }

  private async failAttempt(
    persistence: ValidatedFixDeps['persistence'],
    id: string,
    reason: string,
    failure: AttemptFailure,
  ): Promise<void> {
    await persistence.updateAttempt(id, {
      status: 'failed',
      failureReason: reason,
      testOutput: failure.output,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Read the post-patch contents of every file touched by the diff so
   * submitMultiFile can write them via the GitHub API.
   */
  private async collectChangedFiles(
    ws: WorkspaceHandle,
    diff: string,
  ): Promise<FixAttemptTestFile[]> {
    const paths = parseDiffPaths(diff);
    const out: FixAttemptTestFile[] = [];
    for (const path of paths) {
      const content = await this.runner.readFile(ws, path).catch(() => null);
      if (content !== null) out.push({ path, content });
    }
    return out;
  }
}

// ---------------- helpers ----------------

function parseDiffPaths(diff: string): string[] {
  const set = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) set.add(line.slice(6).trim());
  }
  return Array.from(set);
}

function tail(s: string): string {
  return s.length > TAIL_BYTES ? s.slice(s.length - TAIL_BYTES) : s;
}

/**
 * Diagnostics for a failed restore. Combine BOTH streams (stdout first, then
 * stderr) so the real cause survives. A bare `stderr || stdout` masks the
 * truth for .NET: `dotnet restore` prints a harmless "verifying workloads"
 * warning to stderr (the SDK can't write its advertising manifest to the
 * read-only rootfs), while the actual error that made restore exit non-zero
 * lands on stdout -- so stderr-only diagnostics always hid the real failure.
 */
function restoreFailureOutput(res: { stdout: string; stderr: string }): string {
  const parts: string[] = [];
  if (res.stdout.trim()) parts.push(res.stdout.trim());
  if (res.stderr.trim()) parts.push(`[stderr]\n${res.stderr.trim()}`);
  return tail(parts.join('\n') || res.stdout || res.stderr);
}

const PRIOR_ANALYSIS_MAX_BYTES = 12_000;

/**
 * If a prior analysis markdown is supplied (typically the dashboard's
 * Analyze output), prepend it to the prompt so the fix agent sees it as
 * priming context. Capped at PRIOR_ANALYSIS_MAX_BYTES to keep the prompt
 * bounded -- on overflow we keep the tail (which contains the recommended
 * fix and proposed diff sections).
 */
export function prependPriorAnalysis(base: string, priorAnalysis: string | undefined): string {
  if (!priorAnalysis || priorAnalysis.trim().length === 0) return base;
  const trimmed =
    priorAnalysis.length > PRIOR_ANALYSIS_MAX_BYTES
      ? priorAnalysis.slice(priorAnalysis.length - PRIOR_ANALYSIS_MAX_BYTES)
      : priorAnalysis;
  return [
    '## Prior Analysis',
    '',
    'A separate analysis agent already inspected this finding and produced the report below.',
    'Treat the *Recommended Fix* and *Proposed Diff* sections as expert hints -- but verify them',
    'against the actual file contents in the next sections before emitting your unified diff.',
    '',
    trimmed,
    '',
    '---',
    '',
    base,
  ].join('\n');
}

function appendFailureFeedback(base: string, failure: AttemptFailure, attempt: number): string {
  return [
    base,
    '',
    `## Previous attempt #${attempt - 1} failed at stage \`${failure.stage}\`. Use this output to revise your fix:`,
    '```',
    failure.output.slice(-4000),
    '```',
    '',
    'Generate a corrected unified diff. The patch will be re-applied to the original repo and re-tested.',
  ].join('\n');
}
