import type Anthropic from '@anthropic-ai/sdk';
import { dispatchTool, type ToolContext } from './github-tools';
import { ANALYSIS_TOOLS } from './tools';

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
  initialUserMessage: string;
  toolContext: ToolContext;
  onEvent: (event: AgentEvent) => void;
  /**
   * Map of canonical call signatures (see `callSignature`) to pre-fetched tool
   * output. When the model issues a tool call whose signature is in the cache,
   * the loop replays the cached content as a successful tool_result without
   * dispatching the underlying tool. Used to short-circuit repeat fetches of
   * context already included in the initial user message.
   */
  preFetched?: Map<string, string>;
}

export interface AgentRunResult {
  totalInputTokens: number;
  totalOutputTokens: number;
  iterations: number;
  stopReason: string | null;
  transcriptPrompt: string;
  transcriptResponse: string;
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

/**
 * Canonicalise tool input before computing a dedup signature so that calls
 * that differ only in cosmetic ways (`./src` vs `src`, `"foo"` vs `foo`) are
 * recognised as the same call. Mirrors the normalisation `dispatchTool` does
 * internally.
 */
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

export async function runAnalysisAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: opts.initialUserMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let stopReason: string | null = null;
  let iteration = 0;
  let transcriptResponse = '';
  const recentFailures = new Map<string, string>();
  // Files the read_file tool already rejected as over the byte cap. Keyed by
  // path (post-normalisation) — we treat any subsequent read of the same path
  // as a duplicate failure regardless of slice arguments, because the byte
  // check runs before slicing.
  const tooLargeFiles = new Set<string>();
  const preFetched = opts.preFetched ?? new Map<string, string>();
  // Successful tool results from earlier in this run, keyed by call signature.
  // Repo state is stable within a run, so identical calls are replayed from
  // cache instead of re-dispatched — this protects the tight GitHub
  // code-search budget (~10 req/min) from duplicate grep_code calls.
  const completedCalls = new Map<string, string>();

  while (iteration < MAX_ITERATIONS) {
    opts.onEvent({ type: 'iteration', index: iteration });

    // Force a tools-off final turn when either limit is reached, so the run
    // always ends with the structured sections instead of being cut off
    // mid-investigation (an analysis that is all tool-call narration renders
    // as empty panels in the UI).
    const overBudget = totalInputTokens >= MAX_TOTAL_INPUT_TOKENS;
    const lastIteration = iteration === MAX_ITERATIONS - 1;
    const forceFinal = overBudget || lastIteration;
    if (forceFinal) {
      const reason = overBudget
        ? 'Token budget for this analysis is exhausted.'
        : 'The tool-call iteration limit has been reached.';
      messages.push({
        role: 'user',
        content:
          `${reason} Produce your final response now using ` +
          'the structured sections (### Risk Assessment, ### Root Cause, ### Recommended Fix, ' +
          '### Proposed Diff, ### References), based on the evidence gathered so far. ' +
          'Do not call any more tools.',
      });
    }

    const stream = opts.client.messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      tools: forceFinal ? undefined : ANALYSIS_TOOLS,
      messages,
    });

    try {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          opts.onEvent({ type: 'text', text: event.delta.text });
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Stream error';
      opts.onEvent({ type: 'error', error: message });
      throw e;
    }

    const final = await stream.finalMessage();
    totalInputTokens += final.usage.input_tokens;
    totalOutputTokens += final.usage.output_tokens;
    stopReason = final.stop_reason;
    iteration += 1;

    transcriptResponse += `\n--- iteration ${iteration} ---\n${flattenAssistantText(final.content)}`;

    messages.push({ role: 'assistant', content: final.content });

    if (final.stop_reason !== 'tool_use') {
      break;
    }

    const toolUseBlocks = final.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUseBlocks.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      opts.onEvent({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
      });

      const sig = callSignature(block.name, block.input);

      const preFetchedContent = preFetched.get(sig);
      const replay =
        preFetchedContent !== undefined
          ? { content: preFetchedContent, summary: 'served from pre-fetch' }
          : completedCalls.has(sig)
            ? { content: completedCalls.get(sig)!, summary: 'served from cache' }
            : null;
      if (replay) {
        opts.onEvent({
          type: 'tool_result',
          id: block.id,
          ok: true,
          summary: replay.summary,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: replay.content,
          is_error: false,
        });
        continue;
      }

      const pathKey = readFilePathKey(block.name, block.input);
      if (pathKey && tooLargeFiles.has(pathKey)) {
        const message =
          `read_file: this file was already rejected as over the byte cap and cannot be sliced either. ` +
          'Do not retry it. The relevant manifest content is in the initial user message under `## Repo context`.';
        opts.onEvent({
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
        opts.onEvent({
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

      const result = await dispatchTool(block.name, block.input, opts.toolContext);
      opts.onEvent({
        type: 'tool_result',
        id: block.id,
        ok: result.ok,
        summary: result.summary,
      });
      if (result.ok) {
        recentFailures.delete(sig);
        completedCalls.set(sig, result.content);
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

  if (iteration >= MAX_ITERATIONS && stopReason === 'tool_use') {
    opts.onEvent({
      type: 'text',
      text:
        '\n\n*(Analysis stopped: maximum tool-call iterations reached. The verdict above is based on the evidence gathered so far.)*\n',
    });
  }

  opts.onEvent({ type: 'done', stopReason });

  const transcriptPrompt = JSON.stringify(
    { system: opts.system, initialUserMessage: opts.initialUserMessage },
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
  };
}
