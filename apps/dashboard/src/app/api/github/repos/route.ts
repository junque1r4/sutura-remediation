import { NextResponse } from 'next/server';

import type { GitHubRepo } from '@/types';
import { getInstallationFromOrg, githubApiFetch } from '@/lib/github';
import { requirePermission, jsonError, ForbiddenError, UnauthorizedError } from '@/lib/auth/server';

interface GitHubRepoResponse {
  total_count: number;
  repositories: Array<{
    id: number;
    full_name: string;
    name: string;
    owner: { login: string };
    default_branch: string;
    private: boolean;
    language: string | null;
    description: string | null;
    updated_at: string;
    html_url: string;
  }>;
}

export async function GET() {
  try {
    await requirePermission('integrations:read');
    // Dev mode: return mock repositories
    if (process.env.GITHUB_DEV_MODE === 'true') {
      const mockRepos: GitHubRepo[] = [
        {
          id: 1,
          fullName: 'acme/backend',
          name: 'backend',
          owner: 'acme',
          defaultBranch: 'main',
          isPrivate: false,
          language: 'TypeScript',
          description: 'Main backend service',
          updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          htmlUrl: 'https://github.com/acme/backend',
        },
        {
          id: 2,
          fullName: 'acme/frontend',
          name: 'frontend',
          owner: 'acme',
          defaultBranch: 'main',
          isPrivate: false,
          language: 'TypeScript',
          description: 'React dashboard',
          updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
          htmlUrl: 'https://github.com/acme/frontend',
        },
        {
          id: 3,
          fullName: 'acme/api-gateway',
          name: 'api-gateway',
          owner: 'acme',
          defaultBranch: 'main',
          isPrivate: true,
          language: 'Go',
          description: 'API gateway and routing',
          updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          htmlUrl: 'https://github.com/acme/api-gateway',
        },
        {
          id: 4,
          fullName: 'acme/shared-types',
          name: 'shared-types',
          owner: 'acme',
          defaultBranch: 'main',
          isPrivate: false,
          language: 'TypeScript',
          description: 'Shared type definitions',
          updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
          htmlUrl: 'https://github.com/acme/shared-types',
        },
        {
          id: 5,
          fullName: 'acme/infra',
          name: 'infra',
          owner: 'acme',
          defaultBranch: 'main',
          isPrivate: true,
          language: 'HCL',
          description: 'Terraform infrastructure',
          updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          htmlUrl: 'https://github.com/acme/infra',
        },
      ];
      return NextResponse.json(mockRepos);
    }

    const data = await getInstallationFromOrg();

    if (!data) {
      return NextResponse.json({ error: 'not_connected' }, { status: 401 });
    }

    const result = await githubApiFetch<GitHubRepoResponse>(
      '/installation/repositories?per_page=100',
      data.installationId,
    );

    const repos: GitHubRepo[] = result.repositories.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      defaultBranch: repo.default_branch,
      isPrivate: repo.private,
      language: repo.language,
      description: repo.description,
      updatedAt: repo.updated_at,
      htmlUrl: repo.html_url,
    }));

    return NextResponse.json(repos);
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const { status, body } = jsonError(err);
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ error: 'Failed to fetch repositories' }, { status: 500 });
  }
}
