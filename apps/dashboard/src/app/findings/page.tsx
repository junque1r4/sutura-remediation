'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import type { Column } from '@/components/data-table';
import { SeverityBadge, StatusBadge } from '@/components/badge';
import { FindingsFilterBar } from '@/components/findings/filter-bar';
import { useFindings } from '@/contexts/findings-context';
import type { Finding } from '@/types';
import type { FindingFilters } from '@/lib/findings-utils';
import {
  emptyFilters,
  filterFindings,
  sortFindings,
  getAgeUrgency,
  getAgeUrgencyClasses,
} from '@/lib/findings-utils';

function timeAgo(dateStr: string): string {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now.getTime() - then.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

const columns: Column<Finding>[] = [
  {
    key: 'title',
    header: 'Finding',
    width: '35%',
    sortable: true,
    render: (row) => <span className="font-semibold">{row.title}</span>,
  },
  {
    key: 'severity',
    header: 'Severity',
    sortable: true,
    render: (row) => <SeverityBadge severity={row.severity} />,
  },
  {
    key: 'repo',
    header: 'Repo',
    sortable: true,
    render: (row) => <span className="text-gray-text">{row.repo}</span>,
  },
  {
    key: 'scannerSource',
    header: 'Scanner',
    sortable: true,
    render: (row) => <span className="text-gray-text">{row.scannerSource}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: 'ingestedAt',
    header: 'Age',
    sortable: true,
    render: (row) => {
      const urgency = getAgeUrgency(row.severity, row.status, row.ingestedAt);
      const classes = getAgeUrgencyClasses(urgency);
      return <span className={classes}>{timeAgo(row.ingestedAt)}</span>;
    },
  },
];

function readInitialFilters(sp: URLSearchParams): FindingFilters {
  const base = emptyFilters();
  const map: Array<[keyof FindingFilters, string]> = [
    ['severity', 'severity'],
    ['status', 'status'],
    ['scannerSource', 'scanner'],
    ['repo', 'repo'],
    ['cwe', 'cwe'],
  ];
  for (const [field, param] of map) {
    const values = sp.getAll(param);
    if (values.length === 0) continue;
    for (const v of values) {
      if (v) base[field].add(v);
    }
  }
  return base;
}

function SyncNowButton({ onSynced }: { onSynced: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Sync failed: ${res.status}`);
      }
      onSynced();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void runSync()}
        disabled={syncing}
        className="rounded-md bg-navy px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-navy-light disabled:cursor-not-allowed disabled:opacity-60"
      >
        {syncing ? 'Syncing...' : 'Sync now'}
      </button>
      {error && <span className="text-xs text-severity-critical">{error}</span>}
    </div>
  );
}

function FindingsContent() {
  const { findings, loading, refetch } = useFindings();
  const searchParams = useSearchParams();

  const [filters, setFilters] = useState<FindingFilters>(() =>
    readInitialFilters(new URLSearchParams(searchParams.toString())),
  );
  const [sortKey, setSortKey] = useState('ingestedAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [showAdvisory, setShowAdvisory] = useState(false);

  function handleSort(key: string) {
    if (key === sortKey) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection(key === 'ingestedAt' ? 'desc' : 'asc');
    }
  }

  const processedFindings = useMemo(() => {
    const filtered = filterFindings(findings, filters, false, showAdvisory);
    return sortFindings(filtered, sortKey, sortDirection);
  }, [findings, filters, sortKey, sortDirection, showAdvisory]);

  if (loading) {
    return (
      <>
        <PageHeader title="Findings" subtitle="Loading findings..." />
        <div className="h-64 animate-pulse rounded-lg border border-border bg-cream-warm" />
      </>
    );
  }

  const subtitle = processedFindings.length !== findings.length
    ? `${processedFindings.length} of ${findings.length} findings`
    : `${findings.length} findings across all repositories`;

  return (
    <>
      <PageHeader
        title="Findings"
        subtitle={subtitle}
        actions={<SyncNowButton onSynced={refetch} />}
      />
      <FindingsFilterBar
        findings={findings}
        filters={filters}
        onFiltersChange={setFilters}
        showAdvisory={showAdvisory}
        onShowAdvisoryChange={setShowAdvisory}
      />
      <DataTable
        columns={columns}
        data={processedFindings}
        rowHref={(row) => `/findings/${row.id}`}
        onSort={handleSort}
        activeSortKey={sortKey}
        activeSortDirection={sortDirection}
      />
    </>
  );
}

export default function FindingsPage() {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Findings" subtitle="Loading findings..." />
          <div className="h-64 animate-pulse rounded-lg border border-border bg-cream-warm" />
        </>
      }
    >
      <FindingsContent />
    </Suspense>
  );
}
