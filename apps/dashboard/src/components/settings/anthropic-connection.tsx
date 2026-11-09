'use client';

import { useState, useEffect } from 'react';
import {
  fetchAnthropicStatus,
  connectAnthropic,
  disconnectAnthropic,
} from '@/lib/anthropic-client';

export function AnthropicConnection() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnthropicStatus()
      .then((data) => {
        setConnected(data.connected);
        setConnectedAt(data.connectedAt ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleConnect() {
    if (!apiKey.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectAnthropic(apiKey.trim());
      setConnected(result.connected);
      setConnectedAt(result.connectedAt ?? null);
      setShowForm(false);
      setApiKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid API key');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectAnthropic();
      setConnected(false);
      setConnectedAt(null);
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return <div className="h-16 animate-pulse rounded-md bg-cream-warm" />;
  }

  if (connected) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border-light p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#D97706] text-sm font-bold text-white">
            C
          </span>
          <div>
            <p className="text-sm font-medium text-navy">Claude AI</p>
            <p className="text-xs text-gray-text">
              Connected{connectedAt && ` since ${new Date(connectedAt).toLocaleDateString()}`}
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

  if (showForm) {
    return (
      <div className="rounded-md border border-border-light p-4">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#D97706] text-sm font-bold text-white">
            C
          </span>
          <div>
            <p className="text-sm font-medium text-navy">Claude AI</p>
            <p className="text-xs text-gray-text">Enter your Anthropic API key to enable AI analysis</p>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
        )}

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-api03-..."
              className="w-full rounded border border-border px-3 py-1.5 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleConnect}
              disabled={connecting || !apiKey.trim()}
              className="rounded bg-orange px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-deep disabled:opacity-50"
            >
              {connecting ? 'Validating...' : 'Save'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setError(null);
                setApiKey('');
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

  return (
    <div className="flex items-center justify-between rounded-md border border-border-light p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#D97706] text-sm font-bold text-white">
          C
        </span>
        <div>
          <p className="text-sm font-medium text-navy">Claude AI</p>
          <p className="text-xs text-gray-text">
            AI-powered vulnerability analysis and fix generation
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
