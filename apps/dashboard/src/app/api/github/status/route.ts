import { NextResponse } from 'next/server';

import type { GitHubInstallation } from '@/types';
import {
  createAppJwt,
  clearInstallationFromOrg,
  getInstallationFromOrg,
  saveInstallationToOrg,
} from '@/lib/github';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

export async function GET() {
  try {
    await requirePermission('integrations:read');
    // Dev mode: return mock data without hitting GitHub
    if (process.env.GITHUB_DEV_MODE === 'true') {
      const mockInstallation: GitHubInstallation = {
        installationId: 12345,
        account: 'acme-org',
        avatarUrl: 'https://github.com/ghost.png',
        appSlug: 'sutura-dev',
        targetType: 'Organization',
      };
      return NextResponse.json({ connected: true, installation: mockInstallation });
    }

    const data = await getInstallationFromOrg();

    if (!data) {
      return NextResponse.json({ connected: false });
    }

    // Validate the installation still exists on GitHub
    const jwt = createAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${data.installationId}`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sutura-app',
        },
      },
    );

    if (response.status === 404) {
      // Install genuinely no longer exists on GitHub (user uninstalled it).
      // Safe to clear the local record.
      await clearInstallationFromOrg();
      return NextResponse.json({ connected: false });
    }

    if (!response.ok) {
      // Transient failure (rate limit, GitHub 5xx, network blip, etc.).
      // DO NOT wipe the record — report current saved state and let the user
      // try again. Wiping on transient failures has been known to silently
      // disconnect users.
      console.warn(
        `[github/status] Validation call returned ${response.status}; keeping saved install ${data.installationId}.`,
      );
      const installation: GitHubInstallation = {
        installationId: data.installationId,
        account: data.account,
        avatarUrl: data.avatarUrl,
        appSlug: process.env.GITHUB_APP_SLUG || '',
        targetType: data.targetType ?? 'Organization',
      };
      return NextResponse.json({ connected: true, installation, validationFailed: true });
    }

    const ghPayload = (await response.json()) as {
      target_type?: 'Organization' | 'User';
    };
    const targetType: 'Organization' | 'User' =
      ghPayload.target_type ?? data.targetType ?? 'Organization';

    // Backfill targetType for installations saved before the field was tracked.
    if (!data.targetType && ghPayload.target_type) {
      await saveInstallationToOrg({ ...data, targetType: ghPayload.target_type });
    }

    const installation: GitHubInstallation = {
      installationId: data.installationId,
      account: data.account,
      avatarUrl: data.avatarUrl,
      appSlug: process.env.GITHUB_APP_SLUG || '',
      targetType,
    };

    return NextResponse.json({ connected: true, installation });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ connected: false }, { status: 500 });
  }
}
