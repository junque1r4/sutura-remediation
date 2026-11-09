import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolResult } from '../github-tools';

const dispatchToolMock = vi.fn<(...args: unknown[]) => Promise<ToolResult>>();

vi.mock('../github-tools', () => ({
  dispatchTool: (...args: unknown[]) => dispatchToolMock(...args),
}));

import { runAnalysisAgent, MAX_ITERATIONS, type AgentEvent } from '../loop';

interface FakeMessage {
  content: unknown[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

function toolUseMessage(id: string, name: string, input: unknown): FakeMessage {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function endMessage(text: string): FakeMessage {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/**
 * Fake Anthropic client like the one in loop-replay.test.ts, but it also
 * captures the `tools` param so tests can assert when tools are withheld.
 */
function makeClient(script: FakeMessage[]) {
  const streamCalls: { messages: Anthropic.MessageParam[]; tools: unknown }[] = [];
  let index = 0;
  const client = {
    messages: {
      stream: (params: { messages: Anthropic.MessageParam[]; tools?: unknown }) => {
        streamCalls.push({ messages: [...params.messages], tools: params.tools });
        const message = script[index];
        index += 1;
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: async () => message,
        };
      },
    },
  } as unknown as Anthropic;
  return { client, streamCalls };
}

function runOptions(client: Anthropic, events: AgentEvent[]) {
  return {
    client,
    model: 'test-model',
    maxTokens: 1024,
    system: 'system prompt',
    initialUserMessage: 'analyze this',
    toolContext: { installationId: 1, owner: 'acme', repo: 'app' },
    onEvent: (e: AgentEvent) => events.push(e),
  };
}

beforeEach(() => {
  dispatchToolMock.mockReset();
  dispatchToolMock.mockImplementation(async (_name, input) => ({
    ok: true,
    content: `result for ${JSON.stringify(input)}`,
    summary: 'ok',
  }));
});

describe('runAnalysisAgent iteration-cap final turn', () => {
  it('withholds tools and forces a structured final response on the last iteration', async () => {
    // A model that would keep calling tools forever. Distinct inputs so neither
    // the replay cache nor failure dedup short-circuits any call. The last
    // scripted message is the forced final text.
    const script: FakeMessage[] = [];
    for (let i = 0; i < MAX_ITERATIONS - 1; i++) {
      script.push(toolUseMessage(`t${i}`, 'read_file', { path: `src/file-${i}.ts` }));
    }
    script.push(endMessage('### Risk Assessment\nverdict from gathered evidence'));

    const { client, streamCalls } = makeClient(script);
    const events: AgentEvent[] = [];
    await runAnalysisAgent(runOptions(client, events));

    expect(streamCalls).toHaveLength(MAX_ITERATIONS);

    // Every iteration before the last offers tools; the last withholds them.
    for (let i = 0; i < MAX_ITERATIONS - 1; i++) {
      expect(streamCalls[i].tools, `iteration ${i} should offer tools`).toBeDefined();
    }
    const finalCall = streamCalls[MAX_ITERATIONS - 1];
    expect(finalCall.tools).toBeUndefined();

    // The forcing instruction is appended as the latest user message.
    const lastMessage = finalCall.messages[finalCall.messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(JSON.stringify(lastMessage.content)).toContain('final response');

    // The run ends with the model's structured text, not the tool_use cutoff note.
    const flattened = events
      .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.text)
      .join('');
    expect(flattened).not.toContain('maximum tool-call iterations reached');

    const done = events.find((e) => e.type === 'done') as Extract<
      AgentEvent,
      { type: 'done' }
    >;
    expect(done.stopReason).toBe('end_turn');
  });

  it('does not force the final turn when the model finishes early', async () => {
    const { client, streamCalls } = makeClient([
      toolUseMessage('t1', 'read_file', { path: 'src/a.ts' }),
      endMessage('### Risk Assessment\ndone early'),
    ]);
    const events: AgentEvent[] = [];
    await runAnalysisAgent(runOptions(client, events));

    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[1].tools).toBeDefined();
  });
});
