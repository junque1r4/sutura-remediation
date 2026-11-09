import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolResult } from '../sandbox-tools';

const dispatchSandboxToolMock = vi.fn<(...args: unknown[]) => Promise<ToolResult>>();

vi.mock('../sandbox-tools', () => ({
  dispatchSandboxTool: (...args: unknown[]) => dispatchSandboxToolMock(...args),
}));

import { runFixAgent } from '../loop';

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

/** Fake Anthropic client for the non-streaming `messages.create` loop. */
function makeClient(script: FakeMessage[]) {
  const createCalls: { messages: Anthropic.MessageParam[]; tools: unknown }[] = [];
  let index = 0;
  const client = {
    messages: {
      create: async (params: { messages: Anthropic.MessageParam[]; tools?: unknown }) => {
        createCalls.push({ messages: [...params.messages], tools: params.tools });
        const message = script[index];
        index += 1;
        return message;
      },
    },
  } as unknown as Anthropic;
  return { client, createCalls };
}

function runOptions(client: Anthropic, maxIterations: number) {
  return {
    client,
    model: 'test-model',
    maxTokens: 1024,
    system: 'system prompt',
    initialUserMessage: 'fix this',
    toolContext: {} as never,
    maxIterations,
  };
}

beforeEach(() => {
  dispatchSandboxToolMock.mockReset();
  dispatchSandboxToolMock.mockImplementation(async (_name, input) => ({
    ok: true,
    content: `result for ${JSON.stringify(input)}`,
    summary: 'ok',
  }));
});

describe('runFixAgent iteration-cap final turn', () => {
  it('withholds tools and forces a final response on the last iteration', async () => {
    const CAP = 4;
    const script: FakeMessage[] = [];
    for (let i = 0; i < CAP - 1; i++) {
      script.push(toolUseMessage(`t${i}`, 'read_file', { path: `src/f${i}.ts` }));
    }
    script.push(endMessage('final diff or verdict'));

    const { client, createCalls } = makeClient(script);
    const result = await runFixAgent(runOptions(client, CAP));

    expect(createCalls).toHaveLength(CAP);
    for (let i = 0; i < CAP - 1; i++) {
      expect(createCalls[i].tools, `iteration ${i} should offer tools`).toBeDefined();
    }
    const finalCall = createCalls[CAP - 1];
    expect(finalCall.tools).toBeUndefined();

    const lastMessage = finalCall.messages[finalCall.messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(JSON.stringify(lastMessage.content)).toContain('iteration limit');

    // The run must end with usable final text, not an empty tool_use cutoff.
    expect(result.finalText).toBe('final diff or verdict');
    expect(result.stopReason).toBe('end_turn');
  });

  it('uses the caller-specific final-turn prompt when provided', async () => {
    const CAP = 2;
    const { client, createCalls } = makeClient([
      toolUseMessage('t0', 'read_file', { path: 'a.ts' }),
      endMessage('{"isReal":true}'),
    ]);

    await runFixAgent({
      ...runOptions(client, CAP),
      finalTurnPrompt: 'Emit your single JSON verdict now in a ```json code block.',
    });

    const lastMessage = createCalls[1].messages[createCalls[1].messages.length - 1];
    expect(JSON.stringify(lastMessage.content)).toContain('JSON verdict');
  });

  it('does not force the final turn when the model finishes early', async () => {
    const { client, createCalls } = makeClient([
      toolUseMessage('t0', 'read_file', { path: 'a.ts' }),
      endMessage('done early'),
    ]);
    await runFixAgent(runOptions(client, 6));

    expect(createCalls).toHaveLength(2);
    expect(createCalls[1].tools).toBeDefined();
  });
});
