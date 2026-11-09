'use client';

import { useState, useEffect } from 'react';
import type { GitHubInstallation } from '@/types';
import { fetchGitHubStatus, disconnectGitHub } from '@/lib/github-client';

export function GitHubConnection() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [installation, setInstallation] = useState<GitHubInstallation | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    fetchGitHubStatus()
      .then((data) => {
        setConnected(data.connected);
        setInstallation(data.installation ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectGitHub();
      setInstallation(null);
      setConnected(false);
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return <div className="h-16 animate-pulse rounded-md bg-cream-warm" />;
  }

  if (!connected || !installation) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border-light p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#24292f] text-sm font-bold text-white">
            G
          </span>
          <div>
            <p className="text-sm font-medium text-navy">GitHub</p>
            <p className="text-xs text-gray-text">
              Connect your GitHub account to import repositories and create fix PRs
            </p>
          </div>
        </div>
        <div className="ml-4 shrink-0">
          <a
            href="/api/github/install"
            className="rounded border border-orange px-2.5 py-1 text-xs font-medium text-orange hover:bg-orange hover:text-white"
          >
            Install App
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border-light p-4">
      <div className="flex items-center gap-3">
        <img
          src={installation.avatarUrl}
          alt={installation.account}
          className="h-8 w-8 rounded-md"
        />
        <div>
          <p className="text-sm font-medium text-navy">{installation.account}</p>
          <p className="text-xs text-gray-text">GitHub App connected</p>
        </div>
      </div>
      <div className="ml-4 flex shrink-0 gap-2">
        <a
          href={
            installation.targetType === 'User'
              ? `https://github.com/settings/installations/${installation.installationId}`
              : `https://github.com/organizations/${installation.account}/settings/installations/${installation.installationId}`
          }
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gray-muted hover:text-navy"
        >
          Manage
        </a>
        <button
          onClick={handleDisconnect}
          disabled={disconnecting}
          className="rounded border border-red-300 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50"
        >
          {disconnecting ? 'Disconnecting...' : 'Disconnect'}
        </button>
      </div>
    </div>
  );
}
