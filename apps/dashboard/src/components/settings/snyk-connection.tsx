'use client';

import { useState, useEffect } from 'react';
import type { SnykConnection as SnykConnectionType } from '@/types';
import { fetchSnykStatus, connectSnyk, disconnectSnyk } from '@/lib/snyk-client';

export function SnykConnection() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<SnykConnectionType | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [orgId, setOrgId] = useState('');
  const [orgName, setOrgName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSnykStatus()
      .then((data) => {
        setConnected(data.connected);
        setConnection(data.connection ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleConnect() {
    if (!apiToken.trim() || !orgId.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectSnyk(
        apiToken.trim(),
        orgId.trim(),
        orgName.trim() || orgId.trim(),
      );
      setConnected(result.connected);
      setConnection(result.connection ?? null);
      setShowForm(false);
      setApiToken('');
      setOrgId('');
      setOrgName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials or unable to connect');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectSnyk();
      setConnection(null);
      setConnected(false);
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return <div className="h-16 animate-pulse rounded-md bg-cream-warm" />;
  }

  // Connected state
  if (connected && connection) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border-light p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#4C4A99] text-sm font-bold text-white">
            S
          </span>
          <div>
            <p className="text-sm font-medium text-navy">Snyk</p>
            <p className="text-xs text-gray-text">
              Connected &middot; {connection.orgName || connection.orgId}
            </p>
          </div>
        </div>
        <div className="ml-4 shrink-0">
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

  // Disconnected state - show form if user clicked Connect
  if (showForm) {
    return (
      <div className="rounded-md border border-border-light p-4">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#4C4A99] text-sm font-bold text-white">
            S
          </span>
          <div>
            <p className="text-sm font-medium text-navy">Snyk</p>
            <p className="text-xs text-gray-text">Enter your Snyk API token and organization details</p>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
        )}

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">API Token</label>
            <input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="Enter your Snyk API token"
              className="w-full rounded border border-border px-3 py-1.5 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Organization ID</label>
            <input
              type="text"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              placeholder="Enter your Snyk organization ID"
              className="w-full rounded border border-border px-3 py-1.5 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Organization Name (optional)</label>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Display name for this organization"
              className="w-full rounded border border-border px-3 py-1.5 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleConnect}
              disabled={connecting || !apiToken.trim() || !orgId.trim()}
              className="rounded bg-orange px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-deep disabled:opacity-50"
            >
              {connecting ? 'Connecting...' : 'Save'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setError(null);
                setApiToken('');
                setOrgId('');
                setOrgName('');
              }}
              className="rounded border border-border px-3 py-1.5 text-xs font-medium text-navy hover:bg-cream-warm"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Disconnected state - initial
  return (
    <div className="flex items-center justify-between rounded-md border border-border-light p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#4C4A99] text-sm font-bold text-white">
          S
        </span>
        <div>
          <p className="text-sm font-medium text-navy">Snyk</p>
          <p className="text-xs text-gray-text">
            Developer-first security platform for open source vulnerabilities
          </p>
        </div>
      </div>
      <div className="ml-4 shrink-0">
        <button
          onClick={() => setShowForm(true)}
          className="rounded border border-orange px-2.5 py-1 text-xs font-medium text-orange hover:bg-orange hover:text-white"
        >
          Connect
        </button>
      </div>
    </div>
  );
}
