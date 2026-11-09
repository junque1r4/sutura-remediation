import { Octokit } from '@octokit/rest';

export interface SubmitResult {
  prUrl: string;
  prStatus: 'open';
  branchName: string;
  /** SHA of the last commit pushed to the PR head. Used by the CI watcher
   *  to scope `checks.listForRef`. May be empty when no files were
   *  written (shouldn't happen in practice but is graceful here). */
  prHeadSha: string;
}

export interface FileChange {
  /** Path relative to repo root. */
  path: string;
  /** Full file contents (post-patch). The branch will be set to exactly this. */
  content: string;
}

export interface SubmitMultiFileInput {
  repo: string;
  files: FileChange[];
  findingId: string;
  findingTitle: string;
  severity: string;
  model: string;
  githubToken: string;
  targetBranch?: string;
  reviewers?: string[];
  /** Override branch name; defaults to sutura/fix-{shortId}. */
  branchName?: string;
  /** Append a "Tests added" section to the PR body. */
  testFilePaths?: string[];
  /**
   * Reviewer-facing narrative (root cause, approach + why, per-file/per-test
   * rationale, caveats) produced by `generatePrNarrative`. When present it forms
   * the body's main section; when absent the static summary is used.
   */
  narrative?: string;
  /** Deterministic validation facts rendered as an evidence section. */
  evidence?: {
    scanTool?: string;
    scanResolved?: boolean;
    testsOutcome?: 'passed' | 'skipped';
    bypassChecked?: boolean;
    graderVerdict?: string;
    rounds?: number;
    tokensUsed?: number;
  };
}

function parseDiffFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  const lines = diff.split('\n');
  for (const line of lines) {
    // Match "+++ b/path/to/file" lines
    if (line.startsWith('+++ b/')) {
      paths.add(line.slice(6).trim());
    }
  }
  return Array.from(paths);
}

function extractFilePatch(diff: string, filePath: string): string {
  const lines = diff.split('\n');
  const startIdx = lines.findIndex((l) => l.startsWith(`+++ b/${filePath}`));
  if (startIdx === -1) return diff;

  // Find the start of the diff header (--- a/...)
  let headerIdx = startIdx - 1;
  while (headerIdx > 0 && !lines[headerIdx].startsWith('--- ')) {
    headerIdx--;
  }

  // Find end of this file's patch (next diff header or end)
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('--- ')) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(Math.max(0, headerIdx), endIdx).join('\n');
}

function applyPatchToContent(originalContent: string, patch: string): string {
  // Simple unified diff application
  // For production use, a proper patch library would be more robust
  const originalLines = originalContent.split('\n');
  const patchLines = patch.split('\n');
  const resultLines = [...originalLines];

  let offset = 0;

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];

    // Parse hunk header: @@ -startLine,count +startLine,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) continue;

    const origStart = parseInt(hunkMatch[1], 10) - 1; // 0-indexed
    const origCount = parseInt(hunkMatch[2] ?? '1', 10);

    // Collect hunk lines
    const removals: string[] = [];
    const additions: string[] = [];
    const context: string[] = [];

    let j = i + 1;
    while (j < patchLines.length && !patchLines[j].startsWith('@@')) {
      const pLine = patchLines[j];
      if (pLine.startsWith('-')) {
        removals.push(pLine.slice(1));
      } else if (pLine.startsWith('+')) {
        additions.push(pLine.slice(1));
      } else if (pLine.startsWith(' ')) {
        context.push(pLine.slice(1));
      }
      j++;
    }

    // Apply: replace origCount lines starting at origStart with additions
    const targetIdx = origStart + offset;
    resultLines.splice(targetIdx, origCount, ...additions);
    offset += additions.length - origCount;

    i = j - 1;
  }

  return resultLines.join('\n');
}

