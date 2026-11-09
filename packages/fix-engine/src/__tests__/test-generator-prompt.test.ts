import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';
import { runTestGenerationAgent } from '../pipeline/validated/test-generator';
import type { GenerateResult } from '../pipeline/generator';

// Mock the Anthropic SDK so runTestGenerationAgent's loop runs against a fake
// messages.create (same pattern as bypass-agent.test.ts / verifier.test.ts).
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        messages: { create: mockCreate },
      };
    }),
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function makeEndTurnResponse() {
  return {
    content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: 100, output_tokens: 40 },
    stop_reason: 'end_turn',
  };
}

const FINDING: NormalizedFinding = {
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'SQL injection in user lookup',
  description: 'Unparameterized query',
  severity: 'high',
  repo: 'acme/api',
  filePath: 'src/db/user.ts',
  lineRange: [10, 12],
  rawPayload: {},
};

const GENERATED = { diff: '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-x\n+y' } as GenerateResult;
const WORKSPACE = {} as never;

function makeRunner() {
  return {
    detectToolchain: vi.fn().mockResolvedValue({
      language: 'node',
      image: 'sutura/sandbox-node:latest',
      installCmd: ['npm', 'ci'],
      testCmd: () => ['npx', 'vitest', 'run'],
      testFramework: 'vitest',
      testFilePattern: '{base}.sutura.test.ts',
    }),
    readFile: vi.fn(),
    writeFiles: vi.fn(),
  } as never;
}

describe('runTestGenerationAgent system prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the repository-specific notes section when repoTestEnvPrompt is set', async () => {
    const create = await getMockCreate();
    create.mockResolvedValueOnce(makeEndTurnResponse());

    await runTestGenerationAgent({
      finding: FINDING,
      generated: GENERATED,
      workspace: WORKSPACE,
      runner: makeRunner(),
      anthropicApiKey: 'k',
      repoTestEnvPrompt: 'Use dotnet 8; restore from our private NuGet feed first.',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('Repository-specific environment notes');
    expect(system).toContain('Use dotnet 8; restore from our private NuGet feed first.');
    expect(system).toContain('NEVER quote');
  });

  it('omits the section when repoTestEnvPrompt is unset', async () => {
    const create = await getMockCreate();
    create.mockResolvedValueOnce(makeEndTurnResponse());

    await runTestGenerationAgent({
      finding: FINDING,
      generated: GENERATED,
      workspace: WORKSPACE,
      runner: makeRunner(),
      anthropicApiKey: 'k',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const system = create.mock.calls[0][0].system as string;
    expect(system).not.toContain('Repository-specific environment notes');
    expect(system).not.toContain('NEVER quote');
  });
});
