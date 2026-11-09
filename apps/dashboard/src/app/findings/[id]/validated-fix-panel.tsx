'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  triggerValidatedFix,
  fetchValidatedFixStatus,
  fetchTestOutput,
  type ValidatedFixAttempt,
  type ValidatedFixStatus,
  type TestOutputResponse,
} from '@/lib/backend-client';
import type { Finding } from '@/types';

export interface UseValidatedFix {
  status: ValidatedFixStatus | null;
  busy: boolean;
  error: string | null;
  output: TestOutputResponse | null;
  outputAttemptId: string | null;
  hasAttempts: boolean;
  awaitingWorker: boolean;
  trigger: (opts?: { priorAnalysis?: string; finding?: Finding }) => Promise<void>;
  toggleOutput: (attemptId: string) => Promise<void>;
}

/**
 * Owns validated-fix state for a finding so the trigger button (rendered in
 * the page's Actions card) and the result panel (rendered inline below the
 * proposed diff) stay in sync. The panel itself is intentionally
 * presentation-only.
 */
const POST_TRIGGER_POLL_MS = 30_000;

export function useValidatedFix(findingId: string): UseValidatedFix {
  const [status, setStatus] = useState<ValidatedFixStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<TestOutputResponse | null>(null);
  const [outputAttemptId, setOutputAttemptId] = useState<string | null>(null);
  const [awaitingWorker, setAwaitingWorker] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const awaitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Attempt count observed at the moment of the last trigger. The grace window
  // must close only when a *new* attempt appears beyond this baseline -- a retry
  // on a finding that already has attempts (e.g. a prior failure) would
  // otherwise cancel the window immediately and stop polling before the new
  // run's row is inserted, leaving the UI stale until a manual refresh.
  const triggerBaselineRef = useRef(0);
  const latestCountRef = useRef(0);

  const refresh = useCallback(async () => {
    // The host page renders this hook with an empty id on the first paint while
    // the finding is still loading. Skip the fetch until we have a real id --
    // otherwise the status poll hits `/api/.../findings//validated-fix/status`,
    // which collapses to a 404 in the browser console on every page load.
    if (!findingId) return;
    try {
      const s = await fetchValidatedFixStatus(findingId);
      setStatus(s);
      setError(null);
      latestCountRef.current = s.attempts.length;
      // Worker has reported back -- stop the post-trigger grace window once a
      // new attempt (beyond the pre-trigger baseline) appears, or one is running.
      if (s.attempts.length > triggerBaselineRef.current || s.running) {
        setAwaitingWorker(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status');
    }
  }, [findingId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while the pipeline is running OR we just triggered and are waiting
  // for the worker to insert the first attempt row.
  useEffect(() => {
    const shouldPoll = status?.running || awaitingWorker;
    if (!shouldPoll) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(refresh, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.running, awaitingWorker, refresh]);

  const trigger = useCallback(
    async (opts: { priorAnalysis?: string; finding?: Finding } = {}) => {
      setBusy(true);
      setError(null);
      // Snapshot the current attempt count so the grace window below closes only
      // when the worker inserts a *new* row beyond this point (see refresh()).
      triggerBaselineRef.current = latestCountRef.current;
      try {
        await triggerValidatedFix(findingId, {
          priorAnalysis: opts.priorAnalysis,
          finding: opts.finding,
        });
        // Open a grace window: poll status frequently for up to 30s so the
        // worker's first attempt row (or pre-loop failure row) shows up
        // promptly. Cleared either when an attempt appears (in `refresh`) or
        // when the timeout fires.
        setAwaitingWorker(true);
        if (awaitTimeoutRef.current) clearTimeout(awaitTimeoutRef.current);
        awaitTimeoutRef.current = setTimeout(
          () => setAwaitingWorker(false),
          POST_TRIGGER_POLL_MS,
        );
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to trigger validated fix');
        setAwaitingWorker(false);
      } finally {
        setBusy(false);
      }
    },
    [findingId, refresh],
  );

  useEffect(() => {
    return () => {
      if (awaitTimeoutRef.current) clearTimeout(awaitTimeoutRef.current);
    };
  }, []);

  const toggleOutput = useCallback(async (attemptId: string) => {
    if (outputAttemptId === attemptId) {
      setOutputAttemptId(null);
      setOutput(null);
      return;
    }
    try {
      const data = await fetchTestOutput(attemptId);
      setOutput(data);
      setOutputAttemptId(attemptId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load test output');
    }
  }, [outputAttemptId]);

  return {
    status,
    busy,
    error,
    output,
    outputAttemptId,
    hasAttempts: (status?.attempts.length ?? 0) > 0,
    awaitingWorker,
    trigger,
    toggleOutput,
  };
}

interface PanelProps {
  state: UseValidatedFix;
}

interface AttemptGroupData {
  attemptNumber: number;
  runs: ValidatedFixAttempt[];
}

function groupByAttempt(attempts: ValidatedFixAttempt[]): AttemptGroupData[] {
  const groups: AttemptGroupData[] = [];
  for (const run of attempts) {
    const last = groups[groups.length - 1];
    if (last && last.attemptNumber === run.attemptNumber) {
      last.runs.push(run);
    } else {
      groups.push({ attemptNumber: run.attemptNumber, runs: [run] });
    }
  }
  return groups;
}

export function ValidatedFixPanel({ state }: PanelProps) {
  const { status, error, output, outputAttemptId, awaitingWorker, toggleOutput } = state;
  const lastAttempt = status?.attempts.at(-1) ?? null;
  const lastSucceeded = status?.attempts.find((a) => a.status === 'succeeded') ?? null;
  const hasAttempts = (status?.attempts.length ?? 0) > 0;

  const groups = useMemo(
    () => groupByAttempt(status?.attempts ?? []),
    [status?.attempts],
  );
  const latestAttemptNumber = groups.at(-1)?.attemptNumber ?? null;
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  // Seed expansion: keep only the latest group open by default; preserve
  // manual toggles across polls by only seeding keys not yet present.
  useEffect(() => {
    if (latestAttemptNumber == null) return;
    setExpanded((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const g of groups) {
        if (!(g.attemptNumber in next)) {
          next[g.attemptNumber] = g.attemptNumber === latestAttemptNumber;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups, latestAttemptNumber]);

  const toggle = useCallback((attemptNumber: number) => {
    setExpanded((prev) => ({ ...prev, [attemptNumber]: !prev[attemptNumber] }));
  }, []);

  // Hide entirely until there's something to show (an attempt, an error, or
  // a job we just enqueued and are waiting on).
  if (!hasAttempts && !error && !awaitingWorker) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold text-navy">Validated Fix</h2>

      {error && (
        <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      {!hasAttempts && awaitingWorker && (
        <p className="mb-3 rounded bg-blue-50 px-3 py-2 text-xs text-blue-700">
          Job enqueued. Waiting for the worker to start the first attempt...
        </p>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <AttemptGroup
              key={g.attemptNumber}
              group={g}
              isExpanded={expanded[g.attemptNumber] ?? false}
              onToggle={() => toggle(g.attemptNumber)}
              output={output}
              outputAttemptId={outputAttemptId}
              toggleOutput={toggleOutput}
            />
          ))}
          {lastSucceeded?.prUrl && (
            <a
              href={lastSucceeded.prUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block rounded-md border border-orange bg-orange/10 px-3 py-1.5 text-xs font-semibold text-orange"
            >
              View PR -- {new URL(lastSucceeded.prUrl).pathname}
            </a>
          )}
          {lastAttempt?.status === 'exhausted' && (
            <p className="mt-1 text-xs text-red-700">
              All {lastAttempt.attemptNumber} attempts failed. Last reason:{' '}
              <code>{lastAttempt.failureReason ?? 'unknown'}</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function groupTone(status: ValidatedFixAttempt['status']): string {
  switch (status) {
    case 'succeeded':
      return 'bg-green-50 border-green-200 text-green-800';
    case 'running':
      return 'bg-blue-50 border-blue-200 text-blue-800';
    case 'failed':
    case 'exhausted':
      return 'bg-red-50 border-red-200 text-red-800';
    // 'skipped' is a neutral decline (gate judged not exploitable/unreachable,
    // or triage below threshold) -- render it gray, never red.
    default:
      return 'bg-gray-50 border-border text-gray-text';
  }
}

function AttemptGroup({
  group,
  isExpanded,
  onToggle,
  output,
  outputAttemptId,
  toggleOutput,
}: {
  group: AttemptGroupData;
  isExpanded: boolean;
  onToggle: () => void;
  output: TestOutputResponse | null;
  outputAttemptId: string | null;
  toggleOutput: (attemptId: string) => Promise<void> | void;
}) {
  const runningRun = group.runs.find((r) => r.status === 'running');
  const finalRun = runningRun ?? group.runs[group.runs.length - 1];
  const headerTone = groupTone(finalRun.status);
  const runCount = group.runs.length;

  // Auto-open the group when an output is showing for one of its rows so the
  // user never sees an output block detached from its row.
  const containsOpenOutput = outputAttemptId
    ? group.runs.some((r) => r.id === outputAttemptId)
    : false;
  const effectiveExpanded = isExpanded || containsOpenOutput;

  return (
    <div className="rounded-md border border-border bg-cream-warm/40">
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-xs ${headerTone}`}
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`inline-block transition-transform ${effectiveExpanded ? 'rotate-90' : ''}`}
          >
            &rsaquo;
          </span>
          <span className="font-mono font-semibold">Attempt #{group.attemptNumber}</span>
          <span className="font-semibold uppercase">{finalRun.status ?? '--'}</span>
          {runCount > 1 && <span className="opacity-80">{runCount} runs</span>}
          {!effectiveExpanded && finalRun.failureReason && (
            <span className="opacity-80">reason: {finalRun.failureReason}</span>
          )}
        </div>
      </button>
      {effectiveExpanded && (
        <div className="flex flex-col gap-2 px-2 pb-2 pt-2">
          {group.runs.map((r) => (
            <div key={r.id} className="flex flex-col gap-2">
              <AttemptRow
                attempt={r}
                isOutputOpen={outputAttemptId === r.id}
                onToggleOutput={() => toggleOutput(r.id)}
                hideAttemptNumber
              />
              {output && outputAttemptId === r.id && <OutputBlock data={output} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AttemptRow({
  attempt,
  isOutputOpen,
  onToggleOutput,
  hideAttemptNumber = false,
}: {
  attempt: ValidatedFixAttempt;
  isOutputOpen: boolean;
  onToggleOutput: () => void;
  hideAttemptNumber?: boolean;
}) {
  const tone = groupTone(attempt.status);

  return (
    <div className={`flex items-center justify-between rounded border px-3 py-2 text-xs ${tone}`}>
      <div className="flex items-center gap-3">
        {!hideAttemptNumber && <span className="font-mono">#{attempt.attemptNumber}</span>}
        <span className="font-semibold uppercase">{attempt.status ?? '--'}</span>
        {attempt.testResult && <span>tests: {attempt.testResult}</span>}
        {attempt.validationStatus && (
          <span>
            scan ({attempt.scanTool ?? '?'}): {attempt.validationStatus}
          </span>
        )}
        {attempt.failureReason && <span>reason: {attempt.failureReason}</span>}
      </div>
      <button
        onClick={onToggleOutput}
        className="rounded border border-current px-2 py-0.5 text-[11px]"
      >
        {isOutputOpen ? 'Hide output' : 'View output'}
      </button>
    </div>
  );
}

function OutputBlock({ data }: { data: TestOutputResponse }) {
  return (
    <div className="rounded-md border border-border bg-cream-warm p-3 text-xs">
      <div className="mb-2 flex flex-wrap gap-3">
        <span>
          tests: <strong>{data.testResult ?? '--'}</strong>
        </span>
        <span>
          scan: <strong>{data.validationStatus ?? '--'}</strong> ({data.scanTool ?? '--'})
        </span>
        {data.durations.testsMs != null && <span>{data.durations.testsMs}ms tests</span>}
        {data.durations.scanMs != null && <span>{data.durations.scanMs}ms scan</span>}
      </div>
      {data.testFilesAdded && data.testFilesAdded.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 font-semibold">Tests added</p>
          <ul className="ml-4 list-disc">
            {data.testFilesAdded.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.testOutput && (
        <details className="mb-2" open>
          <summary className="cursor-pointer font-semibold">Test output</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px]">
            {data.testOutput}
          </pre>
        </details>
      )}
      {data.scanOutput && (
        <details>
          <summary className="cursor-pointer font-semibold">Scan output</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px]">
            {data.scanOutput}
          </pre>
        </details>
      )}
    </div>
  );
}
