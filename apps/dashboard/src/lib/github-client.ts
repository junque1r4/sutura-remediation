import type { GitHubRepo, GitHubInstallation } from '@/types';

export async function fetchGitHubStatus(): Promise<{
  connected: boolean;
  installation?: GitHubInstallation;
}> {
  const res = await fetch('/api/github/status');
  if (!res.ok) return { connected: false };
  return res.json();
}

export async function fetchGitHubRepos(): Promise<GitHubRepo[]> {
  const res = await fetch('/api/github/repos');
  if (!res.ok) throw new Error('Failed to fetch repositories');
  return res.json();
}

export async function disconnectGitHub(): Promise<void> {
  const res = await fetch('/api/github/disconnect', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to disconnect');
}
