'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { SeverityBadge } from '@/components/badge';
import {
  fetchTokenCostRanking,
  fetchTokenUsageStats,
  type FindingCostRankingRow,
  type TokenUsageStats,
} from '@/lib/backend-client';
import type { Severity } from '@/types';

function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function TokenCostsPage() {
  const [ranking, setRanking] = useState<FindingCostRankingRow[]>([]);
  const [stats, setStats] = useState<TokenUsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, s] = await Promise.all([fetchTokenCostRanking(100), fetchTokenUsageStats()]);
        if (cancelled) return;
        setRanking(r.data);
        setStats(s);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load token costs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const analysisStats = stats?.byOperation.find((o) => o.operation === 'analysis');
  const fixStats = stats?.byOperation.find((o) => o.operation === 'fix_generation');

  return (
    <>
      <PageHeader
        title="Token Costs"
        breadcrumbs={[{ label: 'Insights' }, { label: 'Token Costs' }]}
      />

      {/* Top-line stats */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <StatCard label="Total Cost" value={stats ? formatUsd(stats.totalCostUsd) : '--'} />
        <StatCard label="Total Calls" value={stats?.totalCalls ?? '--'} />
        <StatCard
          label="Analysis Cost"
          value={analysisStats ? formatUsd(analysisStats.costUsd) : '--'}
        />
        <StatCard
          label="Fix Generation Cost"
          value={fixStats ? formatUsd(fixStats.costUsd) : '--'}
        />
      </div>

      <div className="rounded-lg border border-border bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-navy">
          Vulnerabilities by Cost (most expensive first)
        </h2>

        {loading && (
          <div className="h-48 animate-pulse rounded-md bg-cream-warm" />
        )}

        {error && (
          <p className="rounded-md border border-status-failed/30 bg-status-failed/5 p-3 text-sm text-status-failed">
            {error}
          </p>
        )}

        {!loading && !error && ranking.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-muted">
            No token usage recorded yet. Run an analysis or fix to see costs here.
          </p>
        )}

        {!loading && !error && ranking.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-gray-text">
                  <th className="py-2 pr-3">Rank</th>
                  <th className="py-2 pr-3">Vulnerability</th>
                  <th className="py-2 pr-3">Severity</th>
                  <th className="py-2 pr-3 text-right">Calls</th>
                  <th className="py-2 pr-3 text-right">Input</th>
                  <th className="py-2 pr-3 text-right">Output</th>
                  <th className="py-2 pr-3 text-right">Total Tokens</th>
                  <th className="py-2 pr-3 text-right">Cost</th>
                  <th className="py-2 pr-3">Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((row, i) => (
                  <tr
                    key={row.findingId}
                    className="border-b border-border/60 transition-colors hover:bg-cream-warm/40"
                  >
                    <td className="py-2.5 pr-3 font-mono text-xs text-gray-text">#{i + 1}</td>
                    <td className="py-2.5 pr-3">
                      <Link
                        href={`/findings/${encodeURIComponent(row.findingId)}`}
                        className="font-medium text-navy hover:text-orange hover:underline"
                      >
                        {row.findingTitle ?? row.findingId}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3">
                      {row.findingSeverity ? (
                        <SeverityBadge severity={row.findingSeverity as Severity} />
                      ) : (
                        <span className="text-xs text-gray-muted">--</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">{row.calls}</td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs text-gray-text">
                      {formatTokens(row.inputTokens)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs text-gray-text">
                      {formatTokens(row.outputTokens)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs text-navy">
                      {formatTokens(row.totalTokens)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-sm font-semibold text-orange">
                      {formatUsd(row.costUsd)}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-gray-text">
                      {timeAgo(row.lastActivity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
