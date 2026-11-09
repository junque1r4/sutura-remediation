import type { NormalizedFinding } from '@sutura/common';
import type { FixContext } from './context';

const PRIOR_ANALYSIS_MAX_BYTES = 3_000;

/**
 * Compact system prompt for the fix agent. Keeps a single role + output format
 * directive; everything else (file content, related code) is fetched lazily by
 * the agent via tools when it needs it.
 */
export function buildSystemPrompt(): string {
  return [
    'You are a security engineer fixing vulnerabilities in production code.',
    '',
    'Your job: produce the smallest correct unified diff that resolves the reported finding ',
    'without breaking existing functionality.',
    '',
    'Process:',
    '1. Use the `read_file`, `list_directory`, and `grep_code` tools to inspect only what you need ',
    '   from the workspace. Prefer narrow line ranges over reading whole files.',
    '   NOTE: `read_file` prefixes every line with its line number and a tab (`<n>\\t<code>`). ',
    '   Those line-number prefixes are NOT part of the file -- never copy them into the diff. ',
    '   Each removed/context line must reproduce the file content EXACTLY (after the diff marker), ',
    '   with no leading line number.',
    '2. Before finalizing, check for DUPLICATES of the vulnerability. The same flaw is often ',
    '   copy-pasted into a sibling file or a parallel helper (e.g. a second class with the same weak ',
    '   crypto, the same hardcoded secret, the same unsanitized query). Use `grep_code` to search the ',
    '   repository for the insecure pattern -- the vulnerable API/function name, the hardcoded ',
    '   constant, the duplicated helper -- and patch EVERY reachable instance, not just the file in ',
    '   the finding. A fix that leaves an identical copy exploitable will be rejected. A multi-file ',
    '   diff spanning several files (and even several projects) is expected and correct here.',
    '3. When you have enough context, emit a unified diff in a ```diff code block. The diff must be ',
    '   directly applicable with `git apply` (correct file headers, hunk headers may use approximate ',
    '   counts -- the runner recounts them before applying).',
    '4. Do not include unrelated refactoring or style changes. Touch only what is needed to fix the ',
    '   vulnerability and its duplicates.',
    '',
    'When you have produced the diff, stop calling tools. The runner will validate the patch ',
    'against the workspace and rerun the security scan to confirm the fix.',
  ].join('\n');
}

/**
 * Initial user message for a fresh fix attempt. Contains finding metadata only;
 * the agent fetches file content via tools. Optionally includes a small prior
 * analysis snippet (capped at ~3 KB) when the dashboard already produced one.
 */
export function buildInitialUserMessage(
  finding: NormalizedFinding,
  priorAnalysis: string | undefined,
): string {
  const lines: string[] = [];
  lines.push('## Vulnerability Details');
  lines.push(`- **Title**: ${finding.title}`);
  lines.push(`- **Severity**: ${finding.severity.toUpperCase()}`);
  if (finding.description) {
    lines.push(`- **Description**: ${finding.description}`);
  }
  if (finding.cveId) lines.push(`- **CVE**: ${finding.cveId}`);
  if (finding.cweId) lines.push(`- **CWE**: ${finding.cweId}`);
  if (finding.filePath) lines.push(`- **File**: ${finding.filePath}`);
  if (finding.lineRange) {
    lines.push(`- **Lines**: ${finding.lineRange[0]}-${finding.lineRange[1]}`);
  }
  if (finding.packageName) {
    lines.push(`- **Package**: ${finding.packageName}`);
    if (finding.currentVersion) lines.push(`- **Current Version**: ${finding.currentVersion}`);
    if (finding.fixedVersion) lines.push(`- **Fixed Version**: ${finding.fixedVersion}`);
  }
  lines.push('');
  lines.push(
    finding.filePath
      ? `Start by reading a slice of \`${finding.filePath}\` around the affected lines, then expand only as needed.`
      : 'Start by listing the repository root to orient yourself, then read only what you need.',
  );

  if (priorAnalysis && priorAnalysis.trim()) {
    const trimmed =
      priorAnalysis.length > PRIOR_ANALYSIS_MAX_BYTES
        ? priorAnalysis.slice(-PRIOR_ANALYSIS_MAX_BYTES)
        : priorAnalysis;
    lines.push('');
    lines.push('## Prior Analysis (expert hints; verify against actual file contents)');
    lines.push('');
    lines.push(trimmed);
  }

  return lines.join('\n');
}

