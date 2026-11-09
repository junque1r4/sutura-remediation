import { Octokit } from '@octokit/rest';

export type CiVerdict = 'success' | 'failure' | 'timed_out' | 'unavailable';

export interface AwaitCiVerdictInput {
  githubToken: string;
  /** "owner/repo" form. */
  repo: string;
  /** SHA of the PR head commit (returned by submitter). */
  headSha: string;
  /** Hard cap on total wait time. Default 10 min. */
  timeoutMs?: number;
  /** Spacing between polls. Default 30 s. */
  pollIntervalMs?: number;
  /** Optional progress callback for the worker logger. */
  onPoll?: (info: {
    elapsedMs: number;
    totalChecks: number;
    completedChecks: number;
    statusLine: string;
  }) => void;
}

export interface AwaitCiVerdictResult {
  verdict: CiVerdict;
  /** Concatenated head/tail of failure logs across failing jobs. Empty when
   *  verdict is 'success' or no logs could be retrieved. */
  failureLogs: string;
  /** ISO timestamp when polling concluded. */
  polledAt: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const FAIL_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);
const LOG_HEAD_BYTES = 8 * 1024;
const LOG_TAIL_BYTES = 8 * 1024;
const MAX_LOG_TOTAL_BYTES = 64 * 1024;

/**
 * Poll GitHub check_runs for the given commit SHA until they all complete or
 * the timeout fires. On any failing check, fetch the corresponding workflow
 * job logs and trim head + tail so the result fits in a retry prompt.
 *
 * Pure function over Octokit -- the caller persists the verdict.
 */
export async function awaitCiVerdict(input: AwaitCiVerdictInput): Promise<AwaitCiVerdictResult> {
  const {
    githubToken,
    repo,
    headSha,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onPoll,
  } = input;

  const octokit = new Octokit({ auth: githubToken });
  const [owner, repoName] = repo.split('/');
  const start = Date.now();

  // GitHub creates check_runs lazily once a workflow boots. Tolerate an empty
  // first response by polling again rather than declaring success on a
  // freshly-pushed commit with no checks yet.
  let consecutiveEmptyPolls = 0;
  const MAX_EMPTY_POLLS_BEFORE_DECLARING_NO_CI = 4;
  let consecutiveErrorPolls = 0;
  const MAX_ERROR_POLLS_BEFORE_GIVING_UP = 3;

  for (;;) {
    const elapsedMs = Date.now() - start;
    if (elapsedMs > timeoutMs) {
      return { verdict: 'timed_out', failureLogs: '', polledAt: new Date().toISOString() };
    }

    // A CI verdict is best-effort bookkeeping on an already-open PR: an API
    // error here must degrade to 'unavailable', never throw -- a throw fails
    // the whole attempt and the retry opens a duplicate PR.
    let data: Awaited<ReturnType<typeof octokit.checks.listForRef>>['data'];
    try {
      ({ data } = await octokit.checks.listForRef({
        owner,
        repo: repoName,
        ref: headSha,
        per_page: 100,
      }));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        // Permission 403 cannot heal mid-poll: the GitHub App is missing
        // Checks: Read on this installation.
        console.warn(
          `[ci-watcher] cannot read check runs for ${repo} (403 - grant the GitHub App ` +
            "'Checks: Read-only' and accept the updated permissions on the installation); " +
            'reporting CI verdict as unavailable.',
        );
        return { verdict: 'unavailable', failureLogs: '', polledAt: new Date().toISOString() };
      }
      consecutiveErrorPolls++;
      if (consecutiveErrorPolls >= MAX_ERROR_POLLS_BEFORE_GIVING_UP) {
        console.warn(
          `[ci-watcher] giving up on check runs for ${repo} after ${consecutiveErrorPolls} failed polls: ${String(err).slice(0, 200)}`,
        );
        return { verdict: 'unavailable', failureLogs: '', polledAt: new Date().toISOString() };
      }
      await sleep(pollIntervalMs);
      continue;
    }
    consecutiveErrorPolls = 0;

    const runs = data.check_runs;

    if (runs.length === 0) {
      consecutiveEmptyPolls++;
      if (consecutiveEmptyPolls >= MAX_EMPTY_POLLS_BEFORE_DECLARING_NO_CI) {
        // Treat "no checks ever appeared" as success -- the repo simply has
        // no CI configured for this branch. Better than waiting 10 min.
        return {
          verdict: 'success',
          failureLogs: '',
          polledAt: new Date().toISOString(),
        };
      }
      onPoll?.({
        elapsedMs,
        totalChecks: 0,
        completedChecks: 0,
        statusLine: 'no checks reported yet',
      });
      await sleep(pollIntervalMs);
      continue;
    }
    consecutiveEmptyPolls = 0;

    const completedChecks = runs.filter((r) => r.status === 'completed').length;
    const allDone = completedChecks === runs.length;
    onPoll?.({
      elapsedMs,
      totalChecks: runs.length,
      completedChecks,
      statusLine: allDone
        ? `all ${runs.length} complete`
        : `${completedChecks}/${runs.length} complete`,
    });

    if (!allDone) {
      await sleep(pollIntervalMs);
      continue;
    }

    const failed = runs.filter(
      (r) => r.conclusion && FAIL_CONCLUSIONS.has(r.conclusion),
    );
    if (failed.length === 0) {
      return { verdict: 'success', failureLogs: '', polledAt: new Date().toISOString() };
    }

    const failureLogs = await fetchFailureLogs(
      octokit,
      owner,
      repoName,
      headSha,
      failed.map((r) => ({ name: r.name, conclusion: r.conclusion ?? 'failure' })),
    );

    return { verdict: 'failure', failureLogs, polledAt: new Date().toISOString() };
  }
}