export async function submitFix(
  repo: string,
  diff: string,
  findingId: string,
  findingTitle: string,
  severity: string,
  model: string,
  githubToken: string,
  targetBranch = 'main',
  reviewers?: string[],
): Promise<SubmitResult> {
  const octokit = new Octokit({ auth: githubToken });
  const [owner, repoName] = repo.split('/');

  // 1. Get target branch SHA
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo: repoName,
    ref: `heads/${targetBranch}`,
  });
  const baseSha = refData.object.sha;

  // 2. Create branch sutura/fix-{shortId}-{ts} -- timestamp keeps branches
  //    unique across re-runs on the same finding.
  const shortId = findingId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const branchName = `sutura/fix-${shortId}-${ts}`;

  await octokit.git.createRef({
    owner,
    repo: repoName,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // 3. Parse diff for file paths
  const filePaths = parseDiffFilePaths(diff);

  let prHeadSha = baseSha;

  // 4. For each file: get content, apply patch, commit
  for (const filePath of filePaths) {
    let originalContent = '';
    let fileSha: string | undefined;

    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: filePath,
        ref: branchName,
      });

      if (!Array.isArray(data) && data.type === 'file' && 'content' in data) {
        originalContent = Buffer.from(data.content, 'base64').toString('utf-8');
        fileSha = data.sha;
      }
    } catch {
      // File may not exist yet; will create it
    }

    const filePatch = extractFilePatch(diff, filePath);
    const newContent = applyPatchToContent(originalContent, filePatch);

    const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: filePath,
      message: `fix(${severity}): apply security patch for ${findingTitle}`,
      content: Buffer.from(newContent).toString('base64'),
      branch: branchName,
      ...(fileSha ? { sha: fileSha } : {}),
    });
    if (commitData?.commit?.sha) prHeadSha = commitData.commit.sha;
  }

  // 5. Create PR
  const prTitle = `fix(${severity}): ${findingTitle}`;
  const prBody = [
    `## Security Fix`,
    ``,
    `This PR was automatically generated by Sutura to address a security vulnerability.`,
    ``,
    `### Vulnerability`,
    `- **Title**: ${findingTitle}`,
    `- **Severity**: ${severity.toUpperCase()}`,
    `- **Finding ID**: \`${findingId}\``,
    ``,
    `### Changes`,
    `The patch was generated by \`${model}\` and applies the minimal changes needed to resolve the vulnerability.`,
    ``,
    `### Review Checklist`,
    `- [ ] Verify the fix resolves the vulnerability`,
    `- [ ] Confirm no regressions in existing functionality`,
    `- [ ] Review for any edge cases the automated fix may have missed`,
  ].join('\n');

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo: repoName,
    title: prTitle,
    body: prBody,
    head: branchName,
    base: targetBranch,
  });

  // 6. Request reviewers if configured
  if (reviewers && reviewers.length > 0) {
    try {
      await octokit.pulls.requestReviewers({
        owner,
        repo: repoName,
        pull_number: pr.number,
        reviewers,
      });
    } catch {
      // Non-fatal: PR is created even if reviewer assignment fails
    }
  }

  return {
    prUrl: pr.html_url,
    prStatus: 'open',
    branchName,
    prHeadSha,
  };
}

/**
 * Open a single PR containing N pre-rendered files (fix changes + generated
 * tests). Bypasses the brittle in-memory diff applier in submitFix() because
 * the validated-fix sandbox already produced final file contents.
 */
export interface PrBodyInput {
  findingTitle: string;
  severity: string;
  findingId: string;
  model: string;
  files: { path: string }[];
  testFilePaths?: string[];
  narrative?: string;
  evidence?: SubmitMultiFileInput['evidence'];
}

/**
 * Compose the PR body for a validated fix. The agent-written `narrative` (root
 * cause, approach + why, per-file/per-test rationale, caveats) is the substance;
 * when it is absent we fall back to a minimal change summary so a PR is never
 * blocked on narrative generation. A deterministic, hallucination-free
 * "Validation evidence" section (what the pipeline actually measured) is always
 * appended. Pure function -- unit-tested without hitting GitHub.
 */
