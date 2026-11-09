import { type NextRequest, NextResponse } from 'next/server';

import { createAppJwt, saveInstallationToOrg } from '@/lib/github';
import { requirePermission, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

interface GhInstallation {
  id: number;
  account: { login: string; avatar_url: string };
  target_type: 'Organization' | 'User';
}

/**
 * Deterministically pick the installation to recover when the local record was
 * wiped but the App is still installed on GitHub. Returns null when the choice
 * is ambiguous (the caller then falls back to GitHub's install page).
 *
 *  - 0 installs: nothing to recover -> null.
 *  - exactly 1 install: use it (covers the original single-install case).
 *  - >1 installs: prefer the sole 'Organization' install. If there are zero or
 *    multiple Organization installs we do NOT guess silently -> null.
 */
function pickRecoveryInstallation(installs: GhInstallation[]): GhInstallation | null {
  if (installs.length === 0) return null;
  if (installs.length === 1) return installs[0];
  const orgInstalls = installs.filter((i) => i.target_type === 'Organization');
  if (orgInstalls.length === 1) return orgInstalls[0];
  return null;
}

export async function GET(request: NextRequest) {
  try {
    await requirePermission('integrations:write');
    const slug = process.env.GITHUB_APP_SLUG;

    if (!slug) {
      return NextResponse.json({ error: 'GITHUB_APP_SLUG is not configured' }, { status: 500 });
    }

    // Before sending the user off to GitHub, check whether our App already
    // has any installations. If we can pick one deterministically, recover it
    // locally — this covers the case where the local record was wiped but the
    // install on GitHub is intact. GitHub's "install" URL redirects an
    // already-installed App to the configure page, where "Update access"
    // doesn't fire any callback, so the standard install flow can't recover
    // from a wipe on its own.
    try {
      const jwt = createAppJwt();
      const response = await fetch('https://api.github.com/app/installations', {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sutura-app',
        },
      });
      if (response.ok) {
        const installs = (await response.json()) as GhInstallation[];
        const candidate = pickRecoveryInstallation(installs);
        if (candidate) {
          console.warn(
            `[github/install] recovering installation ${candidate.id} (${candidate.account.login}, ${candidate.target_type}) from ${installs.length} install(s)`,
          );
          await saveInstallationToOrg({
            installationId: candidate.id,
            account: candidate.account.login,
            avatarUrl: candidate.account.avatar_url,
            connectedAt: new Date().toISOString(),
            targetType: candidate.target_type,
          });
          return NextResponse.redirect(new URL('/settings?github=connected', request.url));
        }
        console.warn(
          `[github/install] ${installs.length} install(s) found but no unambiguous candidate; redirecting to GitHub install page`,
        );
      }
    } catch {
      // Recovery is best-effort; fall through to the fresh-install redirect.
    }

    return NextResponse.redirect(`https://github.com/apps/${slug}/installations/new`);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.redirect(new URL('/login?next=/settings', request.url));
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.redirect(new URL('/settings?github=forbidden', request.url));
    }
    return NextResponse.json(
      { error: 'Failed to initiate GitHub App installation' },
      { status: 500 },
    );
  }
}
