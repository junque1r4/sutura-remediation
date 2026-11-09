import { VALIDATION_LIMITS } from '@sutura/common';
import type { NormalizedFinding, SerializedToolchain } from '@sutura/common';
import {
  runSecurityScan,
  type SandboxRunner,
  type WorkspaceHandle,
} from '@sutura/sandbox-runner';
import type { GraderVerdict } from './types';
import { resolveProjectScope, looksLikeNoTestsToRun } from './scope';

export interface AdversarialGraderInput {
  /** Original repository tarball (pre-patch) -- a FRESH workspace is built from it. */
  tarball: Buffer;
  /** The candidate fix produced by the generator. */
  generated: { diff: string };
  finding: NormalizedFinding;
  runner: SandboxRunner;
  /** Aikido credential forwarded to the independent rescan. */
  aikidoApiKey?: string;
  /** Developer-taught toolchain forwarded to the fresh grader workspace so the
   *  independent re-run uses the same environment as the main pipeline. */
  toolchainOverride?: SerializedToolchain;
}

/**
 * Independent grader for a candidate fix. Rather than trusting the orchestrator's
 * own patch/test/scan run, this spins up a FRESH workspace from the original
 * (pre-patch) tarball, re-applies the generated diff, and re-runs install +
 * tests + security scan from scratch. A fix is `resolved` only when the rescan
 * verdict is 'resolved' AND the tests pass -- a stricter, second opinion that
 * catches non-deterministic or workspace-poisoned passes.
 *
 * Conservative by design: any internal failure (patch reject, sandbox error,
 * scan inconclusive) returns `verdict: 'inconclusive'` with evidence instead of
 * throwing, so a grader hiccup never crashes the surrounding pipeline. The fresh
 * workspace is always cleaned up.
 */
export async function runAdversarialGrader(
  input: AdversarialGraderInput,
): Promise<GraderVerdict> {
  const { tarball, generated, finding, runner, aikidoApiKey, toolchainOverride } = input;

  if (!generated.diff || generated.diff.trim().length === 0) {
    return {
      resolved: false,
      verdict: 'inconclusive',
      evidence: 'Grader received an empty diff; nothing to re-verify.',
    };
  }

  let workspace: WorkspaceHandle | null = null;
  const deadline = Date.now() + VALIDATION_LIMITS.GRADER_TIMEOUT_MS;
  const remaining = () => Math.max(0, deadline - Date.now());

  try {
    // ---- fresh workspace from the ORIGINAL tarball ----
    workspace = await runner.createWorkspace(
      tarball,
      toolchainOverride ? { toolchainOverride } : undefined,
    );

    // Same air-gap invariant as the orchestrator: for code fixes restore the
    // CLEAN tree before re-applying the patch, so the patched re-verify runs
    // with no network. Only dependency/SCA fixes restore after the patch.
    const restoreNeedsPatch =
      toolchainOverride?.restoreNeedsPatch ??
      ((await runner.detectToolchain(workspace)) as { restoreNeedsPatch?: boolean })
        .restoreNeedsPatch ??
      false;

    // Mirror the orchestrator: scope restore + build/test to the finding's
    // project for clean-tree code fixes, so the independent re-verify doesn't
    // re-pay (and choke on) a whole multi-project solution restore.
    const scopeCwd = restoreNeedsPatch
      ? null
      : await resolveProjectScope(runner, workspace, finding.filePath);

    if (!restoreNeedsPatch) {
      const restoreRes = await runner.restore(
        workspace,
        remaining(),
        scopeCwd ? { cwd: scopeCwd } : undefined,
      );
      if (restoreRes.exitCode !== 0) {
        return {
          resolved: false,
          verdict: 'inconclusive',
          evidence:
            'Grader restore step failed independently; cannot confirm the fix. ' +
            tail(restoreRes.stderr || restoreRes.stdout),
        };
      }
    }

    // ---- re-apply the candidate diff ----
    const patchResult = await runner.applyPatch(workspace, generated.diff);
    if (!patchResult.ok) {
      return {
        resolved: false,
        verdict: 'fail',
        evidence:
          'Grader could not re-apply the generated diff to a fresh workspace: ' +
          (patchResult.rejects || 'patch rejected'),
      };
    }

    // ---- restore (patched tree) -- dependency/SCA fixes only ----
    if (restoreNeedsPatch) {
      const restoreRes = await runner.restore(workspace, remaining());
      if (restoreRes.exitCode !== 0) {
        return {
          resolved: false,
          verdict: 'inconclusive',
          evidence:
            'Grader restore step failed independently; cannot confirm the fix. ' +
            tail(restoreRes.stderr || restoreRes.stdout),
        };
      }
    }

    // ---- independent tests ----
    // No explicit paths: re-run the project's default test command so the grader
    // exercises the suite the way CI would, not just the patch-author's tests.
    const testRes = await runner.runTests(workspace, [], remaining(), scopeCwd ? { cwd: scopeCwd } : undefined);
    // A scoped library that compiled but has no runnable tests is not a failure:
    // the independent rescan remains the gate (matches the orchestrator).
    const testsPassed =
      testRes.exitCode === 0 ||
      (!!scopeCwd && looksLikeNoTestsToRun(testRes.stdout + '\n' + testRes.stderr));

    // ---- independent rescan ----
    const scan = await runSecurityScan(finding, workspace, runner, { aikidoApiKey });
    const scanResolved = scan.verdict === 'resolved';

    const resolved = scanResolved && testsPassed;
    const verdict: GraderVerdict['verdict'] = resolved
      ? 'pass'
      : scan.verdict === 'inconclusive'
        ? 'inconclusive'
        : 'fail';

    const evidence = [
      `Independent re-verification from a fresh workspace.`,
      `Tests: ${testsPassed ? 'pass' : 'fail'} (exit ${testRes.exitCode}).`,
      `Scan (${scan.tool}): ${scan.verdict}${scan.matched.length ? ` matched=${scan.matched.join(',')}` : ''}.`,
    ].join(' ');

    return {
      resolved,
      verdict,
      evidence,
    };
  } catch (err) {
    return {
      resolved: false,
      verdict: 'inconclusive',
      evidence: `Grader encountered an internal error and could not re-verify: ${String(err)}`,
    };
  } finally {
    if (workspace) await runner.cleanup(workspace).catch(() => {});
  }
}

const TAIL_BYTES = 4 * 1024;

function tail(s: string): string {
  if (!s) return '';
  return s.length > TAIL_BYTES ? s.slice(s.length - TAIL_BYTES) : s;
}
