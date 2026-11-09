import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';

// ---- module mocks (must be declared before importing the orchestrator) ----

vi.mock('../pipeline/validated/repo-tarball', () => ({
  fetchRepoTarball: vi.fn(async () => ({ tarball: Buffer.from('tar'), ref: 'main' })),
}));

vi.mock('../pipeline/validated/verifier', () => ({
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
import { runSecurityScan } from '@sutura/sandbox-runner';

const mockGrader = vi.mocked(runAdversarialGrader);
const mockBypass = vi.mocked(runBypassAgent);
const mockGenerate = vi.mocked(generateFixAgentic);
const mockScan = vi.mocked(runSecurityScan);

const FINDING: NormalizedFinding = {
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'Weak crypto',
  description: 'MD5+3DES',
  severity: 'high',
  repo: 'acme/api',
  filePath: 'src/Engine.cs',
  rawPayload: {},
};

// A warm runner: snapshotTree/resetTree are present, so the orchestrator reuses
// the workspace across remediable rounds instead of rebuilding it.
function makeWarmRunner() {
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
    snapshotTree: vi.fn(async () => {}),
    resetTree: vi.fn(async () => {}),
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
  runner: ReturnType<typeof makeWarmRunner>,
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
      verifyBeforeFix: false,
      ...configOver,
    },
    persistence,
  };
}

const diffResult = (diff: string, messages: { role: 'assistant'; content: string }[]) => ({
  diff,
  model: 'm',
  tokensUsed: 10,
  inputTokens: 8,
  outputTokens: 2,
  promptSnapshot: 'p',
  responseText: 'r',
  messages,
});

const CLEAN_GRADE = { resolved: true, verdict: 'pass' as const, evidence: 'ok' };
const CLEAN_BYPASS = { bypassed: false, evidence: 'none' };

describe('ValidatedFixPipeline in-attempt remediation loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUTURA_ADVERSARIAL_DISABLED;
    delete process.env.SUTURA_VALIDATED_FIX_DISABLED;
    mockGrader.mockResolvedValue(CLEAN_GRADE);
    mockBypass.mockResolvedValue(CLEAN_BYPASS);
  });

  it('reuses the warm workspace and continues the SAME conversation after a bypass rejection', async () => {
    const round1 = diffResult('--- a/Engine.cs\n+++ b/Engine.cs\n@@ -1 +1 @@\n-x\n+y', [
      { role: 'assistant', content: 'round1 diff' },
    ]);
    const round2 = diffResult('--- a/Engine.cs\n+++ b/Engine.cs\n@@ -1 +1 @@\n-x\n+z', [
      { role: 'assistant', content: 'round2 diff' },
    ]);
    mockGenerate.mockResolvedValueOnce(round1).mockResolvedValueOnce(round2);
    // Round 1 bypass defeats the fix (cites a duplicate); round 2 lands clean.
    mockBypass
      .mockResolvedValueOnce({ bypassed: true, evidence: 'ExampleEncryptionHelper.cs still vulnerable' })
      .mockResolvedValue(CLEAN_BYPASS);

    const runner = makeWarmRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(result.ok).toBe(true);
    // Workspace was built ONCE and reused (resetTree between rounds), not rebuilt.
    expect(runner.createWorkspace).toHaveBeenCalledTimes(1);
    expect(runner.snapshotTree).toHaveBeenCalledTimes(1);
    expect(runner.resetTree).toHaveBeenCalledTimes(1);

    // Round 2 CONTINUES round 1's conversation: priorMessages === round1.messages.
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[0][0].priorMessages).toBeUndefined();
    expect(mockGenerate.mock.calls[1][0].priorMessages).toEqual(round1.messages);

    // The bypass evidence is fed back as adversarial-stage feedback.
    const fb = mockGenerate.mock.calls[1][0].retryFeedback;
    expect(fb?.stage).toBe('adversarial_validation');
    expect(fb?.output).toContain('ExampleEncryptionHelper.cs still vulnerable');
  });

  it('rebuilds a fresh workspace (no reset) on an environmental install failure', async () => {
    mockGenerate.mockResolvedValue(
      diffResult('--- a/Engine.cs\n+++ b/Engine.cs\n@@ -1 +1 @@\n-x\n+y', [
        { role: 'assistant', content: 'd' },
      ]),
    );
    const runner = makeWarmRunner();
    // First clean restore fails (environmental), second succeeds.
    runner.restore = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: 'NU1101 restore error', stderr: '', durationMs: 1, timedOut: false, command: 'restore' })
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'restore' }) as never;

    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(result.ok).toBe(true);
    // Environmental failure tears down and rebuilds: createWorkspace twice, and
    // resetTree is never used (each round started from a fresh extraction).
    expect(runner.createWorkspace).toHaveBeenCalledTimes(2);
    expect(runner.resetTree).not.toHaveBeenCalled();
  });

  it('stops after MAX_ATTEMPTS rounds of repeated remediable failure', async () => {
    mockGenerate.mockResolvedValue(
      diffResult('--- a/Engine.cs\n+++ b/Engine.cs\n@@ -1 +1 @@\n-x\n+y', [
        { role: 'assistant', content: 'd' },
      ]),
    );
    // Scanner never resolves -> every round fails at the remediable rescan gate.
    mockScan.mockResolvedValue({
      verdict: 'vulnerable',
      tool: 'mock',
      matched: ['CWE-327'],
      output: 'still bad',
      timedOut: false,
      command: 'scan',
    } as never);

    const runner = makeWarmRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('exhausted');
    // Default MAX_ATTEMPTS is 5; the conversation is continued every round.
    expect(mockGenerate).toHaveBeenCalledTimes(5);
    // The final held workspace is released.
    expect(runner.cleanup).toHaveBeenCalled();
  });
});
