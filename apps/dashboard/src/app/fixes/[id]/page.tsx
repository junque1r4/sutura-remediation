'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { DiffViewer } from '@/components/diff-viewer';
import {
  fetchFixAttempt,
  fetchSandboxLogs,
  fetchTestOutput,
  type SandboxLogEntry,
  type TestOutputResponse,
} from '@/lib/backend-client';
import type { FixAttemptRow } from '@/types';
import { skipLabel } from '@/lib/fixes-utils';

const STAGE_TONE: Record<string, string> = {
  green: 'bg-status-success/15 text-status-success',
  red: 'bg-status-failed/15 text-status-failed',
  amber: 'bg-severity-bg-medium text-severity-medium',
  blue: 'bg-status-open/15 text-status-open',
  gray: 'bg-cream-warm text-gray-text',
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-severity-bg-critical text-severity-critical',
  high: 'bg-severity-bg-high text-severity-high',
  medium: 'bg-severity-bg-medium text-severity-medium',
  low: 'bg-severity-bg-low text-severity-low',
};

function deriveStage(row: FixAttemptRow): { label: string; tone: keyof typeof STAGE_TONE } {
  if (row.status === 'running') return { label: 'Running', tone: 'blue' };
  if (row.status === 'skipped') return { label: skipLabel(row.failureReason), tone: 'gray' };
  if (row.prUrl) return { label: 'PR opened', tone: 'green' };
  if (row.failureReason === 'sandbox_unavailable')
    return { label: 'Sandbox unavailable', tone: 'red' };
  if (row.failureReason === 'kill_switch') return { label: 'Killed', tone: 'gray' };
  if (row.status === 'exhausted') return { label: 'Retries exhausted', tone: 'amber' };
  if (row.validationStatus === 'still_vulnerable')
    return { label: 'Re-scan failed', tone: 'red' };
  if (row.validationStatus === 'inconclusive') return { label: 'Re-scan inconclusive', tone: 'amber' };
  if (row.testResult === 'fail') return { label: 'Tests failed', tone: 'red' };
  if (row.failureReason === 'exception') return { label: 'Pipeline error', tone: 'red' };
  if (row.status === 'failed') return { label: row.failureReason ?? 'Failed', tone: 'red' };
  if (row.status === 'succeeded') return { label: 'Succeeded', tone: 'green' };
  return { label: row.status ?? '—', tone: 'gray' };
}

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 100) / 10;
  return `${secs}s`;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return '<1s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

// Orchestrator order: patch is applied first (it's what gates the rest of the
// pipeline), then dependencies install, tests run, scanner re-checks, cleanup.
const STEP_ORDER: SandboxLogEntry['step'][] = ['patch', 'install', 'tests', 'scan', 'cleanup'];

const STEP_DEFINITIONS: Record<
  SandboxLogEntry['step'],
  { label: string; description: string }
> = {
  install: {
    label: 'Install dependencies',
    description:
      "Installs the project's dependencies inside the sandbox using the detected toolchain (npm / yarn / pnpm / pip).",
  },
  patch: {
    label: 'Apply patch',
    description:
      "Applies the unified diff Claude generated to the workspace via `git apply`. Falls back to `patch -p1` when git rejects context drift.",
  },
  tests: {
    label: 'Run tests',
    description:
      "Runs the project's existing test suite plus the regression tests Claude generated for this fix.",
  },
  scan: {
    label: 'Security re-scan',
    description:
      'Re-runs the security scanner against the patched workspace to confirm the original vulnerability is no longer detected.',
  },
  cleanup: {
    label: 'Cleanup',
    description: 'Tears down the sandbox container and frees workspace volumes.',
  },
};

type StepStatus = 'success' | 'failed' | 'timed_out' | 'pending';

function deriveStepStatus(log: SandboxLogEntry): StepStatus {
  if (log.timedOut) return 'timed_out';
  if (log.exitCode == null) return 'pending';
  return log.exitCode === 0 ? 'success' : 'failed';
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'timed_out') {
    return (
      <span
        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-severity-medium text-[10px] font-bold text-white"
        title="Timed out"
      >
        !
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-status-failed text-[10px] font-bold text-white"
        title="Failed"
      >
        ✕
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span
        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-muted text-[10px] font-bold text-white"
        title="No exit code"
      >
        ?
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-status-success text-[10px] font-bold text-white"
      title="Success"
    >
      ✓
    </span>
  );
}

