'use client';

import { useState } from 'react';
import type { LookupMatch } from '../types';

export function QuickLookup() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Record<string, LookupMatch[]> | null>(null);

  function parseInput(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
  }

  async function runLookup() {
    const names = parseInput(input);
    if (names.length === 0) {
      setMatches({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/sbom/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { matches: Record<string, LookupMatch[]> };
      setMatches(data.matches);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lookup failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-border bg-white p-4">
      <h2 className="mb-1 text-sm font-semibold text-navy">Quick lookup</h2>
      <p className="mb-3 text-xs text-gray-text">
        Paste compromised package names (one per line or comma-separated) to see if any monitored
        repo uses them.
      </p>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
        placeholder="event-stream&#10;flatmap-stream&#10;@solana/web3.js"
        className="w-full rounded-md border border-border bg-cream-warm px-3 py-2 text-sm font-mono text-navy focus:border-orange focus:outline-none focus:ring-1 focus:ring-orange"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void runLookup()}
          disabled={loading}
          className="rounded-md bg-orange px-4 py-1.5 text-sm font-medium text-navy transition-colors hover:bg-orange/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
        {error && <span className="text-xs text-severity-critical">{error}</span>}
      </div>

      {matches && Object.keys(matches).length > 0 && (
        <div className="mt-4 space-y-3">
          {Object.entries(matches).map(([term, rows]) => (
            <div key={term} className="rounded-md border border-border-light bg-cream-warm p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-navy">{term}</span>
                <span
                  className={`text-xs ${
                    rows.length === 0 ? 'text-gray-text' : 'text-severity-critical'
                  }`}
                >
                  {rows.length === 0
                    ? 'not found in any repo'
                    : `${rows.length} match${rows.length === 1 ? '' : 'es'}`}
                </span>
              </div>
              {rows.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-light text-left text-[10px] uppercase tracking-wider text-gray-text">
                      <th className="py-1 pr-3">Version</th>
                      <th className="py-1 pr-3">Ecosystem</th>
                      <th className="py-1 pr-3">Repo</th>
                      <th className="py-1">Vulns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={`${r.repoAikidoId}-${r.version}`}
                        className="border-b border-border-light last:border-b-0"
                      >
                        <td className="py-1.5 pr-3 font-mono text-navy">{r.version}</td>
                        <td className="py-1.5 pr-3 text-gray-text">{r.ecosystem ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-navy">{r.repoName}</td>
                        <td className="py-1.5 text-gray-text">{r.vulnCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
