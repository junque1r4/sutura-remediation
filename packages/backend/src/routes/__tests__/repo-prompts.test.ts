import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repo-prompts', () => ({
  upsertRepoPrompt: vi.fn(),
  listRepoPrompts: vi.fn(),
  getRepoPromptSecret: vi.fn(),
  deleteRepoPrompt: vi.fn(),
  upsertToolchainCheck: vi.fn(),
  listToolchainChecks: vi.fn(),
}));

vi.mock('../../db/organizations', () => ({
  getOrganization: vi.fn(),
}));

vi.mock('../../db/connections', () => ({
  getConnectionSecret: vi.fn(),
}));

vi.mock('../../github/app-auth', () => ({
  getInstallationToken: vi.fn(),
}));

// Keep evaluateToolchain REAL (it is the decision core under test for the
// check route wiring); only the GitHub fetcher is mocked.
vi.mock('../../lib/toolchain-check', async () => {
  const actual = await vi.importActual<typeof import('../../lib/toolchain-check')>(
    '../../lib/toolchain-check',
  );
  return { ...actual, fetchRepoContext: vi.fn() };
});

vi.mock('../../lib/toolchain-derive', () => ({
  deriveToolchainFromPrompt: vi.fn(),
}));

// Env fallback for the Anthropic key; mutable per test.
let envAnthropicKey = '';
vi.mock('../../config', () => ({
  getConfig: () => ({ ANTHROPIC_API_KEY: envAnthropicKey }),
}));

import { repoPromptsRouter } from '../repo-prompts';
import {
  upsertRepoPrompt,
  listRepoPrompts,
  getRepoPromptSecret,
  deleteRepoPrompt,
  upsertToolchainCheck,
  listToolchainChecks,
} from '../../db/repo-prompts';
import { getOrganization } from '../../db/organizations';
import { getConnectionSecret } from '../../db/connections';
import { getInstallationToken } from '../../github/app-auth';
import { fetchRepoContext } from '../../lib/toolchain-check';
import { deriveToolchainFromPrompt } from '../../lib/toolchain-derive';
import { REPO_PROMPT_MAX_LENGTH } from '@sutura/common';

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    query: {},
    // Express 5 (path-to-regexp v8): a /*repo wildcard param arrives as an
    // ARRAY of path segments, e.g. ['acme', 'api'].
    params: { repo: ['acme', 'api'] },
    body: {},
    orgId: 'org-1',
    actor: 'dev@acme.com',
    headers: {},
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res;
}

function getHandler(router: any, method: string, path: string): Function {
  const layer = router.stack.find((l: any) => {
    if (!l.route) return false;
    return l.route.path === path && l.route.methods[method];
  });
  if (!layer) throw new Error(`No ${method} ${path} handler found`);
  return layer.route.stack[0].handle;
}

const promptStatus = {
  repo: 'acme/api',
  kind: 'test_environment' as const,
  hasPrompt: true,
  preview: 'Use dotnet 8.',
  promptLength: 42,
  updatedAt: '2026-06-11T00:00:00Z',
};

const checkResult = {
  repo: 'acme/api',
  status: 'needs_prompt' as const,
  language: null,
  testFramework: null,
  detail: 'No supported test toolchain detected.',
  checkedAt: '2026-06-11T00:00:00Z',
};

const orgWithGithub = {
  id: 'org-1',
  name: 'Acme',
  plan: 'free',
  settings_json: { integrations: { github: { installationId: 123, account: 'acme' } } },
  custom_prompts_json: {},
  created_at: '2026-01-01T00:00:00Z',
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  envAnthropicKey = '';
});

describe('GET /', () => {
  it('returns prompts+checks with previews and never plaintext/ciphertext', async () => {
    vi.mocked(listRepoPrompts).mockResolvedValue([promptStatus]);
    vi.mocked(listToolchainChecks).mockResolvedValue([checkResult]);

    const handler = getHandler(repoPromptsRouter, 'get', '/');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(listRepoPrompts).toHaveBeenCalledWith('org-1');
    expect(listToolchainChecks).toHaveBeenCalledWith('org-1');
    const body = res.json.mock.calls[0][0];
    expect(body.prompts[0].preview).toBe('Use dotnet 8.');
    expect(body.checks).toHaveLength(1);
    const json = JSON.stringify(body);
    expect(json).not.toContain('encrypted');
    expect(json).not.toMatch(/"prompt"\s*:/); // no plaintext prompt field
    expect(json).not.toContain('ciphertext');
  });
});

