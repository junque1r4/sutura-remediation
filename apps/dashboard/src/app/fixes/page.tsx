'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import type { FixAttemptRow } from '@/types';
import { fetchFixes } from '@/lib/backend-client';
import {
  deriveStage,
  durationStr,
  groupRuns,
  modelLabel,
  STAGE_BADGE,
  timeAgo,
  useNow,
  type Run,
} from '@/lib/fixes-utils';

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-severity-bg-critical text-severity-critical',
  high: 'bg-severity-bg-high text-severity-high',
  medium: 'bg-severity-bg-medium text-severity-medium',
  low: 'bg-severity-bg-low text-severity-low',
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FixesPage() {
  const [fixes, setFixes] = useState<FixAttemptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasRunning = useMemo(() => fixes.some((f) => f.status === 'running'), [fixes]);
  const now = useNow(1000, hasRunning);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchFixes({ pageSize: 100 });
        if (!cancelled) setFixes(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load fixes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const t = setInterval(() => {
      if (hasRunning) load();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hasRunning]);

  const runs = useMemo(() => {
    const grouped = groupRuns(fixes);
    return grouped.sort(
      (a, b) => new Date(b.head.createdAt).getTime() - new Date(a.head.createdAt).getTime(),
    );
  }, [fixes]);

  const summary = useMemo(() => {
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    for (const r of runs) {
      if (r.latest.status === 'running') running++;
      else if (r.latest.prUrl) succeeded++;
      else failed++;
    }
    return { running, succeeded, failed };
  }, [runs]);

  const subtitle = loading
    ? 'Loading fix attempts...'
    : error
      ? `Backend unavailable - ${error}`
      : `${runs.length} run${runs.length === 1 ? '' : 's'} (${fixes.length} total attempt${fixes.length === 1 ? '' : 's'}) · ${summary.running} running · ${summary.succeeded} succeeded · ${summary.failed} failed`;

  return (
    <>
      <PageHeader title="Fix History" subtitle={subtitle} />
      {runs.length === 0 ? (
        <div className="rounded-lg border border-border bg-white px-4 py-8 text-center text-sm text-gray-text">
          {loading ? 'Loading…' : 'No fix attempts yet.'}
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <RunCard key={run.head.id} run={run} now={now} />
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Run card -- header summarizes the run; expanding shows the attempt chain.
// ---------------------------------------------------------------------------

function RunCard({ run, now }: { run: Run; now: number }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const stage = deriveStage(run.latest);
  const totalTokens = run.all.reduce((sum, a) => sum + (a.claudeTokensUsed ?? 0), 0);
  const totalDuration = durationStr(run.head.createdAt, run.latest.completedAt, now);
  const hasChain = run.descendants.length > 0;
  // Click anywhere on the head -> open the latest attempt's detail page,
  // since that's where the run's outcome / live state lives.
  const targetHref = `/fixes/${run.latest.id}`;

  return (
    <div className="rounded-lg border border-border bg-white">
      <div
        className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-cream-warm/60"
        onClick={() => router.push(targetHref)}
      >
        {hasChain ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => !x);
            }}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] text-gray-text hover:bg-cream-warm hover:text-navy"
            aria-label={expanded ? 'Collapse attempts' : 'Expand attempts'}
            aria-expanded={expanded}
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="inline-block h-5 w-5 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="truncate font-medium text-navy"
              title={run.head.findingTitle ?? undefined}
            >
              {run.head.findingTitle ?? '(unknown finding)'}
            </span>
            {hasChain && (
              <span className="rounded bg-cream-warm px-1.5 py-0.5 text-[10px] font-medium text-gray-text">
                {run.all.length} attempts
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-text">
            {run.head.findingSeverity && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                  SEVERITY_STYLES[run.head.findingSeverity] ?? 'bg-cream-warm text-gray-text'
                }`}
              >
                {run.head.findingSeverity}
              </span>
            )}
            <span
              className="truncate"
              title={run.head.findingRepo ?? run.head.repo ?? ''}
            >
              {run.head.findingRepo ?? run.head.repo ?? '—'}
            </span>
            {run.latest.claudeModel && (
              <>
                <span>·</span>
                <span>{modelLabel(run.latest.claudeModel)}</span>
              </>
            )}
            {totalTokens > 0 && (
              <>
                <span>·</span>
                <span className="tabular-nums">{totalTokens.toLocaleString()} tokens</span>
              </>
            )}
            <span>·</span>
            <span
              className={`tabular-nums ${run.latest.status === 'running' ? 'font-medium text-status-open' : ''}`}
            >
              {totalDuration}
            </span>
          </div>
        </div>

        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STAGE_BADGE[stage.tone]}`}
        >
          {stage.tone === 'blue' && (
            <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-open" />
          )}
          {stage.label}
        </span>

        <span
          className="hidden shrink-0 text-[11px] text-gray-text sm:inline"
          title={new Date(run.head.createdAt).toLocaleString()}
        >
          {timeAgo(run.head.createdAt, now)}
        </span>
      </div>

      {expanded && hasChain && (
        <ol className="border-t border-border bg-cream-warm/30">
          {run.all.map((a, i) => (
            <AttemptSubrow
              key={a.id}
              attempt={a}
              now={now}
              isLast={i === run.all.length - 1}
              onClick={() => router.push(`/fixes/${a.id}`)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function AttemptSubrow({
  attempt,
  now,
  isLast,
  onClick,
}: {
  attempt: FixAttemptRow;
  now: number;
  isLast: boolean;
  onClick: () => void;
}) {
  const stage = deriveStage(attempt);
  return (
    <li
      onClick={onClick}
      className={`relative flex cursor-pointer items-center gap-3 py-2 pl-10 pr-4 hover:bg-cream-warm ${
        isLast ? '' : 'border-b border-border-light'
      }`}
    >
      {/* Vertical guideline visually anchoring the chain to the chevron */}
      <span className="absolute left-7 top-0 h-full w-px bg-border" aria-hidden />

      <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium text-navy">
        #{attempt.attemptNumber}
      </span>

      <div className="min-w-0 flex-1 text-[12px] text-navy">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STAGE_BADGE[stage.tone]}`}
          >
            {stage.tone === 'blue' && (
              <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-open" />
            )}
            {stage.label}
          </span>
          {attempt.claudeTokensUsed > 0 && (
            <span className="tabular-nums text-[11px] text-gray-text">
              {attempt.claudeTokensUsed.toLocaleString()} tokens
            </span>
          )}
          <span className="text-[11px] text-gray-text">
            · {durationStr(attempt.createdAt, attempt.completedAt, now)}
          </span>
        </div>
      </div>

      <span
        className="text-[11px] text-gray-text"
        title={new Date(attempt.createdAt).toLocaleString()}
      >
        {timeAgo(attempt.createdAt, now)}
      </span>
    </li>
  );
}
