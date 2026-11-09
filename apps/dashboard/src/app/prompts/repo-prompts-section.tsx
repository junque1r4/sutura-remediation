'use client';

import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogActions } from '@/components/dialog';
import { fetchGitHubRepos } from '@/lib/github-client';
import {
  applyCheckResult,
  applyPromptSaved,
  deleteRepoPrompt,
  fetchRepoPromptStatus,
  initialViewState,
  mergeKnownRepos,
  promptCellText,
  putRepoPrompt,
  runRepoCheck,
  statusKey,
  STATUS_BADGE,
  type RepoPromptsViewState,
} from './repo-prompts-client';

const PROMPT_MAX_LENGTH = 16_384;

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function RepoPromptsSection() {
  const [repos, setRepos] = useState<string[]>([]);
  const [view, setView] = useState<RepoPromptsViewState>(initialViewState);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ghRepos, body] = await Promise.all([
        fetchGitHubRepos().catch(() => []),
        fetchRepoPromptStatus(),
      ]);
      setRepos(
        mergeKnownRepos(
          ghRepos.map((r) => r.fullName),
          body.prompts,
          body.checks,
        ),
      );
      setView((v) => ({
        ...v,
        prompts: Object.fromEntries(body.prompts.map((p) => [p.repo, p])),
        checks: Object.fromEntries(body.checks.map((c) => [c.repo, c])),
      }));
    } catch {
      setError('Failed to load repository prompt status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function withBusy(repo: string, fn: () => Promise<void>) {
    setBusy((b) => ({ ...b, [repo]: true }));
    void fn().finally(() => setBusy((b) => ({ ...b, [repo]: false })));
  }

  function handleSave(repo: string, draft: string) {
    withBusy(repo, async () => {
      try {
        const status = await putRepoPrompt(repo, draft);
        // Only the server-generated preview survives; the plaintext draft is
        // cleared from component state immediately.
        setView((v) => applyPromptSaved(v, repo, status));
        setError(null);
      } catch {
        setError(`Failed to save prompt for ${repo}.`);
      }
    });
  }

  function handleCheck(repo: string) {
    withBusy(repo, async () => {
      try {
        const check = await runRepoCheck(repo);
        setView((v) => applyCheckResult(v, repo, check));
        setError(null);
      } catch {
        setError(`Toolchain check failed for ${repo}.`);
      }
    });
  }

  function handleRemove(repo: string) {
    withBusy(repo, async () => {
      try {
        await deleteRepoPrompt(repo);
        setError(null);
        await load();
      } catch {
        setError(`Failed to remove prompt for ${repo}.`);
      }
    });
  }

  function openEditor(repo: string) {
    setView((v) => ({ ...v, editing: repo, draft: '' }));
  }

  function closeEditor() {
    // Dropping the draft on close keeps the plaintext out of state once the
    // dialog goes away, saved or not.
    setView((v) => ({ ...v, editing: null, draft: '' }));
  }

  const editingPrompt = view.editing ? view.prompts[view.editing] : undefined;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-navy">Repository Test Environments</h2>
      <p className="mb-4 mt-1 text-sm text-gray-text">
        Teach Claude how to set up each repository&apos;s test environment. Prompts are encrypted
        and injected only into that repository&apos;s validation runs.
      </p>

      <div className="mb-4 rounded-lg border border-border bg-cream-warm p-4">
        <p className="text-sm text-navy">
          <span className="font-semibold">Write-only prompts:</span> the full prompt is write-only
          — it is encrypted at rest and only injected into this repository&apos;s validation runs.
          Only a short preview is shown here.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-lg border border-border bg-cream-warm" />
      ) : repos.length === 0 ? (
        <div className="rounded-lg border border-border bg-white px-6 py-10 text-center">
          <p className="text-sm text-gray-text">
            No repositories found. Connect GitHub in Settings to manage repository test
            environments.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="border-b border-border bg-cream-warm">
                <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-gray-text">
                  Repository
                </th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-gray-text">
                  Status
                </th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-gray-text">
                  Prompt
                </th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-gray-text">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => {
                const prompt = view.prompts[repo];
                const check = view.checks[repo];
                const badge = STATUS_BADGE[statusKey(check)];
                const isBusy = busy[repo] ?? false;

                return (
                  <tr
                    key={repo}
                    className="border-b border-border-light text-sm text-navy last:border-b-0"
                  >
                    <td className="px-4 py-3 font-medium">{repo}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                      {check && (check.language || check.testFramework) && (
                        <span className="ml-2 text-xs text-gray-text">
                          {[check.language, check.testFramework].filter(Boolean).join(' / ')}
                        </span>
                      )}
                      {check &&
                        (check.status === 'needs_prompt' || check.status === 'error') &&
                        check.detail && (
                          <p className="mt-1 text-xs text-gray-muted">{check.detail}</p>
                        )}
                    </td>
                    <td className="px-4 py-3">
                      <p className={prompt?.hasPrompt ? 'text-navy' : 'text-gray-muted'}>
                        {promptCellText(prompt)}
                      </p>
                      {prompt?.hasPrompt && prompt.updatedAt && (
                        <p className="mt-0.5 text-xs text-gray-muted">
                          Updated {formatDate(prompt.updatedAt)} · {prompt.promptLength} characters
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleCheck(repo)}
                          disabled={isBusy}
                          className="rounded border border-border px-3 py-1.5 text-xs font-medium text-navy hover:bg-cream-warm disabled:opacity-50"
                        >
                          {isBusy ? 'Working...' : 'Check'}
                        </button>
                        <button
                          onClick={() => openEditor(repo)}
                          disabled={isBusy}
                          className="rounded bg-orange px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-deep disabled:opacity-50"
                        >
                          {prompt?.hasPrompt ? 'Replace prompt' : 'Teach Claude'}
                        </button>
                        {prompt?.hasPrompt && (
                          <button
                            onClick={() => handleRemove(repo)}
                            disabled={isBusy}
                            className="rounded border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={view.editing !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        title={editingPrompt?.hasPrompt ? 'Replace prompt' : 'Teach Claude'}
        description={
          view.editing
            ? `Describe how to set up the test environment for ${view.editing}: SDKs to install, how to restore dependencies, and how to run the tests.`
            : undefined
        }
        widthClassName="max-w-xl"
      >
        {view.editing && (
          <>
            {editingPrompt?.hasPrompt && (
              <p className="mb-2 text-xs text-gray-muted">
                Saving replaces the existing prompt. The current prompt cannot be viewed — only its
                preview: &ldquo;{editingPrompt.preview}&rdquo;
              </p>
            )}
            <textarea
              value={view.draft}
              onChange={(e) => setView((v) => ({ ...v, draft: e.target.value }))}
              maxLength={PROMPT_MAX_LENGTH}
              rows={10}
              placeholder={
                'e.g. This is a .NET 8 solution. Install the dotnet-sdk-8.0 package, run `dotnet restore` to fetch dependencies, then run tests with `dotnet test --no-restore`. Tests use xUnit.'
              }
              className="w-full resize-y rounded border border-border px-3 py-2 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-gray-muted">
                {view.draft.length} / {PROMPT_MAX_LENGTH} characters
              </span>
            </div>
            <p className="mt-2 text-xs text-gray-muted">
              The full prompt is write-only: it is encrypted at rest and only injected into this
              repository&apos;s validation runs. Only a short preview will be shown after saving.
            </p>
            <DialogActions>
              <button
                onClick={closeEditor}
                className="rounded border border-border px-3 py-1.5 text-xs font-medium text-navy hover:bg-cream-warm"
              >
                Cancel
              </button>
              <button
                onClick={() => view.editing && handleSave(view.editing, view.draft)}
                disabled={view.draft.trim().length === 0 || (busy[view.editing] ?? false)}
                className="rounded bg-orange px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-deep disabled:opacity-50"
              >
                {(busy[view.editing] ?? false) ? 'Saving...' : 'Save prompt'}
              </button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </section>
  );
}