describe('PUT /*repo', () => {
  it('400 on prompt longer than REPO_PROMPT_MAX_LENGTH', async () => {
    const handler = getHandler(repoPromptsRouter, 'put', '/*repo');
    const res = makeRes();
    await handler(
      makeReq({ body: { prompt: 'x'.repeat(REPO_PROMPT_MAX_LENGTH + 1) } }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(upsertRepoPrompt).not.toHaveBeenCalled();
  });

  it('400 on empty/missing prompt', async () => {
    const handler = getHandler(repoPromptsRouter, 'put', '/*repo');
    for (const body of [{}, { prompt: '' }, { prompt: 42 }]) {
      const res = makeRes();
      await handler(makeReq({ body }), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(upsertRepoPrompt).not.toHaveBeenCalled();
  });

  it('uses orgId from the auth middleware, NOT the body, and never echoes plaintext', async () => {
    vi.mocked(upsertRepoPrompt).mockResolvedValue(promptStatus);
    const handler = getHandler(repoPromptsRouter, 'put', '/*repo');
    const res = makeRes();
    await handler(
      makeReq({
        body: { prompt: 'Use dotnet 8.\nPrivateRegistrySecret here', orgId: 'attacker-org' },
      }),
      res,
      vi.fn(),
    );

    expect(upsertRepoPrompt).toHaveBeenCalledWith({
      orgId: 'org-1',
      repo: 'acme/api',
      kind: 'test_environment',
      prompt: 'Use dotnet 8.\nPrivateRegistrySecret here',
      createdBy: 'dev@acme.com',
    });
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual(promptStatus);
    expect(JSON.stringify(body)).not.toContain('PrivateRegistrySecret');
  });
});

describe('DELETE /*repo', () => {
  it('deletes by org+repo and returns 204', async () => {
    vi.mocked(deleteRepoPrompt).mockResolvedValue(undefined);
    const handler = getHandler(repoPromptsRouter, 'delete', '/*repo');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(deleteRepoPrompt).toHaveBeenCalledWith('org-1', 'acme/api', 'test_environment');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});

describe('POST /*repo/check', () => {
  it('409 github_not_connected when the org has no GitHub App installation', async () => {
    vi.mocked(getOrganization).mockResolvedValue({
      ...orgWithGithub,
      settings_json: {},
    });
    const handler = getHandler(repoPromptsRouter, 'post', '/*repo/check');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'github_not_connected' });
    expect(upsertToolchainCheck).not.toHaveBeenCalled();
  });

  it('409 github_not_connected when minting the installation token fails', async () => {
    vi.mocked(getOrganization).mockResolvedValue(orgWithGithub);
    vi.mocked(getInstallationToken).mockRejectedValue(new Error('app not installed'));
    const handler = getHandler(repoPromptsRouter, 'post', '/*repo/check');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'github_not_connected' });
  });

  it('persists+returns status error with detail anthropic_not_connected when derivation is needed but no key exists', async () => {
    vi.mocked(getOrganization).mockResolvedValue(orgWithGithub);
    vi.mocked(getInstallationToken).mockResolvedValue('ghs_token');
    vi.mocked(fetchRepoContext).mockResolvedValue({
      manifests: {},
      rootListing: ['ExampleApp.sln'],
    });
    vi.mocked(getRepoPromptSecret).mockResolvedValue('use dotnet 8');
    vi.mocked(getConnectionSecret).mockResolvedValue(null);
    envAnthropicKey = '';
    vi.mocked(upsertToolchainCheck).mockImplementation(async (input: any) => ({
      repo: input.repo,
      status: input.status,
      language: input.language ?? null,
      testFramework: input.testFramework ?? null,
      detail: input.detail ?? null,
      checkedAt: '2026-06-11T00:00:00Z',
    }));

    const handler = getHandler(repoPromptsRouter, 'post', '/*repo/check');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(deriveToolchainFromPrompt).not.toHaveBeenCalled();
    expect(upsertToolchainCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        repo: 'acme/api',
        status: 'error',
        detail: 'anthropic_not_connected',
        derivedConfig: null,
      }),
    );
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('error');
    expect(body.detail).toBe('anthropic_not_connected');
  });

  it('derives via deriveToolchainFromPrompt with the org connection key and persists custom_ready before responding', async () => {
    const derived = {
      language: 'dotnet',
      image: 'sutura/sandbox-base:latest',
      installCmd: ['sh', '-lc', 'dotnet restore'],
      testCmd: ['sh', '-lc', 'dotnet test --no-restore'],
      appendTestPaths: false,
      testFramework: 'xunit',
      testFilePattern: 'Tests/{base}SuturaTests.cs',
    };
    vi.mocked(getOrganization).mockResolvedValue(orgWithGithub);
    vi.mocked(getInstallationToken).mockResolvedValue('ghs_token');
    vi.mocked(fetchRepoContext).mockResolvedValue({
      manifests: {},
      rootListing: ['ExampleApp.sln'],
    });
    vi.mocked(getRepoPromptSecret).mockResolvedValue('use dotnet 8');
    vi.mocked(getConnectionSecret).mockResolvedValue('sk-ant-org-key');
    vi.mocked(deriveToolchainFromPrompt).mockResolvedValue(derived);
    const persisted = {
      repo: 'acme/api',
      status: 'custom_ready' as const,
      language: 'dotnet',
      testFramework: 'xunit',
      detail: null,
      checkedAt: '2026-06-11T00:00:00Z',
    };
    vi.mocked(upsertToolchainCheck).mockResolvedValue(persisted);

    const handler = getHandler(repoPromptsRouter, 'post', '/*repo/check');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(getInstallationToken).toHaveBeenCalledWith(123);
    expect(fetchRepoContext).toHaveBeenCalledWith('acme/api', 'ghs_token');
    expect(getRepoPromptSecret).toHaveBeenCalledWith('org-1', 'acme/api', 'test_environment');
    expect(deriveToolchainFromPrompt).toHaveBeenCalledWith({
      repo: 'acme/api',
      developerPrompt: 'use dotnet 8',
      rootListing: ['ExampleApp.sln'],
      manifests: {},
      anthropicApiKey: 'sk-ant-org-key',
    });
    expect(upsertToolchainCheck).toHaveBeenCalledWith({
      orgId: 'org-1',
      repo: 'acme/api',
      status: 'custom_ready',
      language: 'dotnet',
      testFramework: 'xunit',
      derivedConfig: derived,
      detail: null,
    });
    // Persisted result is what is returned -- and the developer prompt
    // plaintext never appears in the response.
    expect(res.json).toHaveBeenCalledWith(persisted);
    expect(upsertToolchainCheck.mock.invocationCallOrder[0]).toBeLessThan(
      res.json.mock.invocationCallOrder[0],
    );
  });

  it('falls back to the env Anthropic key when no org connection exists', async () => {
    vi.mocked(getOrganization).mockResolvedValue(orgWithGithub);
    vi.mocked(getInstallationToken).mockResolvedValue('ghs_token');
    vi.mocked(fetchRepoContext).mockResolvedValue({
      manifests: {},
      rootListing: ['ExampleApp.sln'],
    });
    vi.mocked(getRepoPromptSecret).mockResolvedValue('use dotnet 8');
    vi.mocked(getConnectionSecret).mockResolvedValue(null);
    envAnthropicKey = 'sk-ant-env-key';
    vi.mocked(deriveToolchainFromPrompt).mockResolvedValue({
      language: 'dotnet',
      image: 'sutura/sandbox-base:latest',
      installCmd: [],
      testCmd: ['sh', '-lc', 'dotnet test'],
      appendTestPaths: false,
      testFramework: 'xunit',
      testFilePattern: 'Tests/{base}SuturaTests.cs',
    });
    vi.mocked(upsertToolchainCheck).mockResolvedValue({ ...checkResult, status: 'custom_ready' });

    const handler = getHandler(repoPromptsRouter, 'post', '/*repo/check');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(deriveToolchainFromPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ anthropicApiKey: 'sk-ant-env-key' }),
    );
  });

  it('supported repo persists supported without touching the Anthropic key or prompt derivation', async () => {
    vi.mocked(getOrganization).mockResolvedValue(orgWithGithub);
    vi.mocked(getInstallationToken).mockResolvedValue('ghs_token');
    vi.mocked(fetchRepoContext).mockResolvedValue({
      manifests: { 'package.json': JSON.stringify({ devDependencies: { vitest: '^1' } }) },
      rootListing: ['package.json', 'src'],
    });
    vi.mocked(getRepoPromptSecret).mockResolvedValue(null);
    vi.mocked(getConnectionSecret).mockResolvedValue(null);
    vi.mocked(upsertToolchainCheck).mockResolvedValue({
      ...checkResult,
      status: 'supported',
      language: 'node',
      testFramework: 'vitest',
      detail: null,
    });

    const handler = getHandler(repoPromptsRouter, 'post', '/*repo/check');
    const res = makeRes();
    await handler(makeReq(), res, vi.fn());

    expect(deriveToolchainFromPrompt).not.toHaveBeenCalled();
    expect(upsertToolchainCheck).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'supported', language: 'node', testFramework: 'vitest' }),
    );
    expect(res.json.mock.calls[0][0].status).toBe('supported');
  });
});