/**
 * Build a retry feedback message describing a previous attempt's failure.
 * Returned as a separate user-message turn so the agent can continue the same
 * conversation rather than restart from scratch.
 */
export function buildRetryFeedback(
  attemptNumber: number,
  failure: { stage: string; output: string },
): string {
  const trimmed = failure.output.length > 8_000 ? failure.output.slice(-8_000) : failure.output;
  const prev = attemptNumber - 1;
  const block = (intro: string, outro: string): string =>
    [intro, '```', trimmed, '```', outro].join('\n');

  switch (failure.stage) {
    // CI is special: the previous diff already passed the local sandbox + rescan
    // and was opened as a PR -- only GitHub Actions caught the regression. Frame
    // it so the agent doesn't re-read the already-correct files.
    case 'ci':
      return block(
        `Attempt #${prev} opened a PR but **GitHub Actions failed**. The fix passed our local sandbox; the regression is something only the upstream CI caught (build, lint, type-check, license, etc.). Logs (head + tail of each failed job):`,
        'Read the failure carefully and adjust the diff to satisfy CI. Use `read_file` / `grep_code` if you need to inspect surrounding code that the build error references. Emit a new unified diff.',
      );

    case 'patch':
      return block(
        `Your previous diff **failed to apply** to the workspace. The applier rejected it:`,
        'This is almost always a context-line mismatch: a removed/context line does not byte-for-byte match the file. Re-read the exact lines with `read_file`, reproduce them precisely, and emit a corrected **full** unified diff.',
      );

    case 'tests':
      return block(
        `Your previous diff applied, but the project **failed to build or its tests failed** in the sandbox:`,
        'Fix the regression while keeping the security fix intact. Use `read_file` / `grep_code` on the symbols the error names, then emit an updated full unified diff.',
      );

    case 'rescan':
      return block(
        `Your previous diff applied and built, but the security scanner **still flags the vulnerability** -- the fix did not remove the insecure pattern:`,
        'The vulnerable code path is still reachable. Re-examine what the scanner reports and emit an updated full unified diff that actually eliminates the pattern (not just renames or comments it out).',
      );

    // The headline remediation case: an adversarial reviewer defeated the fix.
    // Its evidence cites concrete still-vulnerable locations -- frequently a
    // DUPLICATE implementation of the same flaw the first diff missed. Push the
    // agent to patch every cited instance, in the SAME conversation.
    case 'adversarial_validation':
      return block(
        `An adversarial security reviewer **defeated your fix**. Its evidence:`,
        'Treat this as authoritative. Patch **every** location it cites -- and before finalizing, `grep_code` the repository for OTHER copies of the same insecure pattern (duplicated helpers, copy-pasted crypto, the same hardcoded constant) and fix those too. A partial fix that leaves any reachable copy vulnerable will be rejected again. Emit an updated full unified diff covering all of them.',
      );

    default:
      return block(
        `Attempt #${prev} failed at the **${failure.stage}** stage. Output (tail):`,
        'Adjust your approach -- read different files, fetch more lines, or change the patch -- and emit a new diff.',
      );
  }
}

// ---------------------------------------------------------------------------
// Legacy static prompt assembly. Used by the non-validated FixPipeline path
// (legacy fix-queue worker). The validated pipeline uses the agent builders
// above; do not extend this for new functionality.
// ---------------------------------------------------------------------------

const LEGACY_VULN_FILE_BYTES = 60_000;
const LEGACY_RELEVANT_TOTAL_BYTES = 60_000;
const LEGACY_SNIPPET_BYTES = 10_000;

