import type Anthropic from '@anthropic-ai/sdk';
import { dispatchSandboxTool, type SandboxToolContext } from './sandbox-tools';
import { FIX_AGENT_TOOLS } from './types';

export const MAX_ITERATIONS = 12;
export const MAX_TOTAL_INPUT_TOKENS = 200_000;

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string }
  | { type: 'iteration'; index: number }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; error: string };

export interface AgentRunOptions {
  client: Anthropic;
  model: string;
  maxTokens: number;
  system: string;
  /**
   * Opening user message for a fresh conversation. Ignored when `priorMessages`
   * is supplied (a continued conversation already contains it).
   */
  initialUserMessage?: string;
  toolContext: SandboxToolContext;
  /**
   * A previous run's full message history. When supplied, the loop continues
   * that conversation (the model keeps every file it already read) instead of
   * starting cold from `initialUserMessage`. Used by the in-attempt remediation
   * loop: a remediable gate failure appends a feedback turn (`extraUserMessages`)
   * and re-runs, rather than throwing the conversation away.
   */
  priorMessages?: Anthropic.MessageParam[];
  /**
   * Extra user-message turns appended before the loop starts. Used to feed
   * retry / remediation feedback without re-sending the static initial message.
   */
  extraUserMessages?: string[];
  /**
   * Per-call cap on tool-use iterations. Defaults to MAX_ITERATIONS. Adversarial
   * callers (bypass agent, verifier) pass a tighter cap from VALIDATION_LIMITS
   * so their iteration budget is actually enforced, not just the token budget.
   */
  maxIterations?: number;
  /**
   * What the model is told to produce when a limit forces the final turn.
   * Callers with a non-diff output format (e.g. the verifier's JSON verdict)
   * override this so the forced response is still parseable.
   */
  finalTurnPrompt?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  totalInputTokens: number;
  totalOutputTokens: number;
  iterations: number;
  stopReason: string | null;
  /** JSON snapshot of the inputs (system, initialUserMessage, extraUserMessages). */
  transcriptPrompt: string;
  /** Concatenated assistant content across iterations -- text + tool-use summaries. */
  transcriptResponse: string;
  /** Final assistant text (no tool-use markers) -- the source for diff extraction. */
  finalText: string;
  /**
   * Full conversation after this run (initial/prior messages + every turn the
   * loop appended). Pass back as `priorMessages` to continue the conversation.
   */
  messages: Anthropic.MessageParam[];
}

function summarizeToolUse(block: Anthropic.ToolUseBlock): string {
  const input = block.input as Record<string, unknown> | null;
  const path = typeof input?.path === 'string' ? input.path : undefined;
  const start = typeof input?.start_line === 'number' ? input.start_line : undefined;
  const end = typeof input?.end_line === 'number' ? input.end_line : undefined;
  const query = typeof input?.query === 'string' ? input.query : undefined;
  if (block.name === 'read_file' && path) {
    if (start && end) return `read_file ${path}:${start}-${end}`;
    if (start) return `read_file ${path}:${start}-`;
    return `read_file ${path}`;
  }
  if (block.name === 'list_directory' && path !== undefined) {
    return `list_directory ${path || '/'}`;
  }
  if (block.name === 'grep_code' && query) {
    return `grep_code "${query}"`;
  }
  return block.name;
}

function flattenAssistantText(content: Anthropic.ContentBlock[]): string {
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `\n[tool_use:${summarizeToolUse(b)}]\n`;
      return '';
    })
    .join('');
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function normalizeDirInput(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '' || s === '.' || s === '/') return '';
  return s.replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

function normalizeFileInput(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.replace(/^\.?\/+/, '');
}

