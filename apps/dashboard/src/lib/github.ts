import * as crypto from 'crypto';

import { fetchOrganization, updateOrgSettings } from '@/lib/backend-client.server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubInstallationRecord {
  installationId: number;
  account: string;
  avatarUrl: string;
  connectedAt: string;
  // 'Organization' or 'User'. Optional for backward compatibility with records
  // saved before this field was tracked; consumers should default to
  // 'Organization' when missing, since that's the common case.
  targetType?: 'Organization' | 'User';
}

// ---------------------------------------------------------------------------
// Token cache (module-level, lives for the lifetime of the serverless cold start)
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

// ---------------------------------------------------------------------------
// 1. createAppJwt
// ---------------------------------------------------------------------------

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function createAppJwt(): string {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyRaw = process.env.GITHUB_PRIVATE_KEY;

  if (!appId || !privateKeyRaw) {
    throw new Error('Missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY env vars');
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: appId,
      iat: now - 60,
      exp: now + 600,
    }),
  );

  const signingInput = `${header}.${payload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(privateKey, 'base64url');

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// 2. getInstallationToken
// ---------------------------------------------------------------------------

export async function getInstallationToken(installationId: number): Promise<string> {
  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken) {
    const fiveMinFromNow = Date.now() + 5 * 60 * 1000;
    if (cachedToken.expiresAt > fiveMinFromNow) {
      return cachedToken.token;
    }
  }

  const jwt = createAppJwt();

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sutura-app',
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    token: string;
    expires_at: string;
  };

  cachedToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };

  return data.token;
}

// ---------------------------------------------------------------------------
// 3. githubApiFetch
// ---------------------------------------------------------------------------

export async function githubApiFetch<T>(path: string, installationId: number): Promise<T> {
  const token = await getInstallationToken(installationId);

  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sutura-app',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${body}`);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// 4. DB-backed installation persistence (organizations.settings_json.integrations.github)
// ---------------------------------------------------------------------------

function readGithubFromSettings(
  settings: Record<string, unknown> | undefined,
): GitHubInstallationRecord | null {
  const integrations = (settings?.integrations ?? null) as
    | { github?: GitHubInstallationRecord | null }
    | null;
  const github = integrations?.github;
  if (!github || typeof github.installationId !== 'number') {
    return null;
  }
  return github;
}

export async function getInstallationFromOrg(): Promise<GitHubInstallationRecord | null> {
  const org = await fetchOrganization();
  return readGithubFromSettings(org.settings);
}

export async function saveInstallationToOrg(data: GitHubInstallationRecord): Promise<void> {
  const org = await fetchOrganization();
  const currentSettings = (org.settings ?? {}) as Record<string, unknown>;
  const currentIntegrations = (currentSettings.integrations ?? {}) as Record<string, unknown>;
  const merged = {
    ...currentSettings,
    integrations: { ...currentIntegrations, github: data },
  };
  await updateOrgSettings(merged);
}

export async function clearInstallationFromOrg(): Promise<void> {
  const org = await fetchOrganization();
  const currentSettings = (org.settings ?? {}) as Record<string, unknown>;
  const currentIntegrations = (currentSettings.integrations ?? {}) as Record<string, unknown>;
  const merged = {
    ...currentSettings,
    integrations: { ...currentIntegrations, github: null },
  };
  await updateOrgSettings(merged);
}
