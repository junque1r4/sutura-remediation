'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { TrendChart, type TrendPoint } from '@/components/charts/trend-chart';
import {
  SeverityDistributionChart,
  type SeverityRow,
} from '@/components/charts/severity-distribution-chart';
import {
  FixPerformanceChart,
  type FixPerformancePoint,
} from '@/components/charts/fix-performance-chart';
import { FunnelChart, type FunnelStagePoint } from '@/components/charts/funnel-chart';
import {
  BreakdownChart,
  type BreakdownItem,
} from '@/components/charts/breakdown-chart';
import { CsvButton } from '@/components/charts/csv-button';

type RangeKey = '7d' | '30d' | '90d';
const VALID_RANGES: RangeKey[] = ['7d', '30d', '90d'];

interface OverviewResponse {
  range: RangeKey;
  repo: string | null;
  periodStart: string;
  periodEnd: string;
  openFindings: {
    total: number;
    bySeverity: SeverityRow[];
  };
  mttrHours: {
    value: number | null;
    delta: number | null;
    sampleSize: number;
  };
  autoFixSuccessRate: {
    value: number | null;
    delta: number | null;
    succeeded: number;
    total: number;
  };
  costUsd: {
    value: number;
    delta: number;
  };
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

function ChartCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-navy">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-gray-text">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

function RangeTabs({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (r: RangeKey) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border bg-white">
      {VALID_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            value === r
              ? 'bg-navy text-white'
              : 'text-gray-text hover:bg-cream-warm hover:text-navy'
          }`}
        >
          {r === '7d' ? '7 dias' : r === '30d' ? '30 dias' : '90 dias'}
        </button>
      ))}
    </div>
  );
}

function RepoSelect({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded-md border border-border bg-white px-3 py-1.5 text-xs text-navy focus:border-orange focus:outline-none"
    >
      <option value="">Todos os repositorios</option>
      {options.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}

function buildFindingsHref(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `/findings?${qs}` : '/findings';
}

function AnalyticsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rangeRaw = searchParams.get('range');
  const range: RangeKey = (VALID_RANGES as string[]).includes(rangeRaw ?? '')
    ? (rangeRaw as RangeKey)
    : '30d';
  const repo = searchParams.get('repo');

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [fixPerf, setFixPerf] = useState<FixPerformancePoint[]>([]);
  const [funnel, setFunnel] = useState<FunnelStagePoint[]>([]);
  const [scannerBreakdown, setScannerBreakdown] = useState<BreakdownItem[]>([]);
  const [cweBreakdown, setCweBreakdown] = useState<BreakdownItem[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ range });
    if (repo) params.set('repo', repo);
    return params.toString();
  }, [range, repo]);

  const updateParams = useCallback(
    (patch: { range?: RangeKey; repo?: string | null }) => {
      const next = new URLSearchParams(searchParams.toString());
      if (patch.range !== undefined) next.set('range', patch.range);
      if (patch.repo !== undefined) {
        if (patch.repo === null || patch.repo === '') next.delete('repo');
        else next.set('repo', patch.repo);
      }
      router.replace(`/analytics?${next.toString()}`);
    },
    [router, searchParams],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const endpoints = [
          ['overview', `/api/analytics/overview?${query}`],
          ['trend', `/api/analytics/trend?${query}`],
          ['fix-performance', `/api/analytics/fix-performance?${query}`],
          ['funnel', `/api/analytics/funnel?${query}`],
          ['breakdown/scanner', `/api/analytics/breakdown/scanner?${query}`],
          ['breakdown/cwe', `/api/analytics/breakdown/cwe?${query}`],
        ] as const;
        const responses = await Promise.all(
          endpoints.map(([, url]) => fetch(url, { cache: 'no-store' })),
        );
        const failures = responses
          .map((r, i) => (r.ok ? null : `${endpoints[i][0]}: HTTP ${r.status}`))
          .filter((x): x is string => x !== null);
        if (failures.length > 0) {
          throw new Error(`Failed to load analytics data (${failures.join(', ')})`);
        }
        const [oRes, tRes, fRes, funRes, scRes, cweRes] = responses;
        const [o, t, f, fun, sc, cwe] = await Promise.all([
          oRes.json() as Promise<OverviewResponse>,
          tRes.json() as Promise<{ data: TrendPoint[] }>,
          fRes.json() as Promise<{ data: FixPerformancePoint[] }>,
          funRes.json() as Promise<{ data: FunnelStagePoint[] }>,
          scRes.json() as Promise<{ data: BreakdownItem[] }>,
          cweRes.json() as Promise<{ data: BreakdownItem[] }>,
        ]);
        if (cancelled) return;
        setOverview(o);
        setTrend(t.data);
        setFixPerf(f.data);
        setFunnel(fun.data);
        setScannerBreakdown(sc.data);
        setCweBreakdown(cwe.data);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/analytics/repos', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { data: string[] };
        if (!cancelled) setRepos(json.data);
      } catch {
        // repos list is non-critical
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const severityLinkBuilder = useCallback(
    (item: SeverityRow): string =>
      buildFindingsHref({ status: 'open', severity: item.severity, repo }),
    [repo],
  );

  const scannerLinkBuilder = useCallback(
    (item: BreakdownItem): string => buildFindingsHref({ scanner: item.label, repo }),
    [repo],
  );

  const cweLinkBuilder = useCallback(
    (item: BreakdownItem): string => buildFindingsHref({ cwe: item.label, repo }),
    [repo],
  );

  const filenameSuffix = `${range}${repo ? `-${repo.replace(/[^\w-]+/g, '_')}` : ''}`;

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Postura de seguranca e eficacia do auto-fix loop"
        breadcrumbs={[{ label: 'Insights' }, { label: 'Analytics' }]}
        actions={
          <div className="flex items-center gap-2">
            <RepoSelect
              value={repo}
              options={repos}
              onChange={(v) => updateParams({ repo: v })}
            />
            <RangeTabs value={range} onChange={(r) => updateParams({ range: r })} />
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-status-failed/30 bg-status-failed/5 p-3 text-sm text-status-failed">
          {error}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Open findings"
          value={loading ? '--' : (overview?.openFindings.total ?? 0)}
          breakdown={overview?.openFindings.bySeverity}
        />
        <StatCard
          label="MTTR medio"
          value={loading ? '--' : formatHours(overview?.mttrHours.value ?? null)}
          delta={
            overview?.mttrHours.delta !== null && overview?.mttrHours.delta !== undefined
              ? { value: overview.mttrHours.delta, suffix: 'h', goodWhen: 'down' }
              : null
          }
        />
        <StatCard
          label="Auto-fix success"
          value={loading ? '--' : formatPercent(overview?.autoFixSuccessRate.value ?? null)}
          delta={
            overview?.autoFixSuccessRate.delta !== null &&
            overview?.autoFixSuccessRate.delta !== undefined
              ? {
                  value: overview.autoFixSuccessRate.delta * 100,
                  suffix: 'pp',
                  goodWhen: 'up',
                }
              : null
          }
        />
        <StatCard
          label="Custo Claude (periodo)"
          value={loading ? '--' : formatUsd(overview?.costUsd.value ?? 0)}
          delta={
            overview
              ? { value: overview.costUsd.delta, suffix: ' USD', goodWhen: 'down' }
              : null
          }
        />
      </div>

      <div className="space-y-4">
        <ChartCard
          title="Ingestao vs Remediacao"
          subtitle="Novas findings detectadas vs resolvidas por dia"
          actions={
            <CsvButton
              filename={`analytics-trend-${filenameSuffix}`}
              getRows={() => trend}
              disabled={loading || trend.length === 0}
            />
          }
        >
          {loading ? (
            <div className="h-[260px] animate-pulse rounded-md bg-cream-warm" />
          ) : (
            <TrendChart data={trend} />
          )}
        </ChartCard>

        <ChartCard
          title="Funil de remediacao"
          subtitle="Etapas do auto-fix loop no periodo"
          actions={
            <CsvButton
              filename={`analytics-funnel-${filenameSuffix}`}
              getRows={() => funnel.map((s) => ({ stage: s.label, count: s.count }))}
              disabled={loading || funnel.length === 0}
            />
          }
        >
          {loading ? (
            <div className="h-[220px] animate-pulse rounded-md bg-cream-warm" />
          ) : (
            <FunnelChart data={funnel} />
          )}
        </ChartCard>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard
            title="Findings abertas por severity"
            subtitle="Snapshot atual; clique numa barra para ver findings"
            actions={
              <CsvButton
                filename={`analytics-severity-${filenameSuffix}`}
                getRows={() => overview?.openFindings.bySeverity ?? []}
                disabled={loading || !overview}
              />
            }
          >
            {loading ? (
              <div className="h-[260px] animate-pulse rounded-md bg-cream-warm" />
            ) : (
              <SeverityDistributionChart
                data={overview?.openFindings.bySeverity ?? []}
                linkBuilder={severityLinkBuilder}
              />
            )}
          </ChartCard>

          <ChartCard
            title="Performance do auto-fix"
            subtitle="Resultado das tentativas finalizadas no periodo"
            actions={
              <CsvButton
                filename={`analytics-fix-performance-${filenameSuffix}`}
                getRows={() => fixPerf}
                disabled={loading || fixPerf.length === 0}
              />
            }
          >
            {loading ? (
              <div className="h-[260px] animate-pulse rounded-md bg-cream-warm" />
            ) : (
              <FixPerformanceChart data={fixPerf} />
            )}
          </ChartCard>

          <ChartCard
            title="Top scanners"
            subtitle="Findings ingeridas no periodo, agrupadas por scanner"
            actions={
              <CsvButton
                filename={`analytics-scanner-${filenameSuffix}`}
                getRows={() => scannerBreakdown}
                disabled={loading || scannerBreakdown.length === 0}
              />
            }
          >
            {loading ? (
              <div className="h-[220px] animate-pulse rounded-md bg-cream-warm" />
            ) : (
              <BreakdownChart
                data={scannerBreakdown}
                linkBuilder={scannerLinkBuilder}
                color="#0f1a2e"
              />
            )}
          </ChartCard>

          <ChartCard
            title="Top CWEs"
            subtitle="Findings ingeridas no periodo, agrupadas por CWE"
            actions={
              <CsvButton
                filename={`analytics-cwe-${filenameSuffix}`}
                getRows={() => cweBreakdown}
                disabled={loading || cweBreakdown.length === 0}
              />
            }
          >
            {loading ? (
              <div className="h-[220px] animate-pulse rounded-md bg-cream-warm" />
            ) : (
              <BreakdownChart
                data={cweBreakdown}
                linkBuilder={cweLinkBuilder}
                color="#f97316"
              />
            )}
          </ChartCard>
        </div>
      </div>
    </>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Analytics" subtitle="Carregando..." />
          <div className="h-64 animate-pulse rounded-lg border border-border bg-cream-warm" />
        </>
      }
    >
      <AnalyticsContent />
    </Suspense>
  );
}
