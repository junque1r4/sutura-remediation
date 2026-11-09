'use client';

import { useEffect, useState } from 'react';
import { SeverityBadge } from '@/components/badge';
import type { ComponentRow, DrawerRepo, DrawerVuln } from '../types';

interface Props {
  component: ComponentRow;
  onClose: () => void;
}

export function ComponentDrawer({ component, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [repos, setRepos] = useState<DrawerRepo[]>([]);
  const [vulns, setVulns] = useState<DrawerVuln[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          name: component.packageName,
          version: component.version,
        });
        const res = await fetch(`/api/sbom/components/details?${params}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { repos: DrawerRepo[]; vulns: DrawerVuln[] };
        if (cancelled) return;
        setRepos(data.repos);
        setVulns(data.vulns);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load details');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [component.packageName, component.version]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="flex-1 bg-navy/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <aside className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl">
        <header className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-gray-text">
              {component.ecosystem ?? 'unknown ecosystem'}
            </p>
            <h2 className="mt-0.5 font-mono text-base font-semibold text-navy">
              {component.packageName}
            </h2>
            <p className="font-mono text-sm text-gray-text">{component.version}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-gray-text hover:bg-cream-warm hover:text-navy"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 px-5 py-4">
          {loading ? (
            <div className="h-32 animate-pulse rounded-lg bg-cream-warm" />
          ) : error ? (
            <p className="text-sm text-severity-critical">{error}</p>
          ) : (
            <>
              <section className="mb-6">
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-text">
                  Repos using this component ({repos.length})
                </h3>
                <ul className="divide-y divide-border-light rounded-md border border-border">
                  {repos.map((r) => (
                    <li
                      key={r.repoAikidoId}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span className="text-navy">{r.repoName}</span>
                      {r.scope && (
                        <span className="text-[10px] uppercase tracking-wider text-gray-text">
                          {r.scope}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-text">
                  Vulnerabilities ({vulns.length})
                </h3>
                {vulns.length === 0 ? (
                  <p className="rounded-md border border-border bg-cream-warm px-3 py-3 text-sm text-gray-text">
                    No OSV.dev advisories matched this exact version.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {vulns.map((v) => (
                      <li
                        key={v.osvId}
                        className="rounded-md border border-border bg-cream-warm p-3"
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          {v.severity && <SeverityBadge severity={v.severity} />}
                          <a
                            href={v.detailsUrl ?? `https://osv.dev/vulnerability/${v.osvId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-xs font-semibold text-navy hover:text-orange"
                          >
                            {v.osvId}
                          </a>
                        </div>
                        {v.summary && (
                          <p className="text-xs text-gray-text">{v.summary}</p>
                        )}
                        {v.fixedVersions.length > 0 && (
                          <p className="mt-2 text-[11px] text-gray-text">
                            <span className="font-medium text-navy">Fixed in:</span>{' '}
                            <span className="font-mono">{v.fixedVersions.join(', ')}</span>
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
