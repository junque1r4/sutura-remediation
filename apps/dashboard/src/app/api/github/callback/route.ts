import { type NextRequest, NextResponse } from 'next/server';

import { createAppJwt, saveInstallationToOrg } from '@/lib/github';
import { requirePermission, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

export async function GET(request: NextRequest) {
  try {
    await requirePermission('integrations:write');
    const { searchParams } = request.nextUrl;
    const installationIdParam = searchParams.get('installation_id');

    if (!installationIdParam) {
      return NextResponse.redirect(new URL('/settings?github=error', request.url));
    }

    const installationId = Number(installationIdParam);
    const jwt = createAppJwt();

    const response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sutura-app',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const installation = (await response.json()) as {
      account: { login: string; avatar_url: string };
      target_type: 'Organization' | 'User';
    };

    await saveInstallationToOrg({
      installationId,
      account: installation.account.login,
      avatarUrl: installation.account.avatar_url,
      connectedAt: new Date().toISOString(),
      targetType: installation.target_type,
    });

    return NextResponse.redirect(new URL('/settings?github=connected', request.url));
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.redirect(new URL('/login?next=/settings', request.url));
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.redirect(new URL('/settings?github=forbidden', request.url));
    }
    return NextResponse.redirect(new URL('/settings?github=error', request.url));
  }
}
