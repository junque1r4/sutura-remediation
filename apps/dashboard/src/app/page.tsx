'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { TrendChart, type TrendPoint } from '@/components/charts/trend-chart';
import type { SeverityRow } from '@/components/charts/severity-distribution-chart';
import { fetchAuditLog, fetchFixes } from '@/lib/backend-client';
import {
  deriveStage,
  groupRuns,
  STAGE_BADGE,
  timeAgo,
  useNow,
  type Run,
} from '@/lib/fixes-utils';
import type { AuditLogEntry, FixAttemptRow } from '@/types';

interface OverviewResponse {
  openFindings: { total: number; bySeverity: SeverityRow[] };
  mttrHours: { value: number | null; delta: number | null; sampleSize: number };
  autoFixSuccessRate: {
    value: number | null;
    delta: number | null;
    succeeded: number;
    total: number;
  };
  costUsd: { value: number; delta: number };
}

function formatHours(h: number | null): string {
  if (h === null) return '--';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function formatPercent(v: number | null): string {
  if (v === null) return '--';
  return `${Math.round(v * 100)}%`;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-severity-bg-critical text-severity-critical',
  high: 'bg-severity-bg-high text-severity-high',
  medium: 'bg-severity-bg-medium text-severity-medium',
  low: 'bg-severity-bg-low text-severity-low',
};

function SectionCard({
  title,
  headerLink,
  children,
}: {
  title: string;
  headerLink?: { label: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-navy">{title}</h2>
        {headerLink && (
          <Link
            href={headerLink.href}
            className="text-xs font-medium text-orange hover:underline"
          >
            {headerLink.label} →
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

export default function HomePage() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  const [fixes, setFixes] = useState<FixAttemptRow[]>([]);
  const [fixesLoading, setFixesLoading] = useState(true);
  const [fixesError, setFixesError] = useState<string | null>(null);

  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState<string | null>(null);

  const hasRunning = useMemo(() => fixes.some((f) => f.status === 'running'), [fixes]);
  const now = useNow(1000, hasRunning);

  // Analytics KPIs + trend (backend-backed, same numbers as /analytics)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [oRes, tRes] = await Promise.all([
          fetch('/api/analytics/overview?range=30d', { cache: 'no-store' }),
          fetch('/api/analytics/trend?range=30d', { cache: 'no-store' }),
        ]);
        if (!oRes.ok || !tRes.ok) {
          throw new Error(`HTTP ${!oRes.ok ? oRes.status : tRes.status}`);
        }
        const o = (await oRes.json()) as OverviewResponse;
        const t = (await tRes.json()) as { data: TrendPoint[] };
        if (cancelled) return;
        setOverview(o);
        setTrend(t.data);
      } catch (err) {
        if (!cancelled) {
          setAnalyticsError(err instanceof Error ? err.message : 'Failed to load metrics');
        }
      } finally {
        if (!cancelled) setAnalyticsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recent fix runs -- polled every 5s while a run is in progress
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchFixes({ pageSize: 50 });
        if (!cancelled) {
          setFixes(res.data);
          setFixesError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setFixesError(err instanceof Error ? err.message : 'Failed to load fixes');
        }
      } finally {
        if (!cancelled) setFixesLoading(false);
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

  // Recent audit-log activity
  useEffect(() => {
    let cancelled = false;
    fetchAuditLog({ pageSize: 8 })
      .then((res) => {
        if (!cancelled) setAudit(res.data);
      })
      .catch((err) => {
        if (!cancelled) {
          setAuditError(err instanceof Error ? err.message : 'Failed to load activity');
        }
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runs = useMemo(
    () =>
      groupRuns(fixes)
        .sort(
          (a, b) => new Date(b.head.createdAt).getTime() - new Date(a.head.createdAt).getTime(),
        )
        .slice(0, 6),
    [fixes],
  );

  return (
    <>
      <PageHeader title="Overview" subtitle="Vulnerability remediation at a glance" />

      {analyticsError && (
        <div className="mb-4 rounded-md border border-status-failed/30 bg-status-failed/5 p-3 text-sm text-status-failed">
          Could not load metrics: {analyticsError}
        </div>
      )}

      {/* KPIs -- backend-backed, consistent with the Analytics page */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/findings?status=open" className="block transition-opacity hover:opacity-80">
          <StatCard
            label="Open findings"
            value={analyticsLoading ? '--' : (overview?.openFindings.total ?? 0)}
            breakdown={overview?.openFindings.bySeverity}
          />
        </Link>
        <Link href="/analytics" className="block transition-opacity hover:opacity-80">
          <StatCard
            label="MTTR"
            value={analyticsLoading ? '--' : formatHours(overview?.mttrHours.value ?? null)}
            delta={
              overview?.mttrHours.delta != null
                ? { value: overview.mttrHours.delta, suffix: 'h', goodWhen: 'down' }
                : null
            }
          />
        </Link>
        <Link href="/analytics" className="block transition-opacity hover:opacity-80">
          <StatCard
            label="Auto-fix success"
            value={
              analyticsLoading
                ? '--'
                : formatPercent(overview?.autoFixSuccessRate.value ?? null)
            }
            delta={
              overview?.autoFixSuccessRate.delta != null
                ? {
                    value: overview.autoFixSuccessRate.delta * 100,
                    suffix: 'pp',
                    goodWhen: 'up',
                  }
                : null
            }
          />
        </Link>
        <Link href="/token-costs" className="block transition-opacity hover:opacity-80">
          <StatCard
            label="Claude cost (30d)"
            value={analyticsLoading ? '--' : formatUsd(overview?.costUsd.value ?? 0)}
            delta={
              overview
                ? { value: overview.costUsd.delta, suffix: ' USD', goodWhen: 'down' }
                : null
            }
          />
        </Link>
      </div>

      {/* Trend */}
      <div className="mb-6">
        <SectionCard
          title="Trend (30 days)"
          headerLink={{ label: 'View analytics', href: '/analytics' }}
        >
          {analyticsLoading ? (
            <div className="h-[260px] animate-pulse rounded-md bg-cream-warm" />
          ) : (
            <TrendChart data={trend} />
          )}
        </SectionCard>
      </div>

      {/* AI Pipeline Activity + Recent Activity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard
            title="AI Pipeline Activity"
            headerLink={{ label: 'View all', href: '/fixes' }}
          >
            <PipelinePanel
              loading={fixesLoading}
              error={fixesError}
              runs={runs}
              now={now}
            />
          </SectionCard>
        </div>
        <SectionCard
          title="Recent Activity"
          headerLink={{ label: 'View all', href: '/audit-log' }}
        >
          <ActivityPanel loading={auditLoading} error={auditError} entries={audit} now={now} />
        </SectionCard>
      </div>
    </>
  );
}

function PipelinePanel({
  loading,
  error,
  runs,
  now,
}: {
  loading: boolean;
  error: string | null;
  runs: Run[];
  now: number;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-cream-warm" />
        ))}
      </div>
    );
  }
  if (error) {
    return <p className="py-6 text-sm text-status-failed">Backend unavailable — {error}</p>;
  }
  if (runs.length === 0) {
    return <p className="py-6 text-sm text-gray-muted">No fix runs yet.</p>;
  }
  return (
    <div className="-mx-2 flex flex-col">
      {runs.map((run) => {
        const stage = deriveStage(run.latest);
        return (
          <Link
            key={run.head.id}
            href={`/fixes/${run.latest.id}`}
            className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-cream-warm/60"
          >
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-medium text-navy"
                title={run.head.findingTitle ?? undefined}
              >
                {run.head.findingTitle ?? '(unknown finding)'}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-text">
                {run.head.findingSeverity && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                      SEVERITY_BADGE[run.head.findingSeverity] ?? 'bg-cream-warm text-gray-text'
                    }`}
                  >
                    {run.head.findingSeverity}
                  </span>
                )}
                <span className="truncate">{run.head.findingRepo ?? '—'}</span>
                {run.all.length > 1 && (
                  <>
                    <span>·</span>
                    <span>{run.all.length} attempts</span>
                  </>
                )}
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
          </Link>
        );
      })}
    </div>
  );
}

function ActivityPanel({
  loading,
  error,
  entries,
  now,
}: {
  loading: boolean;
  error: string | null;
  entries: AuditLogEntry[];
  now: number;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-md bg-cream-warm" />
        ))}
      </div>
    );
  }
  if (error) {
    return <p className="py-6 text-sm text-status-failed">Backend unavailable — {error}</p>;
  }
  if (entries.length === 0) {
    return <p className="py-6 text-sm text-gray-muted">No activity recorded yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((e) => {
        const isSystem = e.actor === 'system';
        return (
          <li key={e.id} className="flex items-start gap-2.5">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                isSystem ? 'bg-navy' : 'bg-orange'
              }`}
            >
              {e.actor[0]?.toUpperCase() ?? '?'}
            </span>
            <div className="min-w-0 flex-1">
              <code className="rounded bg-cream-warm px-1.5 py-0.5 font-mono text-[11px] text-navy">
                {e.action}
              </code>
              <p className="mt-1 truncate text-[11px] text-gray-text">
                {e.actor}
                {e.resourceType && (
                  <>
                    {' · '}
                    {e.resourceType}
                    {e.resourceId && ` #${e.resourceId.split('-').pop()}`}
                  </>
                )}
                {' · '}
                {timeAgo(e.createdAt, now)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
