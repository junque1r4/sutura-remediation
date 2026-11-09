import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';
import { runBypassAgent, parseBypassVerdict } from '../pipeline/validated/bypass-agent';

// Mock the Anthropic SDK so the real runFixAgent loop runs against a fake
// messages.create. The bypass agent only constructs a client given an api key.
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

function makeTextResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
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

const RUNNER = {} as never;
const WORKSPACE = {} as never;
const GEN = { diff: '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-x\n+y' };

describe('parseBypassVerdict', () => {
  it('parses a bypassed:true verdict with evidence', () => {
    const text =
      'Findings:\n```json\n' +
      JSON.stringify({ bypassed: true, evidence: 'src/db/user.ts still concatenates input' }) +
      '\n```';
    const out = parseBypassVerdict(text);
    expect(out).not.toBeNull();
    expect(out?.bypassed).toBe(true);
    expect(out?.evidence).toContain('still concatenates');
  });

  it('parses a clean bypassed:false verdict', () => {
    const out = parseBypassVerdict('```json\n{"bypassed": false, "evidence": "param query"}\n```');
    expect(out?.bypassed).toBe(false);
  });

  it('downgrades bypassed:true with no evidence to false (require show-your-work)', () => {
    const out = parseBypassVerdict('```json\n{"bypassed": true}\n```');
    expect(out?.bypassed).toBe(false);
  });

  it('returns null when no parseable object is present', () => {
    expect(parseBypassVerdict('no json here')).toBeNull();
  });

  it('returns null when bypassed is not a boolean', () => {
    expect(parseBypassVerdict('```json\n{"bypassed": "yes"}\n```')).toBeNull();
  });
});

describe('runBypassAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports bypassed=true when the agent provides concrete evidence', async () => {
    const create = await getMockCreate();
    create.mockResolvedValueOnce(
      makeTextResponse(
        '```json\n' +
          JSON.stringify({
            bypassed: true,
            evidence: 'tests were weakened to never call the sink',
          }) +
          '\n```',
      ),
    );

    const out = await runBypassAgent({
      workspace: WORKSPACE,
      finding: FINDING,
      generated: GEN,
      runner: RUNNER,
      anthropicApiKey: 'k',
    });

    expect(out.bypassed).toBe(true);
    expect(out.evidence).toContain('weakened');
    expect(out.tokensUsed).toBe(140);
    expect(out.iterations).toBe(1);
  });

  it('reports bypassed=false when the agent finds the fix sound', async () => {
    const create = await getMockCreate();
    create.mockResolvedValueOnce(
      makeTextResponse(
        '```json\n{"bypassed": false, "evidence": "parameterized, test covers sink"}\n```',
      ),
    );

    const out = await runBypassAgent({
      workspace: WORKSPACE,
      finding: FINDING,
      generated: GEN,
      runner: RUNNER,
      anthropicApiKey: 'k',
    });

    expect(out.bypassed).toBe(false);
  });

  it('is conservative (false) when the agent emits no parseable verdict', async () => {
    const create = await getMockCreate();
    create.mockResolvedValueOnce(makeTextResponse('I am unsure and produced no verdict.'));

    const out = await runBypassAgent({
      workspace: WORKSPACE,
      finding: FINDING,
      generated: GEN,
      runner: RUNNER,
      anthropicApiKey: 'k',
    });

    expect(out.bypassed).toBe(false);
  });

  it('is conservative (false) and does not throw when the API errors', async () => {
    const create = await getMockCreate();
    create.mockRejectedValueOnce(new Error('rate limited'));

    const out = await runBypassAgent({
      workspace: WORKSPACE,
      finding: FINDING,
      generated: GEN,
      runner: RUNNER,
      anthropicApiKey: 'k',
    });

    expect(out.bypassed).toBe(false);
  });

  it('returns clean false without an Anthropic credential (no client)', async () => {
    const create = await getMockCreate();
    const out = await runBypassAgent({
      workspace: WORKSPACE,
      finding: FINDING,
      generated: GEN,
      runner: RUNNER,
    });

    expect(out.bypassed).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
