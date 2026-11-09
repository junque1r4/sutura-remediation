import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NormalizedFinding, VerificationVerdict } from '@sutura/common';

// ---- module mocks (must be declared before importing the orchestrator) ----

vi.mock('../pipeline/validated/repo-tarball', () => ({
  fetchRepoTarball: vi.fn(async () => ({ tarball: Buffer.from('tar'), ref: 'main' })),
}));

vi.mock('../pipeline/validated/verifier', () => ({
  runVerificationAgent: vi.fn(),
}));

// Adversarial validation defaults ON; keep these existing verification-gate
// tests focused on the verifier by stubbing the grader/bypass to clean passes.
vi.mock('../pipeline/validated/grader', () => ({
  runAdversarialGrader: vi.fn(async () => ({
    resolved: true,
    verdict: 'pass',
    evidence: 'mock grader pass',
  })),
}));

vi.mock('../pipeline/validated/bypass-agent', () => ({
  runBypassAgent: vi.fn(async () => ({ bypassed: false, evidence: 'mock no bypass' })),
}));

vi.mock('../pipeline/generator', () => ({
  generateFixAgentic: vi.fn(),
}));

vi.mock('../pipeline/validated/test-generator', () => ({
  runTestGenerationAgent: vi.fn(async () => ({
    files: [{ path: 'test.spec.ts', content: 'x' }],
    paths: ['test.spec.ts'],
    inputTokens: 0,
    outputTokens: 0,
  })),
}));

vi.mock('../pipeline/pr-narrative', () => ({
  generatePrNarrative: vi.fn(async () => null),
}));

vi.mock('../pipeline/submitter', () => ({
  submitMultiFile: vi.fn(async () => ({
    prUrl: 'https://github.com/acme/api/pull/1',
    branchName: 'sutura/fix-1',
    prHeadSha: 'abc1234',
  })),
}));

vi.mock('../pipeline/ci-watcher', () => ({
  awaitCiVerdict: vi.fn(async () => ({ verdict: 'success', failureLogs: null, polledAt: 'now' })),
}));

vi.mock('@sutura/sandbox-runner', () => ({
  DockerSandboxRunner: class {},
  runSecurityScan: vi.fn(async () => ({
    verdict: 'resolved',
    tool: 'mock',
    matched: [],
    output: 'clean',
    timedOut: false,
    command: 'scan',
  })),
}));

import { ValidatedFixPipeline } from '../pipeline/validated/orchestrator';
import { runVerificationAgent } from '../pipeline/validated/verifier';
import { generateFixAgentic } from '../pipeline/generator';

const mockVerify = vi.mocked(runVerificationAgent);
const mockGenerate = vi.mocked(generateFixAgentic);

const FINDING: NormalizedFinding = {
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'SQLi',
  description: 'bad',
  severity: 'high',
  repo: 'acme/api',
  rawPayload: {},
};

function makeRunner(over: { restoreNeedsPatch?: boolean; calls?: string[] } = {}) {
  const calls = over.calls;
  const rec = (name: string) => () => {
    calls?.push(name);
  };
  return {
    createWorkspace: vi.fn(async () => ({ id: 'ws' })),
    applyPatch: vi.fn(async () => {
      rec('applyPatch')();
      return { ok: true, rejects: '', command: 'git apply' };
    }),
    restore: vi.fn(async () => {
      rec('restore')();
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'restore' };
    }),
    install: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'install' })),
    runTests: vi.fn(async () => {
      rec('runTests')();
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, command: 'test' };
    }),
    assertDiskUnderCeiling: vi.fn(async () => {}),
    readFile: vi.fn(async () => 'content'),
    detectToolchain: vi.fn(async () => ({
      testFramework: 'vitest',
      testFilePattern: '{base}.spec.ts',
      restoreNeedsPatch: over.restoreNeedsPatch ?? false,
    })),
    writeFiles: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    cleanup: vi.fn(async () => {}),
  } as never;
}

function makePersistence() {
  return {
    insertRunningAttempt: vi.fn(async () => ({ id: 'attempt-1' })),
    updateAttempt: vi.fn(async () => {}),
    recordSandboxLog: vi.fn(async () => {}),
    recordTokenUsage: vi.fn(async () => {}),
    updateFindingVerification: vi.fn(async () => {}),
    markFindingWontFix: vi.fn(async () => {}),
  };
}

function verdict(over: Partial<VerificationVerdict>): VerificationVerdict {
  return {
    isReal: true,
    reachable: true,
    exploitability: 'high',
    confidence: 'medium',
    reasoning: 'r',
    verifiedAt: '2026-06-06T00:00:00.000Z',
    ...over,
  };
}

function deps(runner: ReturnType<typeof makeRunner>, persistence: ReturnType<typeof makePersistence>, configOver = {}) {
  return {
    finding: FINDING,
    findingDbId: 'finding-uuid',
    orgId: 'org-1',
    config: {
      anthropicApiKey: 'k',
      voyageApiKey: '',
      pineconeApiKey: '',
      githubToken: 't',
      ...configOver,
    },
    persistence,
  };
}

