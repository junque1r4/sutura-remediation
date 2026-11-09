import type { Finding, SnykConnection } from '@/types';

export async function fetchSnykStatus(): Promise<{ connected: boolean; connection?: SnykConnection }> {
  const res = await fetch('/api/snyk/status');
  if (!res.ok) return { connected: false };
  return res.json();
}

export async function connectSnyk(
  apiToken: string,
  orgId: string,
  orgName: string,
): Promise<{ connected: boolean; connection?: SnykConnection }> {
  const res = await fetch('/api/snyk/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiToken, orgId, orgName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? 'Failed to connect to Snyk');
  }
  return res.json();
}

export async function disconnectSnyk(): Promise<void> {
  const res = await fetch('/api/snyk/disconnect', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to disconnect');
}

export async function fetchSnykIssues(): Promise<Finding[]> {
  const res = await fetch('/api/snyk/issues');
  if (!res.ok) throw new Error('Failed to fetch Snyk issues');
  return res.json();
}
