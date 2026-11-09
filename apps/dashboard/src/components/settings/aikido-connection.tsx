'use client';

import { useState, useEffect } from 'react';
import type { AikidoConnection as AikidoConnectionType } from '@/types';
import { fetchAikidoStatus, connectAikido, disconnectAikido } from '@/lib/aikido-client';
import { useFindings } from '@/contexts/findings-context';

export function AikidoConnection() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<AikidoConnectionType | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetching, setRefetching] = useState(false);
  const [lastRefetchAt, setLastRefetchAt] = useState<Date | null>(null);
  const [refetchError, setRefetchError] = useState<string | null>(null);
  const { total, refetch, error: findingsError } = useFindings();

  useEffect(() => {
    fetchAikidoStatus()
      .then((data) => {
        setConnected(data.connected);
        setConnection(data.connection ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleConnect() {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectAikido(clientId.trim(), clientSecret.trim());
      setConnected(result.connected);
      setConnection(result.connection ?? null);
      setShowForm(false);
      setClientId('');
      setClientSecret('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials or unable to connect');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectAikido();
      setConnection(null);
      setConnected(false);
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleRefetch() {
    setRefetching(true);
    setRefetchError(null);
    try {
      await refetch();
      setLastRefetchAt(new Date());
    } catch (err) {
      setRefetchError(err instanceof Error ? err.message : 'Re-fetch failed');
    } finally {
      setRefetching(false);
    }
  }

  if (loading) {
    return <div className="h-16 animate-pulse rounded-md bg-cream-warm" />;
  }

  // Connected state
  if (connected && connection) {
    const refetchStatus = refetchError
      ? { tone: 'error', text: refetchError }
      : refetching
        ? { tone: 'muted', text: 'Re-fetching findings...' }
        : lastRefetchAt
          ? findingsError
            ? { tone: 'error', text: findingsError }
            : { tone: 'success', text: `Loaded ${total} findings at ${lastRefetchAt.toLocaleTimeString()}` }
          : null;

    return (
      <div className="rounded-md border border-border-light p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#6C47FF] text-sm font-bold text-white">
              A
            </span>
            <div>
              <p className="text-sm font-medium text-navy">Aikido Security</p>
              <p className="text-xs text-gray-text">
                Connected &middot; {connection.clientId}
              </p>
            </div>
          </div>
          <div className="ml-4 flex shrink-0 gap-2">
            <button
              onClick={handleRefetch}
              disabled={refetching}
              className="rounded border border-orange px-2.5 py-1 text-xs font-medium text-orange hover:bg-orange hover:text-white disabled:opacity-50"
            >
              {refetching ? 'Re-fetching...' : 'Re-fetch findings'}
            </button>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="rounded border border-red-300 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 disabled:opacity-50"
            >
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </button>
          </div>
        </div>
        {refetchStatus && (
          <p
            className={`mt-3 text-xs ${
              refetchStatus.tone === 'error'
                ? 'text-red-600'
                : refetchStatus.tone === 'success'
                  ? 'text-status-success'
                  : 'text-gray-text'
            }`}
          >
            {refetchStatus.text}
          </p>
        )}
      </div>
    );
  }

  // Disconnected state - show form if user clicked Connect
  if (showForm) {
    return (
      <div className="rounded-md border border-border-light p-4">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#6C47FF] text-sm font-bold text-white">
            A
          </span>
          <div>
            <p className="text-sm font-medium text-navy">Aikido Security</p>
            <p className="text-xs text-gray-text">Enter your Aikido API credentials to connect</p>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
        )}

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Enter your Aikido Client ID"
              className="w-full rounded border border-border px-3 py-1.5 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Enter your Aikido Client Secret"
              className="w-full rounded border border-border px-3 py-1.5 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleConnect}
              disabled={connecting || !clientId.trim() || !clientSecret.trim()}
              className="rounded bg-orange px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-deep disabled:opacity-50"
            >
              {connecting ? 'Connecting...' : 'Save'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setError(null);
                setClientId('');
                setClientSecret('');
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
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#6C47FF] text-sm font-bold text-white">
          A
        </span>
        <div>
          <p className="text-sm font-medium text-navy">Aikido Security</p>
          <p className="text-xs text-gray-text">
            Cloud-native application security platform
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
