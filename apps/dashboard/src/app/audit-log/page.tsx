'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import type { Column } from '@/components/data-table';
import type { AuditLogEntry } from '@/types';
import { fetchAuditLog } from '@/lib/backend-client';

const columns: Column<AuditLogEntry>[] = [
  {
    key: 'createdAt',
    header: 'Timestamp',
    render: (row) => (
      <span className="whitespace-nowrap text-xs text-gray-text">
        {new Date(row.createdAt).toLocaleString()}
      </span>
    ),
  },
  {
    key: 'actor',
    header: 'Actor',
    render: (row) => {
      const isSystem = row.actor === 'system';
      return (
        <div className="flex items-center gap-2">
          {isSystem ? (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-cream-warm text-xs">
              &#x1F916;
            </span>
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-orange text-[10px] font-bold text-white">
              {row.actor[0]?.toUpperCase() ?? '?'}
            </span>
          )}
          <span className="text-xs text-navy">{row.actor}</span>
        </div>
      );
    },
  },
  {
    key: 'action',
    header: 'Action',
    render: (row) => (
      <code className="rounded bg-cream-warm px-2 py-0.5 font-mono text-[11px] text-navy">
        {row.action}
      </code>
    ),
  },
  {
    key: 'resource',
    header: 'Resource',
    render: (row) =>
      row.resourceType ? (
        <span className="text-xs text-gray-text">
          {row.resourceType}
          {row.resourceId && (
            <span className="ml-1 text-gray-muted">#{row.resourceId.split('-').pop()}</span>
          )}
        </span>
      ) : (
        <span className="text-gray-muted">—</span>
      ),
  },
  {
    key: 'details',
    header: 'Details',
    render: (row) => {
      const entries = Object.entries(row.metadataJson).slice(0, 2);
      return (
        <div className="flex flex-wrap gap-1">
          {entries.map(([k, v]) => (
            <span
              key={k}
              className="rounded bg-cream-warm px-1.5 py-0.5 text-[10px] text-gray-text"
            >
              {k}: {String(v)}
            </span>
          ))}
        </div>
      );
    },
  },
];

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAuditLog({ pageSize: 100 })
      .then((res) => setEntries(res.data))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load audit log'))
      .finally(() => setLoading(false));
  }, []);

  const subtitle = loading
    ? 'Loading audit log...'
    : error
      ? `Backend unavailable - ${error}`
      : 'All system and user actions for EU AI Act compliance';

  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle={subtitle}
        actions={
          <button className="rounded border border-border px-3 py-1.5 text-sm font-medium text-navy hover:bg-cream-warm">
            Export CSV
          </button>
        }
      />
      <DataTable columns={columns} data={entries} />
    </>
  );
}
