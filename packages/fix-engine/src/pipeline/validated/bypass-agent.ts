import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLAUDE_MODEL, VALIDATION_LIMITS } from '@sutura/common';
import type { NormalizedFinding } from '@sutura/common';
import type { SandboxRunner, WorkspaceHandle } from '@sutura/sandbox-runner';
import { runFixAgent } from '../../agent';
import type { BypassResult } from './types';

const MODEL = DEFAULT_CLAUDE_MODEL;

export interface BypassAgentInput {
  /**
   * The EXISTING post-patch workspace already in orchestrator scope. The bypass
   * agent inspects the patched code in place -- it does NOT create a new
   * workspace.
   */
  workspace: WorkspaceHandle;
  finding: NormalizedFinding;
  /** The candidate fix that has just passed the rescan. */
  generated: { diff: string };
  runner: SandboxRunner;
  /** Pre-built Anthropic client. Either this or anthropicApiKey must be provided. */
  client?: Anthropic;
  anthropicApiKey?: string;
  /** Model id; defaults to the validated-fix sonnet model. */
  model?: string;
}

/**
 * Adversarial bypass agent. Given a fix that already passed the rescan, this
 * agent acts as a red-teamer trying to PROVE the fix is illusory: that the
 * vulnerability can still be triggered, that the patch merely masks the symptom
 * a scanner keys on, or that the accompanying tests were weakened so they no
 * longer exercise the vulnerable path. It uses the same read_file / grep_code /
 * list_directory tools the fix agent uses, on the existing post-patch workspace.
 *
 * Conservative by construction: it reports `bypassed: true` ONLY when it emits a
 * verdict with concrete evidence. On no verdict, an unparseable verdict, or any
 * error it returns `bypassed: false` so a healthy fix is never blocked by a
 * flaky adversary.
 */
export async function runBypassAgent(input: BypassAgentInput): Promise<BypassResult> {
  const clean: BypassResult = {
    bypassed: false,
    evidence: 'Bypass agent found no concrete way to defeat the fix.',
  };

  const client =
    input.client ??
    (input.anthropicApiKey ? new Anthropic({ apiKey: input.anthropicApiKey }) : undefined);
  if (!client) return clean;

  try {
    const result = await runFixAgent({
      client,
      model: input.model ?? MODEL,
      maxTokens: VALIDATION_LIMITS.BYPASS_MAX_TOKENS,
      maxIterations: VALIDATION_LIMITS.BYPASS_MAX_ITERATIONS,
      system: buildSystemPrompt(),
      initialUserMessage: buildInitialUserMessage(input.finding, input.generated.diff),
      toolContext: { runner: input.runner, workspace: input.workspace },
    });

    const parsed = parseBypassVerdict(result.finalText);
    if (!parsed) return clean;
    return {
      ...parsed,
      tokensUsed: result.totalInputTokens + result.totalOutputTokens,
      iterations: result.iterations,
    };
  } catch {
    return clean;
  }
}

/**
 * Extract the structured bypass verdict from the agent's final text. Looks for a
 * ```json fenced block first, then the last balanced `{...}` object. Returns
 * null when nothing parseable / valid is present so the caller stays
 * conservative (bypassed: false).
 */
export function parseBypassVerdict(finalText: string): BypassResult | null {
  const raw = extractJsonObject(finalText);
  if (!raw) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.bypassed !== 'boolean') return null;

  const evidence =
    typeof obj.evidence === 'string' && obj.evidence.trim().length > 0
      ? obj.evidence.trim().slice(0, 4_000)
      : 'No evidence provided.';

  // Conservative: a `true` verdict with no concrete evidence is treated as no
  // bypass -- we require the adversary to show its work.
  if (obj.bypassed === true && evidence === 'No evidence provided.') {
    return { bypassed: false, evidence };
  }

  return { bypassed: obj.bypassed, evidence };
}

function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const fenced = text.match(/```json\s*\n([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const lastClose = text.lastIndexOf('}');
  if (lastClose === -1) return null;
  let depth = 0;
  for (let i = lastClose; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, lastClose + 1);
    }
  }
  return null;
}

function buildSystemPrompt(): string {
  return [
    'You are a red-team application-security engineer auditing a SECURITY FIX that has already',
    'passed an automated rescan. Do NOT trust that the rescan is correct. Your job is to find',
    'concrete evidence that the fix is illusory -- that it does not actually remediate the reported',
    'vulnerability. Specifically look for:',
    '- The vulnerable code path still being reachable / triggerable despite the patch.',
    '- The patch only masking the symptom a scanner keys on (e.g. renaming a variable, adding a',
    '  comment, suppressing a rule, narrowing input in a way an attacker controls) without removing',
    '  the underlying flaw.',
    '- Accompanying tests that were weakened, skipped, or written so they never exercise the',
    '  vulnerable path -- giving false confidence.',
    '',
    'Use read_file, grep_code, and list_directory to inspect the PATCHED code in this workspace.',
    'Be conservative and honest: only claim a bypass when you can point to specific code. If the fix',
    'genuinely removes the vulnerability and the tests cover it, say so.',
    '',
    'When done, stop calling tools and output EXACTLY ONE JSON verdict in a ```json fenced code block,',
    'with this shape and nothing else after it:',
    '```json',
    '{',
    '  "bypassed": false,',
    '  "evidence": "specific code citations supporting your conclusion"',
    '}',
    '```',
    'Field rules:',
    '- bypassed: true ONLY when you have concrete evidence the fix can be defeated, masks the flaw,',
    '  or its tests are weakened. When in doubt, false.',
    '- evidence: cite the file(s) and reasoning. Required when bypassed is true.',
  ].join('\n');
}

function buildInitialUserMessage(finding: NormalizedFinding, diff: string): string {
  return [
    '# Bypass audit task',
    '',
    `Scanner: ${finding.scanner}`,
    `Vulnerability: ${finding.title}`,
    finding.description ? `Description: ${finding.description}` : '',
    `Reported severity: ${finding.severity}`,
    finding.cveId ? `CVE: ${finding.cveId}` : '',
    finding.cweId ? `CWE: ${finding.cweId}` : '',
    finding.filePath ? `File: ${finding.filePath}` : '',
    finding.lineRange ? `Lines: ${finding.lineRange[0]}-${finding.lineRange[1]}` : '',
    '',
    'The candidate fix already applied to this workspace is the unified diff below:',
    '```diff',
    diff.slice(0, 12_000),
    '```',
    '',
    'Inspect the patched repository and decide whether this fix can be bypassed or is otherwise',
    'illusory. Then emit your single JSON verdict as instructed.',
  ]
    .filter(Boolean)
    .join('\n');
}