type Tab = 'tests' | 'scan' | 'prompt' | 'ci';

export default function FixAttemptDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [attempt, setAttempt] = useState<FixAttemptRow | null>(null);
  const [logs, setLogs] = useState<SandboxLogEntry[]>([]);
  const [output, setOutput] = useState<TestOutputResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('tests');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, l, o] = await Promise.all([
          fetchFixAttempt(id),
          fetchSandboxLogs(id).catch(() => ({ data: [] as SandboxLogEntry[] })),
          fetchTestOutput(id).catch(() => null),
        ]);
        if (cancelled) return;
        setAttempt(a);
        setLogs(l.data);
        setOutput(o);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load fix attempt');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    // While the attempt is running, poll every 3s to surface new sandbox steps.
    const t = setInterval(() => {
      if (attempt?.status === 'running') load();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, attempt?.status]);

  const stage = useMemo(() => (attempt ? deriveStage(attempt) : null), [attempt]);

  if (loading) {
    return <PageHeader title="Loading attempt..." />;
  }
  if (error || !attempt) {
    return (
      <PageHeader
        title="Fix attempt not found"
        subtitle={error ?? 'No attempt with this id.'}
      />
    );
  }

  const headerActions = attempt.prUrl ? (
    <a
      href={attempt.prUrl}
      target="_blank"
      rel="noreferrer"
      className="rounded bg-navy px-3 py-1.5 text-xs font-medium text-cream hover:bg-navy/90"
    >
      Open PR &rarr;
    </a>
  ) : null;

  return (
    <>
      <PageHeader
        title={attempt.findingTitle ?? 'Fix attempt'}
        subtitle={`Attempt #${attempt.attemptNumber}${attempt.parentAttemptId ? ' (retry)' : ''} · ${formatDuration(attempt.createdAt, attempt.completedAt)}${attempt.claudeTokensUsed ? ` · ${attempt.claudeTokensUsed.toLocaleString()} tokens` : ''}`}
        breadcrumbs={[
          { label: 'Fix History', href: '/fixes' },
          { label: `#${attempt.attemptNumber}` },
        ]}
        actions={headerActions}
      />

      {/* Header chips ------------------------------------------------------ */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {stage && (
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_TONE[stage.tone]}`}
          >
            {stage.label}
          </span>
        )}
        {attempt.findingSeverity && (
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase ${SEVERITY_STYLES[attempt.findingSeverity] ?? 'bg-cream-warm text-gray-text'}`}
          >
            {attempt.findingSeverity}
          </span>
        )}
        {attempt.findingRepo && (
          <span className="rounded bg-cream-warm px-2 py-0.5 text-[11px] text-navy">
            {attempt.findingRepo}
          </span>
        )}
        {attempt.claudeModel && (
          <span className="rounded bg-cream-warm px-2 py-0.5 text-[11px] text-navy">
            {attempt.claudeModel}
          </span>
        )}
        <Link
          href={
            attempt.findingScanner && attempt.findingExternalId
              ? `/findings/${attempt.findingScanner}-${attempt.findingExternalId}`
              : `/findings/${attempt.findingId}`
          }
          className="text-[11px] text-gray-text underline-offset-2 hover:text-navy hover:underline"
        >
          View finding &rarr;
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_2fr]">
        {/* Timeline -------------------------------------------------------- */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-navy">Timeline</h2>
          {logs.length === 0 ? (
            attempt.status === 'running' ? (
              <div className="rounded-lg border border-border bg-cream-warm/40 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-status-open">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-status-open" />
                  Agent reasoning
                </div>
                <div className="mt-1 text-xs text-gray-text">
                  {attempt.claudeTokensUsed > 0
                    ? `Claude has used ${attempt.claudeTokensUsed.toLocaleString()} tokens so far. Sandbox steps (patch / install / tests / scan) will appear here once the agent emits a diff.`
                    : 'The fix agent is exploring the workspace. Sandbox steps will appear here once it emits a diff.'}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-cream-warm/40 p-4">
                <div className="text-xs font-semibold text-status-failed">
                  Pre-sandbox failure
                </div>
                <div className="mt-1 text-xs text-gray-text">
                  {attempt.failureReason
                    ? `Reason: ${attempt.failureReason}`
                    : 'The pipeline aborted before any sandbox step ran.'}
                </div>
                {attempt.testOutput && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] text-navy">
                    {attempt.testOutput}
                  </pre>
                )}
              </div>
            )
          ) : (
            <ol className="space-y-2">
              {STEP_ORDER.flatMap((step) =>
                logs.filter((l) => l.step === step).map((l) => <StepRow key={l.id} log={l} />),
              )}
              {attempt.status === 'running' && (
                <InProgressRow attempt={attempt} logs={logs} />
              )}
            </ol>
          )}
        </section>

        {/* Diff + tabs ----------------------------------------------------- */}
        <section className="space-y-6">
          <div>
            <h2 className="mb-3 text-sm font-semibold text-navy">Generated Diff</h2>
            {attempt.generatedDiff ? (
              <DiffViewer diff={attempt.generatedDiff} />
            ) : attempt.status === 'running' ? (
              <div className="rounded-lg border border-border bg-cream-warm/40 p-4 text-xs text-gray-text">
                Agent is reasoning &mdash; the diff will appear here as soon as it emits one.
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-cream-warm/40 p-4 text-xs text-gray-text">
                Claude was never called &mdash; the pipeline aborted before generation.
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1 border-b border-border">
              {(['tests', 'scan', 'prompt', 'ci'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium capitalize ${
                    tab === t
                      ? 'border-navy text-navy'
                      : 'border-transparent text-gray-text hover:text-navy'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <OutputTab tab={tab} attempt={attempt} output={output} />
          </div>
        </section>
      </div>
    </>
  );
}

function OutputTab({
  tab,
  attempt,
  output,
}: {
  tab: Tab;
  attempt: FixAttemptRow;
  output: TestOutputResponse | null;
}) {
  if (tab === 'tests') {
    const text = output?.testOutput ?? attempt.testOutput;
    return (
      <Block
        empty={!text}
        emptyLabel="No test output captured."
      >
        {text}
      </Block>
    );
  }
  if (tab === 'scan') {
    const text = output?.scanOutput ?? attempt.scanOutput;
    return (
      <Block empty={!text} emptyLabel="No scanner output captured.">
        {text}
      </Block>
    );
  }
  if (tab === 'prompt') {
    return (
      <Block
        empty={!attempt.promptSnapshot}
        emptyLabel="No prompt snapshot stored."
        head={4096}
      >
        {attempt.promptSnapshot}
      </Block>
    );
  }
  return <CiTab attempt={attempt} />;
}

const CI_STATUS_TONE: Record<string, { label: string; tone: 'default' | 'stderr' }> = {
  success: { label: 'CI passed', tone: 'default' },
  failure: { label: 'CI failed', tone: 'stderr' },
  error: { label: 'CI errored', tone: 'stderr' },
  timed_out: { label: 'CI timed out', tone: 'stderr' },
  pending: { label: 'CI pending', tone: 'default' },
};

/**
 * Surface the CI watcher's verdict + captured logs for the PR opened by this
 * attempt. Empty state covers two cases:
 *   1. The attempt never opened a PR -- nothing to watch.
 *   2. The PR is open but the watcher hasn't polled yet (Phase 2 not shipped,
 *      or just landed and hasn't run for this attempt).
 */
function CiTab({ attempt }: { attempt: FixAttemptRow }) {
  const status = attempt.ciCheckStatus ?? null;
  const logs = attempt.ciFailureLogs ?? null;

  if (!attempt.prUrl) {
    return (
      <div className="rounded-lg border border-border bg-cream-warm/40 p-4 text-xs text-gray-text">
        No PR was opened for this attempt -- there are no CI checks to report.
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-lg border border-border bg-cream-warm/40 p-4 text-xs text-gray-text">
        CI watcher hasn&apos;t reported a verdict for this PR yet.
        {attempt.prUrl && (
          <>
            {' '}
            <a
              href={attempt.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-navy underline-offset-2 hover:underline"
            >
              Check GitHub Actions directly
            </a>
            .
          </>
        )}
      </div>
    );
  }

  const meta = CI_STATUS_TONE[status] ?? { label: `CI ${status}`, tone: 'default' as const };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            meta.tone === 'stderr'
              ? 'bg-status-failed/15 text-status-failed'
              : status === 'success'
                ? 'bg-status-success/15 text-status-success'
                : 'bg-status-open/15 text-status-open'
          }`}
        >
          {meta.label}
        </span>
        {attempt.prHeadSha && (
          <span className="rounded bg-cream-warm px-2 py-0.5 font-mono text-[11px] text-navy">
            {attempt.prHeadSha.slice(0, 7)}
          </span>
        )}
      </div>
      <Block
        empty={!logs}
        emptyLabel={
          status === 'success'
            ? 'No failure logs -- all checks green.'
            : 'CI watcher reported a verdict but captured no logs.'
        }
        tone={meta.tone}
      >
        {logs}
      </Block>
    </div>
  );
}

function Block({
  children,
  empty,
  emptyLabel,
  tone = 'default',
  head,
}: {
  children: string | null | undefined;
  empty: boolean;
  emptyLabel: string;
  tone?: 'default' | 'stderr';
  /** When set, shows only the first N chars by default with a toggle to
   *  expand. Useful for verbose snapshots (prompts) where the head is enough
   *  to skim and the tail is rarely needed. */
  head?: number;
}) {
  if (empty) {
    return (
      <div className="rounded-lg border border-border bg-cream-warm/40 p-4 text-xs text-gray-text">
        {emptyLabel}
      </div>
    );
  }
  const toneCls =
    tone === 'stderr'
      ? 'border-status-failed/30 bg-status-failed/5 text-navy'
      : 'border-border bg-white text-navy';

  if (head != null && children && children.length > head) {
    return <TruncatedBlock content={children} head={head} toneCls={toneCls} />;
  }

  return (
    <pre
      className={`max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-[11px] leading-relaxed ${toneCls}`}
    >
      {children}
    </pre>
  );
}

function TruncatedBlock({
  content,
  head,
  toneCls,
}: {
  content: string;
  head: number;
  toneCls: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const remainingChars = content.length - head;
  const visible = expanded ? content : content.slice(0, head);

  return (
    <div>
      <pre
        className={`max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-[11px] leading-relaxed ${toneCls}`}
      >
        {visible}
        {!expanded && (
          <span className="text-gray-text">{`\n\n… ${remainingChars.toLocaleString()} more characters truncated`}</span>
        )}
      </pre>
      <div className="mt-1 flex items-center gap-3 text-[11px]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-navy underline-offset-2 hover:underline"
        >
          {expanded ? 'Collapse' : `Show full (${content.length.toLocaleString()} chars)`}
        </button>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(content).catch(() => {});
          }}
          className="text-gray-text underline-offset-2 hover:text-navy hover:underline"
        >
          copy
        </button>
      </div>
    </div>
  );
}

/**
 * The orchestrator runs phases in the order:
 *   generate (agent) → patch → test_gen (agent) → install → tests → scan → PR
 *
 * Only patch/install/tests/scan write a sandbox_log row; the two agent loops
 * and the PR submit are silent. While a `running` attempt is between logged
 * phases the user sees nothing — so we infer the *current* phase from
 * (status, generatedDiff, set of completed log steps) and render a pulsing
 * row at the bottom of the timeline.
 */
function inferRunningPhase(
  attempt: FixAttemptRow,
  logs: SandboxLogEntry[],
): { label: string; description: string } | null {
  if (attempt.status !== 'running') return null;

  const has = (step: SandboxLogEntry['step']) => logs.some((l) => l.step === step);

  if (!attempt.generatedDiff && !has('patch')) {
    const tokens = attempt.claudeTokensUsed?.toLocaleString() ?? '0';
    return {
      label: 'Generating fix',
      description: `The agent is exploring the workspace via read_file / list_directory / grep_code and emitting a unified diff. ${tokens} tokens used so far.`,
    };
  }
  if (has('patch') && !has('install')) {
    return {
      label: 'Generating regression tests',
      description:
        'A second agent loop is writing tests that should pass after the fix and fail before it. Once tests are authored, the sandbox installs dependencies.',
    };
  }
  if (has('install') && !has('tests')) {
    return {
      label: 'Running tests',
      description:
        "Executing the project's test suite plus the regression tests just generated.",
    };
  }
  if (has('tests') && !has('scan')) {
    return {
      label: 'Re-scanning workspace',
      description:
        'Running the security scanner against the patched workspace to confirm the vulnerability is resolved.',
    };
  }
  if (has('scan') && !attempt.prUrl) {
    return {
      label: 'Opening pull request',
      description:
        'Pushing the fix branch and opening a PR via the GitHub App. The PR URL will appear in the header once it lands.',
    };
  }

  return { label: 'Working', description: '' };
}

function InProgressRow({
  attempt,
  logs,
}: {
  attempt: FixAttemptRow;
  logs: SandboxLogEntry[];
}) {
  const phase = inferRunningPhase(attempt, logs);
  if (!phase) return null;

  // Elapsed since the last log row (or attempt start if there are none).
  const lastLogTime = logs.length ? new Date(logs[logs.length - 1].createdAt).getTime() : new Date(attempt.createdAt).getTime();
  const elapsedMs = Date.now() - lastLogTime;

  return (
    <li>
      <div className="rounded-lg border border-status-open/30 bg-status-open/5 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-gray-text">▶</span>
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-status-open"
            title="Running"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-cream" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-semibold text-navy">{phase.label}</span>
              <span className="rounded bg-status-open/15 px-1.5 py-0.5 font-mono text-[10px] text-status-open">
                running
              </span>
            </div>
            {phase.description && (
              <div className="mt-0.5 line-clamp-2 text-[11px] text-gray-text">
                {phase.description}
              </div>
            )}
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-gray-text">
            {formatMs(elapsedMs)}
          </span>
        </div>
      </div>
    </li>
  );
}

/**
 * One row in the CI-style Timeline. Header reads
 *   [icon] Install dependencies  npm install · 60.8s · exit 0
 * Body (collapsible <details>) shows description + stdout + stderr.
 * Failed/timed-out rows auto-expand so issues surface without a click.
 */
function StepRow({ log }: { log: SandboxLogEntry }) {
  const status = deriveStepStatus(log);
  const def = STEP_DEFINITIONS[log.step] ?? {
    label: log.step,
    description: '',
  };
  const expanded = status === 'failed' || status === 'timed_out';
  const hasStdout = !!log.stdout && log.stdout.trim().length > 0;
  const hasStderr = !!log.stderr && log.stderr.trim().length > 0;

  return (
    <li>
      <details
        open={expanded}
        className="group rounded-lg border border-border bg-white open:shadow-sm"
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 hover:bg-cream-warm/60">
          {/* chevron */}
          <span className="text-[10px] text-gray-text transition-transform group-open:rotate-90">
            ▶
          </span>
          <StepIcon status={status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-semibold text-navy">{def.label}</span>
              {log.timedOut && (
                <span className="rounded bg-severity-bg-medium px-1.5 py-0.5 text-[10px] text-severity-medium">
                  timed out
                </span>
              )}
            </div>
            {log.command && (
              <div className="mt-0.5 truncate font-mono text-[10px] text-gray-text">
                $ {log.command}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-gray-text">
            <span>{formatMs(log.durationMs)}</span>
            {log.exitCode != null && (
              <span
                className={`rounded px-1.5 py-0.5 font-mono ${
                  log.exitCode === 0
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-status-failed/15 text-status-failed'
                }`}
              >
                exit {log.exitCode}
              </span>
            )}
          </div>
        </summary>

        <div className="space-y-3 border-t border-border bg-cream-warm/20 px-4 py-3 text-xs">
          {def.description && (
            <p className="text-gray-text">{def.description}</p>
          )}

          <LogStream label="stdout" content={log.stdout} hasContent={hasStdout} />
          <LogStream label="stderr" content={log.stderr} hasContent={hasStderr} tone="stderr" />
        </div>
      </details>
    </li>
  );
}

function LogStream({
  label,
  content,
  hasContent,
  tone = 'default',
}: {
  label: string;
  content: string | null;
  hasContent: boolean;
  tone?: 'default' | 'stderr';
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-text">
          {label}
        </span>
        {hasContent && content && (
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(content).catch(() => {});
            }}
            className="text-[10px] text-gray-text underline-offset-2 hover:text-navy hover:underline"
          >
            copy
          </button>
        )}
      </div>
      <Block
        empty={!hasContent}
        emptyLabel={`(no ${label})`}
        tone={tone}
      >
        {content}
      </Block>
    </div>
  );
}
