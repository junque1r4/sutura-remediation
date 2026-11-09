'use client';

import { useMemo, useState } from 'react';
import { SeverityBadge } from '@/components/badge';
import { DataTable, type Column } from '@/components/data-table';
import type { ComponentRow } from '../types';
import { ComponentDrawer } from './component-drawer';

interface Props {
  components: ComponentRow[];
  loading: boolean;
  onRefresh: () => Promise<void> | void;
}

export function ComponentsTable({ components, loading }: Props) {
  const [search, setSearch] = useState('');
  const [ecosystemFilter, setEcosystemFilter] = useState<string>('');
  const [onlyVulnerable, setOnlyVulnerable] = useState(false);
  const [selected, setSelected] = useState<ComponentRow | null>(null);

  const ecosystems = useMemo(() => {
    const set = new Set<string>();
    for (const c of components) {
      if (c.ecosystem) set.add(c.ecosystem);
    }
    return Array.from(set).sort();
  }, [components]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return components.filter((c) => {
      if (onlyVulnerable && c.vulnCount === 0) return false;
      if (ecosystemFilter && c.ecosystem !== ecosystemFilter) return false;
      if (q && !c.packageName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [components, search, ecosystemFilter, onlyVulnerable]);

  const columns: Column<ComponentRow>[] = [
    {
      key: 'packageName',
      header: 'Package',
      width: '32%',
      render: (row) => <span className="font-mono font-semibold text-navy">{row.packageName}</span>,
    },
    {
      key: 'version',
      header: 'Version',
      width: '12%',
      render: (row) => <span className="font-mono text-gray-text">{row.version}</span>,
    },
    {
      key: 'ecosystem',
      header: 'Ecosystem',
      width: '12%',
      render: (row) => <span className="text-gray-text">{row.ecosystem ?? '—'}</span>,
    },
    {
      key: 'repoCount',
      header: 'Repos',
      width: '10%',
      render: (row) => <span className="text-gray-text">{row.repoCount}</span>,
    },
    {
      key: 'vulnCount',
      header: 'Vulns',
      width: '14%',
      render: (row) =>
        row.vulnCount === 0 ? (
          <span className="text-xs text-gray-text">—</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            {row.maxSeverity && <SeverityBadge severity={row.maxSeverity} />}
            <span className="text-xs text-gray-text">{row.vulnCount}</span>
          </span>
        ),
    },
  ];

  if (loading) {
    return <div className="h-64 animate-pulse rounded-lg border border-border bg-cream-warm" />;
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by package name..."
          className="w-64 rounded-md border border-border bg-white px-3 py-1.5 text-sm text-navy focus:border-orange focus:outline-none focus:ring-1 focus:ring-orange"
        />
        <select
          value={ecosystemFilter}
          onChange={(e) => setEcosystemFilter(e.target.value)}
          className="rounded-md border border-border bg-white px-3 py-1.5 text-sm text-navy focus:border-orange focus:outline-none focus:ring-1 focus:ring-orange"
        >
          <option value="">All ecosystems</option>
          {ecosystems.map((eco) => (
            <option key={eco} value={eco}>
              {eco}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-2 text-sm text-gray-text">
          <input
            type="checkbox"
            checked={onlyVulnerable}
            onChange={(e) => setOnlyVulnerable(e.target.checked)}
            className="h-4 w-4 rounded border-border text-orange focus:ring-orange"
          />
          Only vulnerable
        </label>
        <span className="ml-auto text-xs text-gray-text">
          {filtered.length.toLocaleString()} of {components.length.toLocaleString()}
        </span>
      </div>

      <div onClick={(e) => handleRowClick(e, filtered, setSelected)}>
        <DataTable columns={columns} data={filtered} />
      </div>

      {selected && (
        <ComponentDrawer component={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

// The shared DataTable only supports `rowHref` for navigation; we wrap it and
// intercept the click on each row to open a drawer instead.
function handleRowClick(
  e: React.MouseEvent<HTMLDivElement>,
  rows: ComponentRow[],
  setSelected: (c: ComponentRow) => void,
) {
  const tr = (e.target as HTMLElement).closest('tr');
  if (!tr) return;
  const tbody = tr.parentElement;
  if (!tbody || tbody.tagName !== 'TBODY') return;
  const index = Array.from(tbody.children).indexOf(tr);
  if (index < 0 || index >= rows.length) return;
  setSelected(rows[index]);
}
