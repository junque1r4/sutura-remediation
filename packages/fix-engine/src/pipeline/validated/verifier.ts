import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLAUDE_MODEL } from '@sutura/common';
import type { NormalizedFinding, Severity, VerificationVerdict } from '@sutura/common';
import type { SandboxRunner, WorkspaceHandle } from '@sutura/sandbox-runner';
import { runFixAgent } from '../../agent';

const MODEL = DEFAULT_CLAUDE_MODEL;
const MAX_TOKENS = 4096;
// Verification is a bounded read-only investigation; cap the tool-use loop so a
// rambling agent can't burn the whole budget before emitting a verdict.
const MAX_ITERATIONS = 8;

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const CONFIDENCES: VerificationVerdict['confidence'][] = ['high', 'medium', 'low'];

export interface VerificationInput {
  /** Pre-built Anthropic client. Either this or anthropicApiKey must be provided. */
  client?: Anthropic;
  /** API key used to construct a client when `client` is not supplied. */
  anthropicApiKey?: string;
  /** Model id; defaults to the validated-fix sonnet model. */
  model?: string;
  finding: NormalizedFinding;
  workspace: WorkspaceHandle;
  runner: SandboxRunner;
}

/**
 * Pre-fix exploitability / verification agent. Reads the vulnerable code in the
 * sandbox workspace (via the same read_file / grep_code / list_directory tools
 * the fix agent uses) and decides whether the finding is a real, reachable
 * vulnerability worth spending a fix attempt on.
 *
 * The agent is asked to end its run by emitting a single structured JSON verdict
 * in a ```json code block. We parse that from the final assistant text. On
 * timeout, parse failure, or any error we fall back conservatively to a verdict
 * that lets the pipeline proceed (isReal: true, reachable: true, severity =
 * finding.severity, confidence: 'low') so a real vulnerability is never silently
 * skipped.
 */