function legacyTrimVulnFile(content: string, packageName: string | undefined): string {
  if (content.length <= LEGACY_VULN_FILE_BYTES) return content;
  if (packageName) {
    const idx = content.indexOf(packageName);
    if (idx >= 0) {
      const half = Math.floor(LEGACY_VULN_FILE_BYTES / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(content.length, idx + half);
      const prefix = start > 0 ? '... [truncated above]\n' : '';
      const suffix = end < content.length ? '\n... [truncated below]' : '';
      return prefix + content.slice(start, end) + suffix;
    }
  }
  return content.slice(0, LEGACY_VULN_FILE_BYTES) + '\n\n... [truncated for length]';
}

function legacyTrimSnippets(snippets: string[]): string[] {
  let budget = LEGACY_RELEVANT_TOTAL_BYTES;
  const out: string[] = [];
  for (const raw of snippets) {
    if (budget <= 0) break;
    const cap = Math.min(LEGACY_SNIPPET_BYTES, budget);
    const trimmed =
      raw.length > cap ? raw.slice(0, cap) + '\n... [truncated]' : raw;
    out.push(trimmed);
    budget -= trimmed.length;
  }
  return out;
}

export function assemblePrompt(ctx: FixContext): string {
  const { finding, vulnerableFileContent, relevantCode, customPrompts } = ctx;
  const lines: string[] = [];

  lines.push(
    'You are a security engineer fixing vulnerabilities in production code. ' +
      'Your task is to generate a minimal, correct patch that resolves the reported vulnerability ' +
      'without breaking existing functionality.',
  );
  lines.push('');

  lines.push('## Vulnerability Details');
  lines.push(`- **Title**: ${finding.title}`);
  lines.push(`- **Severity**: ${finding.severity.toUpperCase()}`);
  lines.push(`- **Description**: ${finding.description}`);
  if (finding.cveId) lines.push(`- **CVE**: ${finding.cveId}`);
  if (finding.cweId) lines.push(`- **CWE**: ${finding.cweId}`);
  if (finding.filePath) lines.push(`- **File**: ${finding.filePath}`);
  if (finding.lineRange) lines.push(`- **Lines**: ${finding.lineRange[0]}-${finding.lineRange[1]}`);
  if (finding.packageName) {
    lines.push(`- **Package**: ${finding.packageName}`);
    if (finding.currentVersion) lines.push(`- **Current Version**: ${finding.currentVersion}`);
    if (finding.fixedVersion) lines.push(`- **Fixed Version**: ${finding.fixedVersion}`);
  }
  lines.push('');

  if (vulnerableFileContent) {
    const trimmed = legacyTrimVulnFile(vulnerableFileContent, finding.packageName);
    lines.push('## Vulnerable File Content');
    lines.push('```');
    lines.push(trimmed);
    lines.push('```');
    lines.push('');
  }

  if (relevantCode.length > 0) {
    lines.push('## Related Code Context');
    for (const snippet of legacyTrimSnippets(relevantCode)) {
      lines.push('```');
      lines.push(snippet);
      lines.push('```');
    }
    lines.push('');
  }

  if (customPrompts.environmentSetup) {
    lines.push('## Environment Setup');
    lines.push(customPrompts.environmentSetup);
    lines.push('');
  }
  if (customPrompts.testingInstructions) {
    lines.push('## Testing Instructions');
    lines.push(customPrompts.testingInstructions);
    lines.push('');
  }
  if (customPrompts.codeConventions) {
    lines.push('## Code Conventions');
    lines.push(customPrompts.codeConventions);
    lines.push('');
  }
  if (customPrompts.dependencyRules) {
    lines.push('## Dependency Rules');
    lines.push(customPrompts.dependencyRules);
    lines.push('');
  }
  if (customPrompts.businessContext) {
    lines.push('## Business Context');
    lines.push(customPrompts.businessContext);
    lines.push('');
  }

  lines.push('## Output Format');
  lines.push(
    'Provide the fix as a unified diff in a ```diff code block. ' +
      'The diff must be directly applicable with `git apply`. ' +
      'Include only the minimal changes necessary to fix the vulnerability. ' +
      'Do not include unrelated refactoring or style changes.',
  );
  lines.push('');
  lines.push('Example format:');
  lines.push('```diff');
  lines.push('--- a/path/to/file.ts');
  lines.push('+++ b/path/to/file.ts');
  lines.push('@@ -10,7 +10,7 @@');
  lines.push('-  vulnerable code');
  lines.push('+  fixed code');
  lines.push('```');

  return lines.join('\n');
}
