export interface AnthropicConnectionStatus {
  connected: boolean;
  connectedAt?: string;
}

export async function fetchAnthropicStatus(): Promise<AnthropicConnectionStatus> {
  const res = await fetch('/api/anthropic/status');
  if (!res.ok) return { connected: false };
  return res.json();
}

export async function connectAnthropic(apiKey: string): Promise<AnthropicConnectionStatus> {
  const res = await fetch('/api/anthropic/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? 'Failed to connect');
  }
  return res.json();
}

export async function disconnectAnthropic(): Promise<void> {
  const res = await fetch('/api/anthropic/disconnect', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to disconnect');
}
