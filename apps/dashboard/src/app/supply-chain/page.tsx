'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { QuickLookup } from './components/quick-lookup';
import { ComponentsTable } from './components/components-table';
import type { ComponentRow, KpiResponse, SyncStatus } from './types';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SupplyChainPage() {
  const [components, setComponents] = useState<ComponentRow[]>([]);
  const [kpis, setKpis] = useState({
    total: 0,
    unique: 0,
    vulnerable: 0,
    repos: 0,
  });
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const loadComponents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sbom/components', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        components: ComponentRow[];
        kpis: KpiResponse;
      };
      setComponents(data.components);
      setKpis({
        total: Number(data.kpis.total_components),
        unique: Number(data.kpis.unique_packages),
        vulnerable: Number(data.kpis.vulnerable_components),
        repos: Number(data.kpis.repos_covered),
      });
    } catch (err) {
      console.error('[supply-chain] load failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLastSync = useCallback(async () => {
    try {
      const res = await fetch('/api/sbom/sync', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { lastRun: SyncStatus | null };
      setLastSync(data.lastRun);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadComponents();
    void loadLastSync();
  }, [loadComponents, loadLastSync]);

  async function runSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch('/api/sbom/sync', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await Promise.all([loadComponents(), loadLastSync()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      setSyncError(message);
    } finally {
      setSyncing(false);
    }
  }

  const subtitle = lastSync
    ? `Last sync ${timeAgo(lastSync.finished_at ?? lastSync.started_at)} — ${lastSync.repos_synced} repos, ${lastSync.components_upserted} components, ${lastSync.vulns_found} vulns${lastSync.repos_failed > 0 ? ` (${lastSync.repos_failed} repos failed)` : ''}`
    : 'No sync yet';

  return (
    <>
      <PageHeader
        title="Supply Chain"
        subtitle={subtitle}
        actions={
          <button
            type="button"
            onClick={() => void runSync()}
            disabled={syncing}
            className="rounded-md bg-navy px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-navy-light disabled:cursor-not-allowed disabled:opacity-60"
          >
            {syncing ? 'Syncing from Aikido...' : 'Sync from Aikido'}
          </button>
        }
      />

      {syncError && (
        <div className="mb-4 rounded-md border border-status-failed/40 bg-severity-bg-critical px-4 py-2 text-sm text-severity-critical">
          {syncError}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total components" value={kpis.total.toLocaleString()} />
        <StatCard label="Unique packages" value={kpis.unique.toLocaleString()} />
        <StatCard
          label="Vulnerable components"
          value={kpis.vulnerable.toLocaleString()}
          color={kpis.vulnerable > 0 ? 'var(--color-severity-critical, #b91c1c)' : undefined}
        />
        <StatCard label="Repos covered" value={kpis.repos.toLocaleString()} />
      </div>

      <QuickLookup />

      <ComponentsTable components={components} loading={loading} onRefresh={loadComponents} />
    </>
  );
}
