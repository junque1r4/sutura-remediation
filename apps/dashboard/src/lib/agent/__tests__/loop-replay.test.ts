import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolResult } from '../github-tools';

const dispatchToolMock = vi.fn<(...args: unknown[]) => Promise<ToolResult>>();

vi.mock('../github-tools', () => ({
  dispatchTool: (...args: unknown[]) => dispatchToolMock(...args),
}));

import { runAnalysisAgent, type AgentEvent } from '../loop';

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
 * Fake Anthropic client: each `messages.stream` call pops the next scripted
 * final message. Captures the request params so tests can inspect the tool
 * results sent back to the model.
 */
function makeClient(script: FakeMessage[]) {
  const streamCalls: { messages: Anthropic.MessageParam[] }[] = [];
  let index = 0;
  const client = {
    messages: {
      stream: (params: { messages: Anthropic.MessageParam[] }) => {
        // Snapshot: the loop mutates the same messages array across iterations.
        streamCalls.push({ messages: [...params.messages] });
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

function toolResultBlocks(message: Anthropic.MessageParam) {
  return (message.content as { type: string; content: string; is_error: boolean }[]).filter(
    (b) => b.type === 'tool_result',
  );
}

beforeEach(() => {
  dispatchToolMock.mockReset();
});

describe('runAnalysisAgent successful-call replay', () => {
  it('replays an identical successful grep_code call from cache instead of re-dispatching', async () => {
    const { client, streamCalls } = makeClient([
      toolUseMessage('t1', 'grep_code', { query: 'getSession' }),
      toolUseMessage('t2', 'grep_code', { query: 'getSession' }),
      endMessage('done'),
    ]);
    dispatchToolMock.mockResolvedValue({
      ok: true,
      content: '# grep_code "getSession" — 3 total matches',
      summary: 'grep_code "getSession" (3 matches)',
    });

    const events: AgentEvent[] = [];
    await runAnalysisAgent(runOptions(client, events));

    expect(dispatchToolMock).toHaveBeenCalledTimes(1);

    const replayEvent = events.find(
      (e) => e.type === 'tool_result' && e.id === 't2',
    ) as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(replayEvent.ok).toBe(true);
    expect(replayEvent.summary).toBe('served from cache');

    // The cached content must be replayed verbatim to the model.
    const lastRequest = streamCalls[2].messages;
    const [replayed] = toolResultBlocks(lastRequest[lastRequest.length - 1]);
    expect(replayed.content).toBe('# grep_code "getSession" — 3 total matches');
    expect(replayed.is_error).toBe(false);
  });

  it('treats cosmetically different inputs as the same call', async () => {
    const { client } = makeClient([
      toolUseMessage('t1', 'grep_code', { query: 'getSession' }),
      toolUseMessage('t2', 'grep_code', { query: '"getSession"' }),
      endMessage('done'),
    ]);
    dispatchToolMock.mockResolvedValue({
      ok: true,
      content: 'matches',
      summary: 'grep_code "getSession" (1 match)',
    });

    const events: AgentEvent[] = [];
    await runAnalysisAgent(runOptions(client, events));

    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
  });

  it('replays read_file and list_directory results too (repo state is stable within a run)', async () => {
    const { client } = makeClient([
      toolUseMessage('t1', 'read_file', { path: 'src/auth.ts' }),
      toolUseMessage('t2', 'read_file', { path: './src/auth.ts' }),
      endMessage('done'),
    ]);
    dispatchToolMock.mockResolvedValue({
      ok: true,
      content: '# src/auth.ts (10 lines)',
      summary: 'read_file src/auth.ts (10 lines)',
    });

    const events: AgentEvent[] = [];
    await runAnalysisAgent(runOptions(client, events));

    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    const replayEvent = events.find(
      (e) => e.type === 'tool_result' && e.id === 't2',
    ) as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(replayEvent.summary).toBe('served from cache');
  });

  it('does not cache failed calls as successes', async () => {
    const { client } = makeClient([
      toolUseMessage('t1', 'grep_code', { query: 'missing' }),
      toolUseMessage('t2', 'grep_code', { query: 'missing' }),
      endMessage('done'),
    ]);
    dispatchToolMock.mockResolvedValue({
      ok: false,
      content: 'grep_code "missing": not found',
      summary: 'grep_code "missing": not found',
    });

    const events: AgentEvent[] = [];
    await runAnalysisAgent(runOptions(client, events));

    // The repeat still goes through the existing duplicate-failure path.
    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    const repeatEvent = events.find(
      (e) => e.type === 'tool_result' && e.id === 't2',
    ) as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(repeatEvent.ok).toBe(false);
    expect(repeatEvent.summary).toBe('duplicate call suppressed');
  });

  it('prefers the pre-fetched cache over the in-run cache', async () => {
    const { client } = makeClient([
      toolUseMessage('t1', 'read_file', { path: 'package.json' }),
      endMessage('done'),
    ]);

    const preFetched = new Map<string, string>([
      ['read_file:{"path":"package.json"}', 'prefetched manifest'],
    ]);
    const events: AgentEvent[] = [];
    await runAnalysisAgent({ ...runOptions(client, events), preFetched });

    expect(dispatchToolMock).not.toHaveBeenCalled();
    const event = events.find(
      (e) => e.type === 'tool_result' && e.id === 't1',
    ) as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(event.summary).toBe('served from pre-fetch');
  });
});
