'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import type { GitHubRepo } from '@/types';
import { fetchGitHubStatus, fetchGitHubRepos } from '@/lib/github-client';

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function RepositoriesPage() {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [enabledRepos, setEnabledRepos] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('sutura_enabled_repos');
    if (stored) {
      try {
        const arr: string[] = JSON.parse(stored);
        setEnabledRepos(new Set(arr));
      } catch {
        // ignore invalid JSON
      }
    }

    async function init() {
      try {
        const status = await fetchGitHubStatus();
        if (!status.connected) {
          setLoading(false);
          return;
        }
        setConnected(true);
        const fetchedRepos = await fetchGitHubRepos();
        setRepos(fetchedRepos);
      } catch {
        setError('Failed to load repositories');
      } finally {
        setLoading(false);
      }
    }

    init();
  }, []);

  function toggleRepo(fullName: string) {
    setEnabledRepos((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) {
        next.delete(fullName);
      } else {
        next.add(fullName);
      }
      localStorage.setItem('sutura_enabled_repos', JSON.stringify([...next]));
      return next;
    });
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const freshRepos = await fetchGitHubRepos();
      setRepos(freshRepos);
    } catch {
      setError('Failed to refresh repositories');
    } finally {
      setLoading(false);
    }
  }, []);

  // Loading state
  if (loading) {
    return (
      <>
        <PageHeader title="Repositories" subtitle="Loading repositories..." />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-lg border border-border bg-cream-warm"
            />
          ))}
        </div>
      </>
    );
  }

  // Not connected state
  if (!connected) {
    return (
      <>
        <PageHeader title="Repositories" subtitle="Connect GitHub to import repositories" />
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-white px-6 py-16 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#24292f] text-lg font-bold text-white">
            G
          </span>
          <h3 className="mb-2 text-lg font-semibold text-navy">Connect GitHub to get started</h3>
          <p className="mb-6 max-w-sm text-sm text-gray-text">
            Link your GitHub account to import repositories for scanning and vulnerability
            remediation.
          </p>
          <Link
            href="/settings"
            className="rounded bg-orange px-4 py-2 text-sm font-medium text-white hover:bg-orange-deep"
          >
            Go to Settings
          </Link>
        </div>
      </>
    );
  }

  // Connected state
  const enabledCount = repos.filter((r) => enabledRepos.has(r.fullName)).length;

  return (
    <>
      <PageHeader
        title="Repositories"
        subtitle={`${repos.length} repositories \u2014 ${enabledCount} enabled for scanning`}
        actions={
          <button
            onClick={refresh}
            disabled={loading}
            className="rounded border border-border px-3 py-1.5 text-sm font-medium text-navy hover:bg-cream-warm disabled:opacity-50"
          >
            Refresh
          </button>
        }
      />

      {error && (
        <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {repos.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-white px-6 py-16 text-center">
          <h3 className="mb-2 text-lg font-semibold text-navy">No repositories found</h3>
          <p className="max-w-sm text-sm text-gray-text">
            Your GitHub App installation has no repositories. Manage your installation on GitHub to
            grant access.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {repos.map((repo) => {
            const isEnabled = enabledRepos.has(repo.fullName);
            return (
              <div
                key={repo.id}
                className="flex flex-col rounded-lg border border-border bg-white p-5 shadow-sm"
              >
                {/* Header */}
                <div className="mb-3 flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-navy">{repo.fullName}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-xs text-gray-text">{repo.defaultBranch}</span>
                      {repo.isPrivate && (
                        <span className="rounded bg-cream-warm px-1.5 py-0.5 text-[10px] font-medium text-gray-muted">
                          Private
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Enable/disable toggle */}
                  <button
                    onClick={() => toggleRepo(repo.fullName)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      isEnabled ? 'bg-orange' : 'bg-gray-200'
                    }`}
                    aria-pressed={isEnabled}
                    aria-label={isEnabled ? `Disable ${repo.fullName}` : `Enable ${repo.fullName}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                        isEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* Status indicator */}
                <div className="mb-3 flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      isEnabled ? 'bg-status-success' : 'bg-gray-muted'
                    }`}
                  />
                  <span className="text-xs text-gray-text">
                    {isEnabled ? 'Enabled for scanning' : 'Not monitored'}
                  </span>
                </div>

                {/* Metadata */}
                <div className="mb-4 flex flex-wrap gap-2">
                  {repo.language && (
                    <span className="rounded bg-cream-warm px-1.5 py-0.5 text-[10px] font-medium text-navy">
                      {repo.language}
                    </span>
                  )}
                  {repo.description && (
                    <p className="w-full text-xs text-gray-text line-clamp-2">{repo.description}</p>
                  )}
                  <span className="text-[10px] text-gray-muted">
                    Updated {relativeTime(repo.updatedAt)}
                  </span>
                </div>

                {/* Actions */}
                <div className="mt-auto flex gap-2">
                  <a
                    href={repo.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 rounded border border-border px-3 py-1.5 text-center text-xs font-medium text-navy hover:bg-cream-warm"
                  >
                    View on GitHub
                  </a>
                  {isEnabled && (
                    <Link
                      href={`/findings?repo=${encodeURIComponent(repo.fullName)}`}
                      className="flex-1 rounded bg-orange px-3 py-1.5 text-center text-xs font-medium text-white hover:bg-orange-deep"
                    >
                      View Findings
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
