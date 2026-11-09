import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLAUDE_MODEL } from '@sutura/common';
import type { NormalizedFinding } from '@sutura/common';
import type { SandboxRunner, WorkspaceHandle } from '@sutura/sandbox-runner';
import { runFixAgent, type AgentEvent } from '../agent';
import { buildInitialUserMessage, buildRetryFeedback, buildSystemPrompt } from './prompt';

export type FixConversation = Anthropic.MessageParam[];

const MODEL = DEFAULT_CLAUDE_MODEL;
const MAX_RETRIES = 2;
const MAX_TOKENS = 4096;

export interface GenerateResult {
  diff: string;
  model: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  /** JSON snapshot of the agent inputs (system + initial message + retry feedback). */
  promptSnapshot: string;
  /** Concatenated agent transcript across iterations. */
  responseText: string;
  /** Iterations used. Always 1 for the legacy static path. */
  iterations?: number;
  /**
   * Full conversation after this turn. Pass back as `priorMessages` to continue
   * the same conversation in the next remediation round (the model keeps every
   * file it already read). Empty for the legacy static path.
   */
  messages: FixConversation;
}

export interface GenerateFixOptions {
  finding: NormalizedFinding;
  priorAnalysis?: string;
  retryFeedback?: { attemptNumber: number; stage: string; output: string };
  /**
   * A previous turn's conversation (`GenerateResult.messages`). When supplied,
   * this turn CONTINUES that conversation -- the feedback in `retryFeedback` is
   * appended as the next user turn and the model extends its fix in place,
   * instead of starting cold from the finding metadata. Used by the in-attempt
   * remediation loop.
   */
  priorMessages?: FixConversation;
  runner: SandboxRunner;
  workspace: WorkspaceHandle;
  anthropicApiKey: string;
  onEvent?: (event: AgentEvent) => void;
}

export function extractDiff(text: string): string | null {
  // Look for ```diff ... ``` block
  const diffBlockMatch = text.match(/```diff\n([\s\S]*?)```/);
  if (diffBlockMatch) {
    return diffBlockMatch[1].trim();
  }

  // Fallback: look for unified diff markers (--- a/ ... +++ b/)
  const unifiedDiffMatch = text.match(/(---\s+a\/[\s\S]*?(?=\n(?![-+@ ])|\n*$))/m);
  if (unifiedDiffMatch) {
    return unifiedDiffMatch[1].trim();
  }

  // Fallback: any block starting with --- and +++
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => l.startsWith('---'));
  if (startIdx !== -1) {
    return lines.slice(startIdx).join('\n').trim();
  }

  return null;
}

/**
 * Legacy static-prompt path. One-shot Claude call with the prompt verbatim.
 * Still used by the non-validated `FixPipeline` (legacy fix-queue worker).
 * The validated-fix orchestrator uses `generateFixAgentic` instead.
 */
export async function generateFix(prompt: string, apiKey: string): Promise<GenerateResult> {
  const client = new Anthropic({ apiKey });

  let lastResponse = '';
  let tokensUsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

    if (attempt > 0) {
      messages.push({ role: 'assistant', content: lastResponse });
      messages.push({
        role: 'user',
        content:
          'Your previous response did not contain a valid unified diff in a ```diff code block. ' +
          'Please provide the fix again, ensuring you wrap the unified diff in a ```diff code block.',
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    tokensUsed = inputTokens + outputTokens;
    lastResponse = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const diff = extractDiff(lastResponse);
    if (diff) {
      return {
        diff,
        model: MODEL,
        tokensUsed,
        inputTokens,
        outputTokens,
        promptSnapshot: prompt,
        responseText: lastResponse,
        messages: [],
      };
    }
  }

  return {
    diff: '',
    model: MODEL,
    tokensUsed,
    inputTokens,
    outputTokens,
    promptSnapshot: prompt,
    responseText: lastResponse,
    messages: [],
  };
}

/**
 * Agent-based fix generator used by the validated-fix pipeline. Spawns a
 * tool-using agent loop against the sandbox workspace -- the model fetches
 * only the file slices it needs via `read_file` / `list_directory` /
 * `grep_code`, instead of receiving a giant static prompt with whole files.
 */
export async function generateFixAgentic(opts: GenerateFixOptions): Promise<GenerateResult> {
  const client = new Anthropic({ apiKey: opts.anthropicApiKey });
  const system = buildSystemPrompt();
  const feedbackMessages = opts.retryFeedback
    ? [
        buildRetryFeedback(opts.retryFeedback.attemptNumber, {
          stage: opts.retryFeedback.stage,
          output: opts.retryFeedback.output,
        }),
      ]
    : [];

  // Continuation mode: a remediable gate failed and we are re-engaging the SAME
  // conversation. Seed from the prior messages and append only the feedback turn
  // -- the model still has every file it read, so the follow-up is cheap and
  // targeted. Cold mode: start from the finding metadata as before.
  const result = await runFixAgent({
    client,
    model: MODEL,
    maxTokens: MAX_TOKENS,
    system,
    ...(opts.priorMessages && opts.priorMessages.length > 0
      ? { priorMessages: opts.priorMessages }
      : { initialUserMessage: buildInitialUserMessage(opts.finding, opts.priorAnalysis) }),
    extraUserMessages: feedbackMessages,
    toolContext: { runner: opts.runner, workspace: opts.workspace },
    onEvent: opts.onEvent,
  });

  const diff = extractDiff(result.finalText) ?? '';

  return {
    diff,
    model: MODEL,
    tokensUsed: result.totalInputTokens + result.totalOutputTokens,
    inputTokens: result.totalInputTokens,
    outputTokens: result.totalOutputTokens,
    promptSnapshot: result.transcriptPrompt,
    responseText: result.transcriptResponse,
    iterations: result.iterations,
    messages: result.messages,
  };
}
