/**
 * Pure client helpers for the Repository Test Environments section.
 *
 * All calls go through the authenticated dashboard proxy
 * (`/api/backend/...` -> backend `/api/...`); the backend only ever returns a
 * server-generated preview of a saved prompt -- the plaintext is write-only.
 * Kept free of React/`@/` imports so it can be unit-tested under the root
 * node-environment vitest config.
 */

import type {
  RepoPromptStatus,
  RepoToolchainCheckResult,
  RepoToolchainStatus,
} from '@sutura/common';

/** Wire shape of GET /api/backend/repo-prompts entries (`kind` is implied --
 *  the section only deals in test_environment prompts). */
export type PromptStatus = Omit<RepoPromptStatus, 'kind'>;

export type CheckResult = RepoToolchainCheckResult;

export type RepoStatusKey = RepoToolchainStatus | 'unchecked';

export const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  supported: { label: 'Supported', className: 'bg-status-success/10 text-status-success' },
  custom_ready: { label: 'Custom environment ready', className: 'bg-blue-100 text-blue-700' },
  needs_prompt: { label: 'Needs prompt', className: 'bg-orange/10 text-orange-deep' },
  error: { label: 'Check failed', className: 'bg-red-100 text-red-700' },
  unchecked: { label: 'Not checked', className: 'bg-gray-100 text-gray-muted' },
};

export interface RepoPromptsViewState {
  prompts: Record<string, PromptStatus>;
  checks: Record<string, CheckResult>;
  /** Repo currently open in the prompt dialog, or null. */
  editing: string | null;
  /** Plaintext draft; must be cleared the moment a save succeeds. */
  draft: string;
}

export const initialViewState: RepoPromptsViewState = {
  prompts: {},
  checks: {},
  editing: null,
  draft: '',
};

function repoPromptUrl(repo: string): string {
  // `repo` is "owner/name"; the proxy forwards the path verbatim, so the
  // slash must stay a literal path separator.
  return `/api/backend/repo-prompts/${repo}`;
}

export async function fetchRepoPromptStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<{ prompts: PromptStatus[]; checks: CheckResult[] }> {
  const res = await fetchImpl('/api/backend/repo-prompts', { cache: 'no-store' });
  if (!res.ok) return { prompts: [], checks: [] };
  const body = (await res.json()) as { prompts?: PromptStatus[]; checks?: CheckResult[] };
  return { prompts: body.prompts ?? [], checks: body.checks ?? [] };
}

export async function putRepoPrompt(
  repo: string,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PromptStatus> {
  const res = await fetchImpl(repoPromptUrl(repo), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(`Failed to save prompt for ${repo} (${res.status})`);
  return (await res.json()) as PromptStatus;
}

export async function runRepoCheck(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckResult> {
  const res = await fetchImpl(`${repoPromptUrl(repo)}/check`, { method: 'POST' });
  if (!res.ok) throw new Error(`Toolchain check failed for ${repo} (${res.status})`);
  return (await res.json()) as CheckResult;
}

export async function deleteRepoPrompt(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(repoPromptUrl(repo), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to remove prompt for ${repo} (${res.status})`);
}

/** Success transition for a saved prompt: store ONLY the server-returned
 *  status (preview, length, timestamp) and drop the plaintext draft. */
export function applyPromptSaved(
  state: RepoPromptsViewState,
  repo: string,
  status: PromptStatus,
): RepoPromptsViewState {
  return {
    ...state,
    prompts: { ...state.prompts, [repo]: status },
    editing: null,
    draft: '',
  };
}

export function applyCheckResult(
  state: RepoPromptsViewState,
  repo: string,
  check: CheckResult,
): RepoPromptsViewState {
  return { ...state, checks: { ...state.checks, [repo]: check } };
}

export function statusKey(check: CheckResult | undefined): RepoStatusKey {
  return check?.status ?? 'unchecked';
}

export function promptCellText(prompt: PromptStatus | undefined): string {
  return prompt?.hasPrompt ? prompt.preview : 'No prompt';
}

/** Union of GitHub-installed repos and repos that already have a prompt or a
 *  check row (a prompt may outlive an installation), deduped and sorted. */
export function mergeKnownRepos(
  ghRepoFullNames: string[],
  prompts: PromptStatus[],
  checks: CheckResult[],
): string[] {
  const known = new Set<string>([
    ...ghRepoFullNames,
    ...prompts.map((p) => p.repo),
    ...checks.map((c) => c.repo),
  ]);
  known.delete('');
  return [...known].sort();
}
