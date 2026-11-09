import type { Finding, AikidoConnection } from '@/types';

export async function fetchAikidoStatus(): Promise<{
  connected: boolean;
  connection?: AikidoConnection;
}> {
  const res = await fetch('/api/aikido/status');
  if (!res.ok) return { connected: false };
  return res.json();
}

export async function connectAikido(
  clientId: string,
  clientSecret: string,
): Promise<{
  connected: boolean;
  connection?: AikidoConnection;
}> {
  const res = await fetch('/api/aikido/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? 'Failed to connect to Aikido');
  }
  return res.json();
}

export async function disconnectAikido(): Promise<void> {
  const res = await fetch('/api/aikido/disconnect', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to disconnect');
}

export async function fetchAikidoIssues(): Promise<Finding[]> {
  const res = await fetch('/api/aikido/issues');
  if (!res.ok) throw new Error('Failed to fetch Aikido issues');
  return res.json();
}
