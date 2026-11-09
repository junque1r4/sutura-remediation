import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';
import {
  runVerificationAgent,
  parseVerdict,
  conservativeFallback,
} from '../pipeline/validated/verifier';

// Mock the Anthropic SDK so the real runFixAgent loop runs against a fake
// messages.create. The verifier only constructs a client when given an api key.
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

/** A final (non-tool) assistant turn containing `text`. */
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

// A stub runner -- never invoked when the agent emits a verdict without tools.
const RUNNER = {} as never;
const WORKSPACE = {} as never;

describe('parseVerdict', () => {
  const now = '2026-06-06T00:00:00.000Z';

  it('parses a verdict from a ```json fenced block', () => {
    const text =
      'After review:\n```json\n' +
      JSON.stringify({
        isReal: true,
        reachable: false,
        exploitability: 'medium',
        confidence: 'high',
        reasoning: 'Guarded by an auth check.',
      }) +
      '\n```';
    const v = parseVerdict(text, FINDING, now);
    expect(v).not.toBeNull();
    expect(v?.isReal).toBe(true);
    expect(v?.reachable).toBe(false);
    expect(v?.exploitability).toBe('medium');
    expect(v?.confidence).toBe('high');
    expect(v?.reasoning).toBe('Guarded by an auth check.');
    expect(v?.verifiedAt).toBe(now);
  });

  it('parses a bare trailing JSON object without a fence', () => {
    const text =
      'Verdict: {"isReal": false, "reachable": false, "exploitability": "low", "confidence": "medium", "reasoning": "test-only code"}';
    const v = parseVerdict(text, FINDING, now);
    expect(v?.isReal).toBe(false);
    expect(v?.exploitability).toBe('low');
  });

  it('returns null when isReal/reachable are not booleans', () => {
    const text = '```json\n{"isReal":"yes","reachable":true,"confidence":"high"}\n```';
    expect(parseVerdict(text, FINDING, now)).toBeNull();
  });

  it('returns null when no JSON object is present', () => {
    expect(parseVerdict('no structured verdict here', FINDING, now)).toBeNull();
  });

  it('falls back to finding severity when exploitability is invalid', () => {
    const text = '{"isReal":true,"reachable":true,"exploitability":"bogus","confidence":"x"}';
    const v = parseVerdict(text, FINDING, now);
    expect(v?.exploitability).toBe('high'); // FINDING.severity
    expect(v?.confidence).toBe('low'); // invalid -> low
  });
});

describe('conservativeFallback', () => {
  it('lets the pipeline proceed (isReal+reachable, finding severity, low conf)', () => {
    const v = conservativeFallback(FINDING, '2026-06-06T00:00:00.000Z');
    expect(v.isReal).toBe(true);
    expect(v.reachable).toBe(true);
    expect(v.exploitability).toBe('high');
    expect(v.confidence).toBe('low');
  });

  it('appends the concrete cause to the reasoning when provided', () => {
    const v = conservativeFallback(
      FINDING,
      '2026-06-06T00:00:00.000Z',
      'agent error: rate limited',
    );
    expect(v.reasoning).toContain('Verification agent did not return a usable verdict');
    expect(v.reasoning).toContain('(cause: agent error: rate limited)');
  });

  it('keeps the original reasoning untouched when no cause is provided', () => {
    const v = conservativeFallback(FINDING, '2026-06-06T00:00:00.000Z');
    expect(v.reasoning).not.toContain('(cause:');
  });
});

describe('runVerificationAgent', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns the parsed verdict when the agent emits valid JSON', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(
      makeTextResponse(
        '```json\n{"isReal":false,"reachable":false,"exploitability":"low","confidence":"high","reasoning":"false positive"}\n```',
      ),
    );

    const v = await runVerificationAgent({
      anthropicApiKey: 'k',
      finding: FINDING,
      workspace: WORKSPACE,
      runner: RUNNER,
    });
    expect(v.isReal).toBe(false);
    expect(v.confidence).toBe('high');
    expect(v.reasoning).toBe('false positive');
  });

  it('falls back conservatively when the agent emits no parseable verdict', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeTextResponse('I could not determine the verdict.'));

    const v = await runVerificationAgent({
      anthropicApiKey: 'k',
      finding: FINDING,
      workspace: WORKSPACE,
      runner: RUNNER,
    });
    expect(v.isReal).toBe(true);
    expect(v.reachable).toBe(true);
    expect(v.exploitability).toBe('high');
    expect(v.confidence).toBe('low');
    expect(v.reasoning).toContain('(cause: final text had no parseable JSON verdict)');
    // The agent's actual final text must be logged so parse failures are debuggable.
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[verifier]');
    expect(logged).toContain('I could not determine the verdict.');
  });

  it('falls back conservatively when the agent loop throws', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockRejectedValue(new Error('rate limited'));

    const v = await runVerificationAgent({
      anthropicApiKey: 'k',
      finding: FINDING,
      workspace: WORKSPACE,
      runner: RUNNER,
    });
    expect(v.isReal).toBe(true);
    expect(v.confidence).toBe('low');
    expect(v.reasoning).toContain('(cause: agent error: rate limited)');
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[verifier]');
    expect(logged).toContain('rate limited');
    expect(logged).toContain(FINDING.title);
  });

  it('falls back when no client and no api key are provided', async () => {
    const v = await runVerificationAgent({
      finding: FINDING,
      workspace: WORKSPACE,
      runner: RUNNER,
    });
    expect(v.isReal).toBe(true);
    expect(v.confidence).toBe('low');
    expect(v.reasoning).toContain('(cause: no Anthropic client/api key configured)');
  });
});