interface FailedCheckSummary {
  name: string;
  conclusion: string;
}

/**
 * Map failed check_runs back to their workflow jobs by intersecting on the
 * head SHA, then download per-job logs. We use the Actions API directly
 * rather than chasing `check_run.external_id` because Octokit's check_run
 * shape doesn't always include a stable job-id link.
 */
async function fetchFailureLogs(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  failedChecks: FailedCheckSummary[],
): Promise<string> {
  const sections: string[] = [];
  let totalBytes = 0;

  try {
    const { data: wfRuns } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: headSha,
      per_page: 50,
    });

    for (const run of wfRuns.workflow_runs) {
      if (!run.conclusion || !FAIL_CONCLUSIONS.has(run.conclusion)) continue;

      const { data: jobsData } = await octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: run.id,
        per_page: 50,
      });

      for (const job of jobsData.jobs) {
        if (!job.conclusion || !FAIL_CONCLUSIONS.has(job.conclusion)) continue;

        const header = `=== ${run.name ?? 'workflow'} / ${job.name} (job ${job.id}, ${job.conclusion}) ===`;
        let body = '';
        try {
          const logRes = await octokit.actions.downloadJobLogsForWorkflowRun({
            owner,
            repo,
            job_id: job.id,
          });
          body = trimLog(coerceLogPayload(logRes.data));
        } catch (err) {
          body = `(failed to download logs: ${String(err).slice(0, 200)})`;
        }

        const block = `${header}\n${body}`;
        if (totalBytes + block.length > MAX_LOG_TOTAL_BYTES) {
          sections.push('(further logs truncated -- total log budget exceeded)');
          totalBytes = MAX_LOG_TOTAL_BYTES;
          break;
        }
        sections.push(block);
        totalBytes += block.length;
      }
      if (totalBytes >= MAX_LOG_TOTAL_BYTES) break;
    }
  } catch (err) {
    sections.push(`(failed to enumerate workflow runs: ${String(err).slice(0, 200)})`);
  }

  // Fall back to a check-name summary when no workflow logs were retrievable
  // (third-party CI providers, or the App lacks Actions: Read permission).
  if (sections.length === 0) {
    sections.push('(no GitHub Actions logs available; check-run summary follows)');
    for (const c of failedChecks) {
      sections.push(`- ${c.name}: ${c.conclusion}`);
    }
  }

  return sections.join('\n\n');
}

function coerceLogPayload(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  // Octokit may surface logs as a NodeJS Readable in some environments; not a
  // shape we hit in production. Stringify defensively.
  return String(data);
}

function trimLog(s: string): string {
  if (s.length <= LOG_HEAD_BYTES + LOG_TAIL_BYTES) return s;
  const head = s.slice(0, LOG_HEAD_BYTES);
  const tail = s.slice(s.length - LOG_TAIL_BYTES);
  const omitted = s.length - LOG_HEAD_BYTES - LOG_TAIL_BYTES;
  return `${head}\n\n... (${omitted.toLocaleString()} bytes truncated) ...\n\n${tail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
