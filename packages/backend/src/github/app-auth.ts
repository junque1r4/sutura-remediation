import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { getConfig } from '../config';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 50 * 60 * 1000;
const tokenCache = new Map<number, CachedToken>();

/**
 * Mint (or reuse) a GitHub App installation token for the given installation.
 * Tokens last 60 minutes server-side; we cache for 50 to leave headroom.
 *
 * Throws if `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` are unset -- the validated-fix
 * worker should prefer this over caller-supplied PATs and surface a clear error
 * when the App credentials are missing.
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY } = getConfig();
  if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY) {
    throw new Error(
      'GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set to mint installation tokens',
    );
  }

  const auth = createAppAuth({
    appId: GITHUB_APP_ID,
    privateKey: normalizePrivateKey(GITHUB_PRIVATE_KEY),
    installationId,
  });

  const result = await auth({ type: 'installation' });
  const token = (result as { token: string }).token;
  tokenCache.set(installationId, {
    token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const token = await getInstallationToken(installationId);
  return new Octokit({ auth: token });
}

/**
 * GitHub App private keys are PEM-encoded; when stored in env they often have
 * literal `\n` sequences instead of newlines. Normalize so callers don't have
 * to think about it.
 */
function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

// Visible for tests.
export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}
