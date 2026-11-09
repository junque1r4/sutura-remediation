import { describe, expect, it, vi } from 'vitest';
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
  type CheckResult,
  type PromptStatus,
  type RepoPromptsViewState,
} from '../repo-prompts-client';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const serverStatus: PromptStatus = {
  repo: 'acme/api',
  hasPrompt: true,
  preview: 'Use dotnet 8.',
  promptLength: 36,
  updatedAt: '2026-06-11T00:00:00.000Z',
};

const typedPrompt = 'Use dotnet 8.\nPrivate registry: npm.acme.internal';

describe('putRepoPrompt', () => {
  it('PUTs the typed prompt to the repo-scoped proxy URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(serverStatus));
    const result = await putRepoPrompt('acme/api', typedPrompt, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/backend/repo-prompts/acme/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: typedPrompt }),
    });
    expect(result).toEqual(serverStatus);
  });

  it('throws on a non-ok response so the draft is kept for retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'too long' }, false, 400));
    await expect(
      putRepoPrompt('acme/api', typedPrompt, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow();
  });
});

describe('applyPromptSaved', () => {
  it('clears the typed draft immediately and closes the editor', () => {
    const state: RepoPromptsViewState = {
      ...initialViewState,
      editing: 'acme/api',
      draft: typedPrompt,
    };
    const next = applyPromptSaved(state, 'acme/api', serverStatus);

    expect(next.draft).toBe('');
    expect(next.editing).toBeNull();
  });

  it('keeps only the server-returned preview, never the typed text', () => {
    const state: RepoPromptsViewState = {
      ...initialViewState,
      editing: 'acme/api',
      draft: typedPrompt,
    };
    const next = applyPromptSaved(state, 'acme/api', serverStatus);

    expect(next.prompts['acme/api']).toEqual(serverStatus);
    expect(promptCellText(next.prompts['acme/api'])).toBe('Use dotnet 8.');
    // The full plaintext must not survive anywhere in view state.
    expect(JSON.stringify(next)).not.toContain('Private registry');
  });
});

describe('promptCellText', () => {
  it('renders No prompt when the repo has none', () => {
    expect(promptCellText(undefined)).toBe('No prompt');
    expect(promptCellText({ ...serverStatus, hasPrompt: false, preview: '' })).toBe('No prompt');
  });
});

describe('runRepoCheck', () => {
  const check: CheckResult = {
    repo: 'acme/api',
    status: 'custom_ready',
    language: 'dotnet',
    testFramework: 'xunit',
    detail: null,
    checkedAt: '2026-06-11T00:00:00.000Z',
  };

  it('POSTs to the /check endpoint for the repo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(check));
    const result = await runRepoCheck('acme/api', fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith('/api/backend/repo-prompts/acme/api/check', {
      method: 'POST',
    });
    expect(result).toEqual(check);
  });

  it('applyCheckResult updates exactly that repo row', () => {
    const next = applyCheckResult(initialViewState, 'acme/api', check);
    expect(next.checks['acme/api']).toEqual(check);
    expect(statusKey(next.checks['acme/api'])).toBe('custom_ready');
    expect(statusKey(next.checks['other/repo'])).toBe('unchecked');
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 409));
    await expect(runRepoCheck('acme/api', fetchMock as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe('deleteRepoPrompt', () => {
  it('sends DELETE to the repo-scoped URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    await deleteRepoPrompt('acme/api', fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith('/api/backend/repo-prompts/acme/api', {
      method: 'DELETE',
    });
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(
      deleteRepoPrompt('acme/api', fetchMock as unknown as typeof fetch),
    ).rejects.toThrow();
  });
});

describe('fetchRepoPromptStatus', () => {
  it('returns prompts and checks from the proxy', async () => {
    const body = { prompts: [serverStatus], checks: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    const result = await fetchRepoPromptStatus(fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith('/api/backend/repo-prompts', { cache: 'no-store' });
    expect(result).toEqual(body);
  });

  it('degrades to empty lists when the backend is unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 502));
    const result = await fetchRepoPromptStatus(fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ prompts: [], checks: [] });
  });
});

describe('mergeKnownRepos', () => {
  it('unions GitHub repos with prompt/check rows, deduped and sorted', () => {
    const repos = mergeKnownRepos(
      ['acme/api', 'acme/web', ''],
      [{ ...serverStatus, repo: 'acme/legacy' }],
      [
        {
          repo: 'acme/api',
          status: 'supported',
          language: 'node',
          testFramework: 'vitest',
          detail: null,
          checkedAt: '2026-06-11T00:00:00.000Z',
        },
      ],
    );
    expect(repos).toEqual(['acme/api', 'acme/legacy', 'acme/web']);
  });
});

describe('STATUS_BADGE', () => {
  it('has an English label for every status including unchecked', () => {
    for (const key of ['supported', 'custom_ready', 'needs_prompt', 'error', 'unchecked']) {
      expect(STATUS_BADGE[key]?.label).toBeTruthy();
      expect(STATUS_BADGE[key]?.className).toBeTruthy();
    }
  });
});