const GOOD_DIFF = {
  diff: '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-x\n+y',
  model: 'm',
  tokensUsed: 1,
  inputTokens: 1,
  outputTokens: 0,
  promptSnapshot: 'p',
  responseText: 'r',
};

describe('ValidatedFixPipeline verification gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUTURA_VERIFY_DISABLED;
    delete process.env.SUTURA_VALIDATED_FIX_DISABLED;
    mockGenerate.mockResolvedValue(GOOD_DIFF);
  });

  afterEach(() => {
    delete process.env.SUTURA_VERIFY_DISABLED;
  });

  it('skips fix + marks wont_fix when verdict.isReal is false', async () => {
    mockVerify.mockResolvedValue(verdict({ isReal: false, confidence: 'medium' }));
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(persistence.markFindingWontFix).toHaveBeenCalledTimes(1);
    expect(persistence.updateFindingVerification).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A "not a real vuln" verdict is a neutral skip, not a failure -- it must
      // not render as a red failed/exhausted attempt in the UI.
      expect(result.reason).toBe('skipped');
      expect(result.skipReason).toBe('not_exploitable');
      expect(result.attempts).toBe(0);
      expect(result.lastFailure?.stage).toBe('exception');
    }
  });

  it('skips when unreachable AND confidence is high', async () => {
    mockVerify.mockResolvedValue(verdict({ reachable: false, confidence: 'high' }));
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(persistence.markFindingWontFix).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('skipped');
      expect(result.skipReason).toBe('unreachable');
    }
  });

  it('proceeds to generate a fix when unreachable but confidence is low', async () => {
    mockVerify.mockResolvedValue(verdict({ reachable: false, confidence: 'low' }));
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockGenerate).toHaveBeenCalled();
    expect(persistence.markFindingWontFix).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('proceeds when verdict is real and reachable', async () => {
    mockVerify.mockResolvedValue(verdict({}));
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockGenerate).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('verifies only once and reuses the verdict across retries', async () => {
    mockVerify.mockResolvedValue(verdict({}));
    // Fail the first attempt at patch so the loop retries; succeed on the second.
    const runner = makeRunner();
    (runner.applyPatch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, rejects: 'reject', command: 'git apply' })
      .mockResolvedValue({ ok: true, rejects: '', command: 'git apply' });
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(true);
  });

  it('does not verify when verifyBeforeFix is false (legacy path)', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence, { verifyBeforeFix: false }));

    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('does not verify when the kill-switch env is set', async () => {
    process.env.SUTURA_VERIFY_DISABLED = '1';
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('does not verify when no anthropic key is present', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence, { anthropicApiKey: '' }));

    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});

describe('ValidatedFixPipeline phase ordering (air-gap invariant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUTURA_VERIFY_DISABLED = '1'; // isolate phase ordering from the gate
    delete process.env.SUTURA_VALIDATED_FIX_DISABLED;
    mockGenerate.mockResolvedValue(GOOD_DIFF);
  });
  afterEach(() => {
    delete process.env.SUTURA_VERIFY_DISABLED;
  });

  it('code fix: restore runs BEFORE the patch is applied', async () => {
    const calls: string[] = [];
    const runner = makeRunner({ restoreNeedsPatch: false, calls });
    const pipeline = new ValidatedFixPipeline(runner);

    await pipeline.execute(deps(runner, makePersistence()));

    expect(calls.indexOf('restore')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('restore')).toBeLessThan(calls.indexOf('applyPatch'));
    expect(calls.indexOf('runTests')).toBeGreaterThan(calls.indexOf('applyPatch'));
    // exactly one restore, and never after the patch for a code fix
    expect(calls.filter((c) => c === 'restore')).toHaveLength(1);
  });

  it('dependency fix: restore runs AFTER the patch (manifest changed by patch)', async () => {
    const calls: string[] = [];
    const runner = makeRunner({ restoreNeedsPatch: true, calls });
    const pipeline = new ValidatedFixPipeline(runner);

    await pipeline.execute(deps(runner, makePersistence()));

    expect(calls.indexOf('applyPatch')).toBeLessThan(calls.indexOf('restore'));
    expect(calls.indexOf('restore')).toBeLessThan(calls.indexOf('runTests'));
    expect(calls.filter((c) => c === 'restore')).toHaveLength(1);
  });

  it('never grants a second networked restore (no install-after-patch for code fixes)', async () => {
    const calls: string[] = [];
    const runner = makeRunner({ restoreNeedsPatch: false, calls });
    const pipeline = new ValidatedFixPipeline(runner);

    await pipeline.execute(deps(runner, makePersistence()));

    expect((runner as unknown as { install: ReturnType<typeof vi.fn> }).install).not.toHaveBeenCalled();
  });
});
