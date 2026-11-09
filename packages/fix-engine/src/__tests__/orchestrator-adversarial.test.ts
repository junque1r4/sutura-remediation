import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';

// ---- module mocks (must be declared before importing the orchestrator) ----

vi.mock('../pipeline/validated/repo-tarball', () => ({
  fetchRepoTarball: vi.fn(async () => ({ tarball: Buffer.from('tar'), ref: 'main' })),
}));

vi.mock('../pipeline/validated/verifier', () => ({
  // Verification gate off-path for these tests: return a real+reachable verdict
  // so the pipeline proceeds straight to fix generation.
  runVerificationAgent: vi.fn(async () => ({
    isReal: true,
    reachable: true,
    exploitability: 'high',
    confidence: 'medium',
    reasoning: 'r',
    verifiedAt: '2026-06-06T00:00:00.000Z',
  })),
}));

vi.mock('../pipeline/validated/grader', () => ({
  runAdversarialGrader: vi.fn(),
}));

vi.mock('../pipeline/validated/bypass-agent', () => ({
  runBypassAgent: vi.fn(),
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
import { runAdversarialGrader } from '../pipeline/validated/grader';
import { runBypassAgent } from '../pipeline/validated/bypass-agent';
import { generateFixAgentic } from '../pipeline/generator';
import { submitMultiFile } from '../pipeline/submitter';

const mockGrader = vi.mocked(runAdversarialGrader);
const mockBypass = vi.mocked(runBypassAgent);
const mockGenerate = vi.mocked(generateFixAgentic);
const mockSubmit = vi.mocked(submitMultiFile);

const FINDING: NormalizedFinding = {
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'SQLi',
  description: 'bad',
  severity: 'high',
  repo: 'acme/api',
  rawPayload: {},
};

function makeRunner() {
  return {
    createWorkspace: vi.fn(async () => ({ id: 'ws' })),
    applyPatch: vi.fn(async () => ({ ok: true, rejects: '', command: 'git apply' })),
    restore: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'restore' })),
    install: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'install' })),
    runTests: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, command: 'test' })),
    assertDiskUnderCeiling: vi.fn(async () => {}),
    readFile: vi.fn(async () => 'content'),
    detectToolchain: vi.fn(async () => ({ testFramework: 'vitest', testFilePattern: '{base}.spec.ts', restoreNeedsPatch: false })),
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
    recordGraderVerdict: vi.fn(async () => {}),
    recordBypassAttempt: vi.fn(async () => {}),
  };
}

function deps(
  runner: ReturnType<typeof makeRunner>,
  persistence: ReturnType<typeof makePersistence>,
  configOver = {},
) {
  return {
    finding: FINDING,
    findingDbId: 'finding-uuid',
    orgId: 'org-1',
    config: {
      anthropicApiKey: 'k',
      voyageApiKey: '',
      pineconeApiKey: '',
      githubToken: 't',
      // Keep the verification gate out of the way for adversarial-focused tests.
      verifyBeforeFix: false,
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

const CLEAN_GRADE = { resolved: true, verdict: 'pass' as const, evidence: 'ok' };
const CLEAN_BYPASS = { bypassed: false, evidence: 'none' };

describe('ValidatedFixPipeline adversarial validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUTURA_ADVERSARIAL_DISABLED;
    delete process.env.SUTURA_VALIDATED_FIX_DISABLED;
    mockGenerate.mockResolvedValue(GOOD_DIFF);
    mockGrader.mockResolvedValue(CLEAN_GRADE);
    mockBypass.mockResolvedValue(CLEAN_BYPASS);
  });

  afterEach(() => {
    delete process.env.SUTURA_ADVERSARIAL_DISABLED;
  });

  it('opens a PR when both grader and bypass come back clean', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockGrader).toHaveBeenCalledTimes(1);
    expect(mockBypass).toHaveBeenCalledTimes(1);
    expect(persistence.recordGraderVerdict).toHaveBeenCalledTimes(1);
    expect(persistence.recordBypassAttempt).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('passes the ORIGINAL tarball to the grader', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    await pipeline.execute(deps(runner, persistence));

    const arg = mockGrader.mock.calls[0][0];
    expect(Buffer.isBuffer(arg.tarball)).toBe(true);
    expect(arg.tarball.toString()).toBe('tar');
    expect(arg.generated.diff).toBe(GOOD_DIFF.diff);
  });

  it('retries (does not PR) when the grader disagrees, then succeeds', async () => {
    mockGrader
      .mockResolvedValueOnce({ resolved: false, verdict: 'fail', evidence: 'scan still vulnerable' })
      .mockResolvedValue(CLEAN_GRADE);
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    // First attempt failed at adversarial stage -> retried; second opened a PR.
    expect(mockGenerate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockGrader.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The failed attempt is marked with the grader_disagreed reason.
    const failedUpdate = persistence.updateAttempt.mock.calls.find(
      ([, u]) => (u as { failureReason?: string }).failureReason === 'grader_disagreed',
    );
    expect(failedUpdate).toBeTruthy();
    expect(result.ok).toBe(true);
  });

  it('retries (does not PR) when the bypass agent defeats the fix', async () => {
    mockBypass
      .mockResolvedValueOnce({ bypassed: true, evidence: 'still reachable via /admin' })
      .mockResolvedValue(CLEAN_BYPASS);
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockGenerate.mock.calls.length).toBeGreaterThanOrEqual(2);
    const failedUpdate = persistence.updateAttempt.mock.calls.find(
      ([, u]) => (u as { failureReason?: string }).failureReason === 'bypass_succeeded',
    );
    expect(failedUpdate).toBeTruthy();
    expect(result.ok).toBe(true);
  });

  it('does not run bypass when the grader already disagreed', async () => {
    mockGrader.mockResolvedValue({ resolved: false, verdict: 'fail', evidence: 'no' });
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    await pipeline.execute(deps(runner, persistence));

    expect(mockBypass).not.toHaveBeenCalled();
  });

  it('runs the bypass agent on the existing post-patch workspace (no new workspace)', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    await pipeline.execute(deps(runner, persistence));

    // One workspace per attempt (the orchestrator's), reused by the bypass agent.
    // The grader is mocked so it does not create its own here.
    expect(runner.createWorkspace).toHaveBeenCalledTimes(1);
    const bypassArg = mockBypass.mock.calls[0][0];
    expect(bypassArg.workspace).toEqual({ id: 'ws' });
  });

  it('skips adversarial validation (legacy) when the flag is off', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(
      deps(runner, persistence, { adversarialValidation: false }),
    );

    expect(mockGrader).not.toHaveBeenCalled();
    expect(mockBypass).not.toHaveBeenCalled();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('skips adversarial validation when the kill-switch env is set', async () => {
    process.env.SUTURA_ADVERSARIAL_DISABLED = '1';
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(mockGrader).not.toHaveBeenCalled();
    expect(mockBypass).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('skips adversarial validation when no anthropic key is present', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence, { anthropicApiKey: '' }));

    expect(mockGrader).not.toHaveBeenCalled();
    expect(mockBypass).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
