import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLAUDE_MODEL } from '@sutura/common';
import type { NormalizedFinding } from '@sutura/common';

const MAX_DIFF_BYTES = 14_000;
const MAX_TEST_BYTES = 12_000;
const MAX_TOKENS = 1800;

export interface PrNarrativeEvidence {
  /** Scanner that confirmed the finding is gone (e.g. 'semgrep'). */
  scanTool?: string;
  /** Whether the sandbox build + generated tests ran, or were skipped (scoped lib with no test project). */
  testsOutcome?: 'passed' | 'skipped';
  /** True when the adversarial bypass agent inspected the patched tree and found no bypass. */
  bypassChecked?: boolean;
  /** Number of generate->validate rounds it took. */
  rounds?: number;
}

export interface PrNarrativeInput {
  finding: NormalizedFinding;
  diff: string;
  testFiles: { path: string; content: string }[];
  evidence?: PrNarrativeEvidence;
  anthropicApiKey: string;
  model?: string;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n... [truncated for length]` : s;
}

function buildSystem(): string {
  return [
    'You are a senior security engineer writing the description for a pull request that fixes a',
    'vulnerability. The patch ALREADY passed a sandboxed build + generated tests and a re-scan that',
    'confirmed the finding is gone -- you are explaining the change to a human reviewer, not deciding',
    'whether it is correct.',
    '',
    'Write GitHub-flavored Markdown with EXACTLY these sections (use the headings verbatim):',
    '',
    '### Summary',
    'Two or three sentences: what was wrong and what this PR does about it.',
    '',
    '### Root cause',
    'Explain the actual weakness in the code (the specific APIs / construction / constants involved) and',
    'why it is exploitable or non-compliant. Reference concrete identifiers from the diff.',
    '',
    '### Fix approach',
    'Explain WHAT you changed and -- importantly -- WHY this approach: the algorithm/mode/parameters',
    'chosen, how secrets/IVs/keys are handled now, and any alternative you deliberately did not take.',
    '',
    '### Files changed',
    'A bullet per file: what changed in it and why. If the SAME flawed pattern existed in more than one',
    'file (a duplicated/copy-pasted implementation), call that out explicitly -- reviewers must know the',
    'fix covers every reachable instance, not just the reported file.',
    '',
    '### Tests added',
    'A bullet per generated test file describing what it actually verifies and why that matters for this',
    'vulnerability (e.g. round-trip correctness, that the weak primitive is gone, that ciphertext is',
    'non-deterministic). If no tests were provided, write "No automated tests were generated for this fix."',
    '',
    '### Caveats & notes',
    'Anything a reviewer must weigh before merging: backward-compatibility / data-migration concerns',
    '(e.g. data encrypted with the OLD scheme will no longer decrypt), residual risks the patch does NOT',
    'address (e.g. a hardcoded secret that is a separate finding), behavioral changes, or follow-ups.',
    'Be honest; if there is a real migration risk, say so plainly. If there are genuinely none, say so.',
    '',
    'Rules: be specific and technical, ground every claim in the diff/tests you were given, and do NOT',
    'invent validation steps, tools, or results that were not provided. Do not restate this instruction.',
    'Output only the Markdown body, starting at "### Summary".',
  ].join('\n');
}

function buildUser(input: PrNarrativeInput): string {
  const f = input.finding;
  const lines: string[] = [];
  lines.push('## Finding');
  lines.push(`- Title: ${f.title}`);
  lines.push(`- Severity: ${f.severity.toUpperCase()}`);
  if (f.cweId) lines.push(`- CWE: ${f.cweId}`);
  if (f.cveId) lines.push(`- CVE: ${f.cveId}`);
  if (f.filePath) lines.push(`- Reported file: ${f.filePath}`);
  if (f.description) lines.push(`- Description: ${f.description}`);

  const ev = input.evidence;
  if (ev) {
    lines.push('', '## Validation already performed (context -- do not restate as your own claims)');
    if (ev.scanTool) lines.push(`- Re-scanned with ${ev.scanTool}: finding no longer present.`);
    if (ev.testsOutcome === 'passed') lines.push('- Sandbox build + generated tests passed.');
    if (ev.testsOutcome === 'skipped')
      lines.push('- Sandbox build passed; generated tests could not execute (scoped library has no test project).');
    if (ev.bypassChecked) lines.push('- An adversarial bypass agent inspected the patched code and found no bypass.');
    if (typeof ev.rounds === 'number') lines.push(`- Reached in ${ev.rounds} generate->validate round(s).`);
  }

  lines.push('', '## The applied diff', '```diff', clamp(input.diff, MAX_DIFF_BYTES), '```');

  if (input.testFiles.length > 0) {
    lines.push('', '## Generated test files');
    let budget = MAX_TEST_BYTES;
    for (const t of input.testFiles) {
      if (budget <= 0) break;
      const body = clamp(t.content, Math.min(budget, 6_000));
      budget -= body.length;
      lines.push(`\n### ${t.path}`, '```', body, '```');
    }
  } else {
    lines.push('', '## Generated test files', '(none)');
  }

  lines.push('', 'Write the PR description now.');
  return lines.join('\n');
}

/**
 * Produce a rich, reviewer-facing PR body for a validated fix: root cause, the
 * reasoning behind the approach, per-file and per-test rationale, and the
 * caveats a human must weigh. Grounded entirely in the supplied diff/tests so it
 * does not invent validation it wasn't given.
 *
 * Best-effort: returns null on any failure (empty output, API error, missing
 * key) so the submitter falls back to the static template -- a thin PR is better
 * than a failed PR.
 */
export async function generatePrNarrative(input: PrNarrativeInput): Promise<string | null> {
  if (!input.anthropicApiKey) return null;
  try {
    const client = new Anthropic({ apiKey: input.anthropicApiKey });
    const res = await client.messages.create({
      model: input.model ?? DEFAULT_CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystem(),
      messages: [{ role: 'user', content: buildUser(input) }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    console.warn('[validated-fix] PR narrative generation failed; using static body:', err);
    return null;
  }
}