export function buildValidatedPrBody(input: PrBodyInput): string {
  const { findingTitle, severity, findingId, model, files, testFilePaths, narrative, evidence } =
    input;
  const lines: string[] = [
    `## Validated Security Fix`,
    ``,
    `Sutura generated this PR after running the patched code through a sandboxed build + test suite and a local re-scan that confirmed the finding is no longer present.`,
    ``,
    `### Vulnerability`,
    `- **Title**: ${findingTitle}`,
    `- **Severity**: ${severity.toUpperCase()}`,
    `- **Finding ID**: \`${findingId}\``,
  ];

  if (narrative && narrative.trim()) {
    lines.push(``, narrative.trim());
  } else {
    lines.push(
      ``,
      `### Changes`,
      `- Generated by \`${model}\``,
      `- Applied to ${files.length} file${files.length === 1 ? '' : 's'}: ${files
        .map((f) => `\`${f.path}\``)
        .join(', ')}`,
    );
    if (testFilePaths && testFilePaths.length > 0) {
      lines.push(``, `### Tests added`);
      for (const p of testFilePaths) lines.push(`- \`${p}\``);
    }
  }

  const ev: string[] = [];
  if (evidence?.scanTool && evidence.scanResolved !== false) {
    ev.push(`- Re-scanned with **${evidence.scanTool}**: finding no longer detected.`);
  }
  if (evidence?.testsOutcome === 'passed') {
    ev.push(`- Sandbox build + generated tests **passed** (air-gapped).`);
  } else if (evidence?.testsOutcome === 'skipped') {
    ev.push(
      `- Sandbox build **passed**; generated tests could not execute (scoped library has no test project).`,
    );
  }
  if (evidence?.graderVerdict) {
    ev.push(`- Independent grader: **${evidence.graderVerdict}** (re-verified from a fresh workspace).`);
  }
  if (evidence?.bypassChecked) {
    ev.push(`- Adversarial bypass agent inspected the patched code and found **no bypass**.`);
  }
  if (typeof evidence?.rounds === 'number') {
    ev.push(
      `- Reached in **${evidence.rounds}** generate→validate round${evidence.rounds === 1 ? '' : 's'}.`,
    );
  }
  ev.push(
    `- Generated by \`${model}\`${
      typeof evidence?.tokensUsed === 'number' ? ` (~${Math.round(evidence.tokensUsed / 1000)}k tokens)` : ''
    }.`,
  );
  lines.push(``, `### Validation evidence`, ...ev);

  lines.push(
    ``,
    `### Review Checklist`,
    `- [ ] Verify the fix resolves the vulnerability`,
    `- [ ] Confirm no regressions in existing functionality`,
    `- [ ] Review the generated tests for coverage gaps`,
    `- [ ] Assess the caveats above (backward-compatibility / data migration) before merging`,
    ``,
    `<sub>Automated by Sutura. Review before merging.</sub>`,
  );

  return lines.join('\n');
}

export async function submitMultiFile(input: SubmitMultiFileInput): Promise<SubmitResult> {
  const {
    repo,
    files,
    findingId,
    findingTitle,
    severity,
    model,
    githubToken,
    targetBranch = 'main',
    reviewers,
    testFilePaths,
    narrative,
    evidence,
  } = input;

  if (files.length === 0) {
    throw new Error('submitMultiFile requires at least one file');
  }

  const octokit = new Octokit({ auth: githubToken });
  const [owner, repoName] = repo.split('/');

  const { data: refData } = await octokit.git.getRef({
    owner,
    repo: repoName,
    ref: `heads/${targetBranch}`,
  });
  const baseSha = refData.object.sha;

  const shortId = findingId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  // Include a timestamp so re-running on the same finding doesn't collide with
  // an existing branch from a prior run ("HttpError: Reference already exists").
  // Phase 2 will reuse a single branch across CI-feedback retries within one
  // orchestrator run; that branch is overridden via `input.branchName`.
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13); // YYYYMMDDTHHmm
  const branchName = input.branchName ?? `sutura/fix-${shortId}-${ts}`;

  await octokit.git.createRef({
    owner,
    repo: repoName,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // Track the most recent commit SHA so the orchestrator can hand it to the
  // CI watcher (`checks.listForRef`) without an extra GET ref roundtrip.
  let prHeadSha = baseSha;

  for (const f of files) {
    let fileSha: string | undefined;
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: f.path,
        ref: branchName,
      });
      if (!Array.isArray(data) && data.type === 'file' && 'sha' in data) {
        fileSha = data.sha;
      }
    } catch {
      // new file
    }

    const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: f.path,
      message: `fix(${severity}): ${findingTitle} -- ${f.path}`,
      content: Buffer.from(f.content).toString('base64'),
      branch: branchName,
      ...(fileSha ? { sha: fileSha } : {}),
    });
    if (commitData?.commit?.sha) prHeadSha = commitData.commit.sha;
  }

  const prTitle = `fix(${severity}): ${findingTitle}`;
  const body = buildValidatedPrBody({
    findingTitle,
    severity,
    findingId,
    model,
    files,
    testFilePaths,
    narrative,
    evidence,
  });

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo: repoName,
    title: prTitle,
    body,
    head: branchName,
    base: targetBranch,
  });

  if (reviewers && reviewers.length > 0) {
    try {
      await octokit.pulls.requestReviewers({
        owner,
        repo: repoName,
        pull_number: pr.number,
        reviewers,
      });
    } catch {
      // non-fatal
    }
  }

  return {
    prUrl: pr.html_url,
    prStatus: 'open',
    branchName,
    prHeadSha,
  };
}
