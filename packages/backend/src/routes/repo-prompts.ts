import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { REPO_PROMPT_MAX_LENGTH } from '@sutura/common';
import {
  upsertRepoPrompt,
  listRepoPrompts,
  getRepoPromptSecret,
  deleteRepoPrompt,
  upsertToolchainCheck,
  listToolchainChecks,
} from '../db/repo-prompts';
import { evaluateToolchain, fetchRepoContext } from '../lib/toolchain-check';
import { deriveToolchainFromPrompt } from '../lib/toolchain-derive';
import { getOrganization } from '../db/organizations';
import { getConnectionSecret } from '../db/connections';
import { getInstallationToken } from '../github/app-auth';
import { getConfig } from '../config';

/**
 * Repo-scoped test-environment prompts. The org identity is taken ONLY from
 * the verified JWT (req.orgId) set by authMiddleware. The prompt plaintext is
 * accepted exactly once (PUT) and encrypted by the db layer; every response is
 * the preview-only status shape -- there is NO endpoint returning plaintext.
 */
export const repoPromptsRouter = Router();

/** Sentinel thrown by the derive wrapper when no Anthropic key is available. */
const ANTHROPIC_NOT_CONNECTED = 'anthropic_not_connected';

/**
 * Read the /*repo wildcard param. Express 5 (path-to-regexp v8) delivers a
 * wildcard param as an ARRAY of path segments (['acme','api']); rejoin so
 * owner/repo slashes survive.
 */
function readRepo(req: Request): string {
  const raw = req.params['repo'] as unknown;
  return Array.isArray(raw) ? raw.join('/') : String(raw);
}

// GET / -- prompt statuses + latest toolchain checks for the org (previews only)
repoPromptsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const [prompts, checks] = await Promise.all([
      listRepoPrompts(authReq.orgId),
      listToolchainChecks(authReq.orgId),
    ]);
    res.json({ prompts, checks });
  } catch (err) {
    next(err);
  }
});

// PUT /*repo -- write-once prompt upsert. Plaintext arrives here ONCE and is
// encrypted inside upsertRepoPrompt; the response is the status shape only.
repoPromptsRouter.put('/*repo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const repo = readRepo(req);
    const body = (req.body ?? {}) as { prompt?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.length === 0 || prompt.length > REPO_PROMPT_MAX_LENGTH) {
      res.status(400).json({ error: `prompt must be 1..${REPO_PROMPT_MAX_LENGTH} characters` });
      return;
    }
    const status = await upsertRepoPrompt({
      orgId: authReq.orgId,
      repo,
      kind: 'test_environment',
      prompt,
      createdBy: authReq.actor,
    });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// DELETE /*repo -- remove the prompt (db layer downgrades a stale custom_ready check)
repoPromptsRouter.delete('/*repo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    await deleteRepoPrompt(authReq.orgId, readRepo(req), 'test_environment');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /*repo/check -- detect the repo toolchain (manifests via the org's
// GitHub App installation), deriving a custom config from the developer prompt
// when needed, and persist the result.
repoPromptsRouter.post('/*repo/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const orgId = authReq.orgId;
    const repo = readRepo(req);

    // GitHub App installation token, resolved the same way the validation
    // worker does (installation id from the org settings row).
    const org = await getOrganization(orgId);
    const installationId = org?.settings_json?.integrations?.github?.installationId;
    if (!installationId) {
      res.status(409).json({ error: 'github_not_connected' });
      return;
    }
    let githubToken: string;
    try {
      githubToken = await getInstallationToken(installationId);
    } catch (err) {
      console.warn('[repo-prompts] failed to mint installation token:', err);
      res.status(409).json({ error: 'github_not_connected' });
      return;
    }

    const [context, developerPrompt] = await Promise.all([
      fetchRepoContext(repo, githubToken),
      getRepoPromptSecret(orgId, repo, 'test_environment'),
    ]);

    // Anthropic key precedence mirrors the validation worker: org-scoped DB
    // connection first, env config as the final fallback.
    const anthropicApiKey =
      (await getConnectionSecret(orgId, 'anthropic').catch(() => null)) ||
      getConfig().ANTHROPIC_API_KEY ||
      '';

    const evaluation = await evaluateToolchain({
      manifests: context.manifests,
      rootListing: context.rootListing,
      developerPrompt,
      derive: async (prompt, rootListing, manifests) => {
        // Derivation is only reached when detection failed AND a prompt
        // exists; without a key be explicit instead of silently skipping.
        if (!anthropicApiKey) throw new Error(ANTHROPIC_NOT_CONNECTED);
        return deriveToolchainFromPrompt({
          repo,
          developerPrompt: prompt,
          rootListing,
          manifests,
          anthropicApiKey,
        });
      },
    });

    // evaluateToolchain wraps derive errors as 'derivation failed: <msg>';
    // surface the missing-key sentinel as a clean machine-readable detail.
    const detail = evaluation.detail?.includes(ANTHROPIC_NOT_CONNECTED)
      ? ANTHROPIC_NOT_CONNECTED
      : evaluation.detail;

    const result = await upsertToolchainCheck({
      orgId,
      repo,
      status: evaluation.status,
      language: evaluation.language,
      testFramework: evaluation.testFramework,
      derivedConfig: evaluation.derivedConfig,
      detail,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
