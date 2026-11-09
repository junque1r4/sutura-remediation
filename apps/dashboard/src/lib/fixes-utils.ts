import { useEffect, useState } from 'react';
import type { FixAttemptRow } from '@/types';

// ---------------------------------------------------------------------------
// Stage helper -- reduces (status, failure_reason, validation_status, ...) to
// a single badge so the user can scan a list of attempts at a glance.
// ---------------------------------------------------------------------------

export type StageTone = 'green' | 'red' | 'amber' | 'blue' | 'gray';

export interface Stage {
  label: string;
  tone: StageTone;
}

/**
 * Human label for a neutral 'skipped' attempt -- the pipeline deliberately
 * declined to fix the finding. Distinct from a failure: never red.
 */
export function skipLabel(failureReason: string | null): string {
  switch (failureReason) {
    case 'not_exploitable':
      return 'Skipped: not exploitable';
    case 'unreachable':
      return 'Skipped: unreachable';
    case 'below_threshold':
      return 'Skipped: below threshold';
    default:
      return 'Skipped';
  }
}

export function deriveStage(row: FixAttemptRow): Stage {
  if (row.status === 'running') return { label: 'Running', tone: 'blue' };
  if (row.status === 'skipped') return { label: skipLabel(row.failureReason), tone: 'gray' };
  if (row.prUrl) return { label: 'PR opened', tone: 'green' };
  if (row.failureReason === 'sandbox_unavailable')
    return { label: 'Sandbox unavailable', tone: 'red' };
  if (row.failureReason === 'kill_switch') return { label: 'Killed', tone: 'gray' };
  if (row.status === 'exhausted') return { label: 'Retries exhausted', tone: 'amber' };
  if (row.validationStatus === 'still_vulnerable')
    return { label: 'Re-scan failed', tone: 'red' };
  if (row.validationStatus === 'inconclusive')
    return { label: 'Re-scan inconclusive', tone: 'amber' };
  if (row.testResult === 'fail') return { label: 'Tests failed', tone: 'red' };
  if (row.failureReason === 'exception') return { label: 'Pipeline error', tone: 'red' };
  if (row.status === 'failed') return { label: row.failureReason ?? 'Failed', tone: 'red' };
  if (row.status === 'succeeded') return { label: 'Succeeded', tone: 'green' };
  return { label: row.status ?? '—', tone: 'gray' };
}

export const STAGE_BADGE: Record<StageTone, string> = {
  green: 'bg-status-success/15 text-status-success',
  red: 'bg-status-failed/15 text-status-failed',
  amber: 'bg-severity-bg-medium text-severity-medium',
  blue: 'bg-status-open/15 text-status-open',
  gray: 'bg-cream-warm text-gray-text',
};

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function durationStr(start: string, end: string | null, now: number): string {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : now;
  const ms = endMs - startMs;
  if (ms < 1000) return '<1s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso: string, now: number): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return RTF.format(Math.round(diff), 'second');
  if (abs < 3600) return RTF.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return RTF.format(Math.round(diff / 3600), 'hour');
  return RTF.format(Math.round(diff / 86_400), 'day');
}

export function modelLabel(model: string): string {
  if (!model) return '—';
  if (model.toLowerCase().includes('opus')) return 'Opus';
  if (model.toLowerCase().includes('sonnet')) return 'Sonnet';
  if (model.toLowerCase().includes('haiku')) return 'Haiku';
  return model;
}

// ---------------------------------------------------------------------------
// Live-tick hook so running rows keep counting up without polling the backend
// ---------------------------------------------------------------------------

export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

// ---------------------------------------------------------------------------
// Grouping -- a "run" is a chain of attempts linked via parent_attempt_id.
// Heads (parent_attempt_id === null) anchor the run; each retry attaches a
// new attempt that points back to its predecessor. Walking children gives the
// chronological chain.
// ---------------------------------------------------------------------------

export interface Run {
  /** First attempt of the run -- anchors metadata (finding, repo, severity). */
  head: FixAttemptRow;
  /** Tail of the chain in attempt-number order. Empty when the run is single-shot. */
  descendants: FixAttemptRow[];
  /** Convenience: head + descendants, in chronological order. */
  all: FixAttemptRow[];
  /** The most recent attempt -- the run's effective state. */
  latest: FixAttemptRow;
}

export function groupRuns(attempts: FixAttemptRow[]): Run[] {
  const childrenOf = new Map<string, FixAttemptRow[]>();
  for (const a of attempts) {
    if (a.parentAttemptId) {
      if (!childrenOf.has(a.parentAttemptId)) childrenOf.set(a.parentAttemptId, []);
      childrenOf.get(a.parentAttemptId)!.push(a);
    }
  }
  const heads = attempts.filter((a) => !a.parentAttemptId);
  return heads.map((head) => {
    const descendants: FixAttemptRow[] = [];
    let cursor: FixAttemptRow | undefined = head;
    while (cursor) {
      const kids = (childrenOf.get(cursor.id) ?? []).slice().sort(
        (a, b) => a.attemptNumber - b.attemptNumber,
      );
      if (kids.length === 0) break;
      descendants.push(...kids);
      cursor = kids[kids.length - 1];
    }
    const all = [head, ...descendants];
    return { head, descendants, all, latest: all[all.length - 1] };
  });
}
