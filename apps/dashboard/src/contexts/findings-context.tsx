'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Finding } from '@/types';
import { fetchFindings } from '@/lib/backend-client';
import { mergeBackendFields } from '@/lib/findings-utils';

interface FindingsContextValue {
  findings: Finding[];
  loading: boolean;
  error: string | null;
  total: number;
  refetch: () => void;
}

const FindingsContext = createContext<FindingsContextValue>({
  findings: [],
  loading: true,
  error: null,
  total: 0,
  refetch: () => {},
});

export function useFindings() {
  return useContext(FindingsContext);
}

export function FindingsProvider({ children }: { children: React.ReactNode }) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // DB-backed mode: the persisted findings table is the durable source of
      // truth (populated by the scanner sync poll / "Sync now"). The backend
      // already returns rows in the dashboard Finding shape, so use them as the
      // list directly instead of fetching live from Aikido.
      if (process.env.NEXT_PUBLIC_FINDINGS_FROM_DB === 'true') {
        const backend = await fetchFindings({ pageSize: 500 });
        setFindings(backend.data);
        setTotal(backend.data.length);
        return;
      }

      const res = await fetch('/api/aikido/issues');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed: ${res.status}`);
      }
      const data = (await res.json()) as Finding[];

      // Enrich the live Aikido list with backend-only verification (workstream
      // C) and dedup (workstream D) fields. Non-fatal by design: if the backend
      // is down or returns nothing, fall through to the raw Aikido findings so
      // the list never goes blank.
      let enriched = data;
      try {
        const backend = await fetchFindings({ pageSize: 500 });
        enriched = mergeBackendFields(data, backend.data);
      } catch (mergeErr) {
        console.warn('Backend findings enrichment failed; using Aikido data only', mergeErr);
      }

      setFindings(enriched);
      setTotal(enriched.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load findings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return (
    <FindingsContext.Provider value={{ findings, loading, error, total, refetch: fetchAll }}>
      {children}
    </FindingsContext.Provider>
  );
}