function normalizeQueryInput(raw: unknown): string {
  let s = typeof raw === 'string' ? raw.trim() : '';
  while (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function canonicalToolInput(name: string, input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const obj = input as Record<string, unknown>;
  if (name === 'read_file') {
    return { ...obj, path: normalizeFileInput(obj.path) };
  }
  if (name === 'list_directory') {
    return { ...obj, path: normalizeDirInput(obj.path) };
  }
  if (name === 'grep_code') {
    const out: Record<string, unknown> = { ...obj, query: normalizeQueryInput(obj.query) };
    if (obj.path !== undefined) out.path = normalizeDirInput(obj.path);
    return out;
  }
  return input;
}

export function callSignature(name: string, input: unknown): string {
  return `${name}:${stableStringify(canonicalToolInput(name, input))}`;
}

function readFilePathKey(name: string, input: unknown): string | null {
  if (name !== 'read_file' || !input || typeof input !== 'object') return null;
  const path = normalizeFileInput((input as Record<string, unknown>).path);
  if (!path) return null;
  return `read_file:${path}`;
}

/**
 * Tool-using agent loop for the fix-engine. Mirrors `runAnalysisAgent` from
 * the dashboard but dispatches via sandbox `runner.exec` instead of GitHub's
 * Contents/Search APIs. The model iterates until it stops requesting tools
 * (typically by emitting its final unified diff) or the iteration / token cap
 * is hit.
 */
export async function runFixAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const onEvent = opts.onEvent ?? (() => {});
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;

  const messages: Anthropic.MessageParam[] = opts.priorMessages
    ? [...opts.priorMessages]
    : [{ role: 'user', content: opts.initialUserMessage ?? '' }];
  for (const extra of opts.extraUserMessages ?? []) {
    messages.push({ role: 'user', content: extra });
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let stopReason: string | null = null;
  let iteration = 0;
  let transcriptResponse = '';
  let finalText = '';
  const recentFailures = new Map<string, string>();
  const tooLargeFiles = new Set<string>();

  const finalTurnPrompt =
    opts.finalTurnPrompt ?? 'Emit your final unified diff now in a ```diff code block.';

  while (iteration < maxIterations) {
    onEvent({ type: 'iteration', index: iteration });

    // Force a tools-off final turn when either limit is reached, so the run
    // always ends with parseable final text (a diff or a verdict) instead of
    // being cut off mid-investigation with empty finalText.
    const overBudget = totalInputTokens >= MAX_TOTAL_INPUT_TOKENS;
    const lastIteration = iteration === maxIterations - 1;
    const forceFinal = overBudget || lastIteration;
    if (forceFinal) {
      const reason = overBudget
        ? 'Token budget for this fix is exhausted.'
        : 'The tool-call iteration limit has been reached.';
      messages.push({
        role: 'user',
        content: `${reason} ${finalTurnPrompt} Base it on the evidence gathered so far. Do not call any more tools.`,
      });
    }

    const response = await opts.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      tools: forceFinal ? undefined : FIX_AGENT_TOOLS,
      messages,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    stopReason = response.stop_reason;
    iteration += 1;

    transcriptResponse += `\n--- iteration ${iteration} ---\n${flattenAssistantText(response.content)}`;
    finalText = extractText(response.content);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      break;
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUseBlocks.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      onEvent({ type: 'tool_call', id: block.id, name: block.name, input: block.input });

      const sig = callSignature(block.name, block.input);

      const pathKey = readFilePathKey(block.name, block.input);
      if (pathKey && tooLargeFiles.has(pathKey)) {
        const message =
          'read_file: this file was already rejected as over the byte cap and cannot be sliced either. ' +
          'Try a different file or a different tool.';
        onEvent({
          type: 'tool_result',
          id: block.id,
          ok: false,
          summary: 'duplicate too-large read suppressed',
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: message,
          is_error: true,
        });
        continue;
      }

      const priorFailure = recentFailures.get(sig);
      if (priorFailure) {
        const message =
          `You already tried this exact call and it failed: "${priorFailure}". ` +
          'Try a different approach (different path, narrower line range, different query, or a different tool).';
        onEvent({
          type: 'tool_result',
          id: block.id,
          ok: false,
          summary: 'duplicate call suppressed',
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: message,
          is_error: true,
        });
        continue;
      }

      const result = await dispatchSandboxTool(block.name, block.input, opts.toolContext);
      onEvent({
        type: 'tool_result',
        id: block.id,
        ok: result.ok,
        summary: result.summary,
      });
      if (result.ok) {
        recentFailures.delete(sig);
      } else {
        recentFailures.set(sig, result.summary);
        if (result.failureClass === 'too_large' && pathKey) {
          tooLargeFiles.add(pathKey);
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: !result.ok,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (iteration >= maxIterations && stopReason === 'tool_use') {
    transcriptResponse +=
      '\n\n*(Fix agent stopped: maximum tool-call iterations reached. The diff above -- if any -- is the agent\'s best effort with the evidence gathered so far.)*\n';
  }

  onEvent({ type: 'done', stopReason });

  const transcriptPrompt = JSON.stringify(
    {
      system: opts.system,
      initialUserMessage: opts.initialUserMessage ?? null,
      continued: Boolean(opts.priorMessages),
      extraUserMessages: opts.extraUserMessages ?? [],
    },
    null,
    2,
  );

  return {
    totalInputTokens,
    totalOutputTokens,
    iterations: iteration,
    stopReason,
    transcriptPrompt,
    transcriptResponse,
    finalText,
    messages,
  };
}