export async function runVerificationAgent(
  input: VerificationInput,
): Promise<VerificationVerdict> {
  const verifiedAt = new Date().toISOString();
  const findingLabel = `${input.finding.externalId} "${input.finding.title}"`;

  const client =
    input.client ??
    (input.anthropicApiKey ? new Anthropic({ apiKey: input.anthropicApiKey }) : undefined);
  if (!client) {
    console.error(
      `[verifier] no Anthropic client/api key configured; using conservative fallback for finding ${findingLabel}`,
    );
    return conservativeFallback(input.finding, verifiedAt, 'no Anthropic client/api key configured');
  }

  try {
    const result = await runFixAgent({
      client,
      model: input.model ?? MODEL,
      maxTokens: MAX_TOKENS,
      maxIterations: MAX_ITERATIONS,
      system: buildSystemPrompt(),
      initialUserMessage: buildInitialUserMessage(input.finding),
      toolContext: { runner: input.runner, workspace: input.workspace },
      finalTurnPrompt:
        'Emit your single JSON verdict now in a ```json fenced code block, exactly in the shape ' +
        'you were instructed to use.',
    });

    const parsed = parseVerdict(result.finalText, input.finding, verifiedAt);
    if (!parsed) {
      console.error(
        `[verifier] could not parse a verdict for finding ${findingLabel} ` +
          `(iterations=${result.iterations}, stopReason=${result.stopReason ?? 'unknown'}); ` +
          `final text snippet: ${snippet(result.finalText)}`,
      );
      return conservativeFallback(
        input.finding,
        verifiedAt,
        'final text had no parseable JSON verdict',
      );
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[verifier] verification agent failed for finding ${findingLabel}:`,
      err instanceof Error ? (err.stack ?? message) : message,
    );
    return conservativeFallback(input.finding, verifiedAt, `agent error: ${message}`);
  }
}

/** First ~500 chars of the agent's final text, flattened for single-line logging. */
function snippet(text: string): string {
  if (!text) return '<empty>';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}...` : flat;
}

export function conservativeFallback(
  finding: NormalizedFinding,
  verifiedAt: string,
  cause?: string,
): VerificationVerdict {
  const base =
    'Verification agent did not return a usable verdict; proceeding conservatively so a ' +
    'potentially real vulnerability is not skipped.';
  return {
    isReal: true,
    reachable: true,
    exploitability: finding.severity,
    confidence: 'low',
    reasoning: cause ? `${base} (cause: ${cause})` : base,
    verifiedAt,
  };
}

/**
 * Extract a structured verdict from the agent's final text. Looks for a ```json
 * fenced block first, then falls back to the last balanced `{...}` object in the
 * text. Returns null when nothing parseable / valid is present so the caller can
 * apply the conservative fallback.
 */
export function parseVerdict(
  finalText: string,
  finding: NormalizedFinding,
  verifiedAt: string,
): VerificationVerdict | null {
  const raw = extractJsonObject(finalText);
  if (!raw) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  // isReal / reachable must be explicit booleans; bail to fallback otherwise.
  if (typeof obj.isReal !== 'boolean' || typeof obj.reachable !== 'boolean') {
    return null;
  }

  const exploitability = SEVERITIES.includes(obj.exploitability as Severity)
    ? (obj.exploitability as Severity)
    : finding.severity;
  const confidence = CONFIDENCES.includes(
    obj.confidence as VerificationVerdict['confidence'],
  )
    ? (obj.confidence as VerificationVerdict['confidence'])
    : 'low';
  const reasoning =
    typeof obj.reasoning === 'string' && obj.reasoning.trim().length > 0
      ? obj.reasoning.trim().slice(0, 4_000)
      : 'No reasoning provided.';

  return {
    isReal: obj.isReal,
    reachable: obj.reachable,
    exploitability,
    confidence,
    reasoning,
    verifiedAt,
  };
}

function extractJsonObject(text: string): string | null {
  if (!text) return null;
  // Prefer an explicit ```json fenced block.
  const fenced = text.match(/```json\s*\n([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // Fallback: last balanced top-level object in the text.
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
    'You are a senior application-security engineer triaging a scanner finding BEFORE any fix is attempted.',
    'Your job is to determine whether the reported vulnerability is genuine and exploitable in this codebase,',
    'not to fix it. Use the read_file, grep_code, and list_directory tools to inspect the actual code:',
    'trace the vulnerable symbol/line, check whether it is reachable from an entry point or attacker-controlled',
    'input, and look for existing mitigations (sanitization, auth checks, validation, dead code, test-only usage).',
    '',
    'Be skeptical of false positives, but err on the side of treating a finding as real when the evidence is',
    'ambiguous -- a missed real vulnerability is far worse than an extra fix attempt.',
    '',
    'When you have gathered enough evidence, stop calling tools and output EXACTLY ONE JSON verdict in a',
    '```json fenced code block, with this shape and nothing else after it:',
    '```json',
    '{',
    '  "isReal": true,',
    '  "reachable": true,',
    '  "exploitability": "high",',
    '  "confidence": "medium",',
    '  "reasoning": "one or two sentences citing the code you inspected"',
    '}',
    '```',
    'Field rules:',
    '- isReal: false only when you are confident this is a false positive.',
    '- reachable: whether the vulnerable code can actually be triggered by an attacker.',
    '- exploitability: one of "critical" | "high" | "medium" | "low" (your re-assessed severity).',
    '- confidence: "high" | "medium" | "low" -- how sure you are of isReal/reachable.',
  ].join('\n');
}

function buildInitialUserMessage(finding: NormalizedFinding): string {
  return [
    '# Verification task',
    '',
    `Scanner: ${finding.scanner}`,
    `Vulnerability: ${finding.title}`,
    finding.description ? `Description: ${finding.description}` : '',
    `Reported severity: ${finding.severity}`,
    finding.cveId ? `CVE: ${finding.cveId}` : '',
    finding.cweId ? `CWE: ${finding.cweId}` : '',
    finding.filePath ? `File: ${finding.filePath}` : '',
    finding.lineRange ? `Lines: ${finding.lineRange[0]}-${finding.lineRange[1]}` : '',
    finding.packageName ? `Package: ${finding.packageName}@${finding.currentVersion ?? '?'}` : '',
    '',
    'Inspect the repository to decide whether this is a real, reachable, exploitable vulnerability.',
    'Then emit your single JSON verdict as instructed.',
  ]
    .filter(Boolean)
    .join('\n');
}
