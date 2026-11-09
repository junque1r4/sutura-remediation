import { Octokit } from '@octokit/rest';

/**
 * Download a tarball of `repo@ref` via the GitHub API. Returns a Buffer suitable
 * for DockerSandboxRunner.createWorkspace.
 *
 * When `ref` is empty/undefined, resolves the repo's default branch first --
 * scanners surface findings without a branch context, and not every repo
 * defaults to `main` (we see `development`, `master`, and `main` in the wild).
 */
export interface FetchRepoTarballResult {
  tarball: Buffer;
  /** The ref actually used (resolved default branch when caller passed none). */
  ref: string;
}

export async function fetchRepoTarball(
  repo: string,
  ref: string | undefined,
  githubToken: string,
): Promise<FetchRepoTarballResult> {
  const [owner, repoName] = repo.split('/');
  const octokit = new Octokit({ auth: githubToken });
  let resolvedRef = ref;
  if (!resolvedRef) {
    const meta = await octokit.repos.get({ owner, repo: repoName });
    resolvedRef = meta.data.default_branch;
  }
  const res = await octokit.repos.downloadTarballArchive({
    owner,
    repo: repoName,
    ref: resolvedRef,
  });
  return { tarball: Buffer.from(res.data as ArrayBuffer), ref: resolvedRef };
}
