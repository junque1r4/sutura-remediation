import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tar from 'tar-stream';
import type { NormalizedFinding, SerializedToolchain } from '@sutura/common';

function makeTar(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, content] of Object.entries(files)) pack.entry({ name }, content);
  pack.finalize();
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

let TARBALL: Buffer;

vi.mock('../pipeline/validated/repo-tarball', () => ({
  fetchRepoTarball: vi.fn(async () => ({ tarball: TARBALL, ref: 'main' })),
}));
vi.mock('../pipeline/validated/verifier', () => ({
  runVerificationAgent: vi.fn(async () => null),
}));
vi.mock('../pipeline/validated/grader', () => ({
  runAdversarialGrader: vi.fn(async () => ({ resolved: true, verdict: 'pass', evidence: 'ok' })),
}));
vi.mock('../pipeline/validated/bypass-agent', () => ({
  runBypassAgent: vi.fn(async () => ({ bypassed: false, evidence: 'none' })),
}));
vi.mock('../pipeline/generator', () => ({
  generateFixAgentic: vi.fn(async () => ({
    diff: '--- a/f.cs\n+++ b/f.cs\n@@ -1 +1 @@\n-x\n+y',
    model: 'm',
    tokensUsed: 1,
    inputTokens: 1,
    outputTokens: 0,
    promptSnapshot: 'p',
    responseText: 'r',
  })),
}));
vi.mock('../pipeline/validated/test-generator', () => ({
  runTestGenerationAgent: vi.fn(async () => ({
    files: [{ path: 'Tests/EngineSuturaTests.cs', content: 'x' }],
    paths: ['Tests/EngineSuturaTests.cs'],
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
vi.mock('@sutura/sandbox-runner', async () => {
  const actual = await vi.importActual<typeof import('@sutura/sandbox-runner')>(
    '@sutura/sandbox-runner',
  );
  return {
    ...actual,
    DockerSandboxRunner: class {},
    runSecurityScan: vi.fn(async () => ({
      verdict: 'resolved',
      tool: 'mock',
      matched: [],
      output: 'clean',
      timedOut: false,
      command: 'scan',
    })),
  };
});

import { ValidatedFixPipeline } from '../pipeline/validated/orchestrator';

const FINDING: NormalizedFinding = {
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'Weak crypto',
  description: 'bad',
  severity: 'high',
  repo: 'acme/api',
  filePath: 'ExampleApp.Security/Encryption/Engine.cs',
  rawPayload: {},
};

const TOOLCHAIN: SerializedToolchain = {
  language: 'C#',
  image: 'sutura/sandbox-dotnet:latest',
  restoreCmd: ['sh', '-c', 'dotnet restore'],
  testCmd: ['sh', '-c', 'dotnet test'],
  cachePaths: ['/cache/nuget'],
  restoreNeedsPatch: false,
  appendTestPaths: true,
  testFramework: 'xunit',
  testFilePattern: 'Tests/{base}SuturaTests.cs',
};

interface RestoreCall {
  cwd: string | undefined;
}

function makeRunner(over: { testExitCode?: number; testStdout?: string } = {}) {
  const restoreCalls: RestoreCall[] = [];
  const runTestsCwds: Array<string | undefined> = [];
  const runner = {
    getCacheVolumeManifest: vi.fn(async () => null),
    recreateCacheVolume: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => ({ id: 'ws', image: 'img', rootPath: '/work' })),
    applyPatch: vi.fn(async () => ({ ok: true, rejects: '', command: 'git apply' })),
    // The scope walk: report ExampleApp.Security as the enclosing project dir.
    exec: vi.fn(async () => ({
      exitCode: 0,
      stdout: 'ExampleApp.Security\n',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      command: 'walk',
    })),
    restore: vi.fn(async (_ws: unknown, _t?: number, opts?: { offline?: boolean; cwd?: string }) => {
      restoreCalls.push({ cwd: opts?.cwd });
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'restore' };
    }),
    runTests: vi.fn(async (_ws: unknown, _paths: string[], _t?: number, opts?: { cwd?: string }) => {
      runTestsCwds.push(opts?.cwd);
      return {
        exitCode: over.testExitCode ?? 0,
        stdout: over.testStdout ?? 'ok',
        stderr: '',
        durationMs: 1,
        timedOut: false,
        command: 'test',
      };
    }),
    assertDiskUnderCeiling: vi.fn(async () => {}),
    readFile: vi.fn(async () => 'content'),
    detectToolchain: vi.fn(async () => ({ testFramework: 'xunit', testFilePattern: 'x', restoreNeedsPatch: false })),
    writeFiles: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
  return { runner: runner as never, restoreCalls, runTestsCwds };
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

function deps(runner: never, persistence: ReturnType<typeof makePersistence>) {
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
      adversarialValidation: false,
      maxAttempts: 1,
      repoToolchain: TOOLCHAIN,
    },
    persistence,
  };
}

describe('ValidatedFixPipeline finding-scoped restore/build', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    TARBALL = await makeTar({ 'ExampleApp.Security/Encryption/Engine.cs': 'x' });
  });

  it('scopes restore and tests to the project dir derived from finding.filePath', async () => {
    const { runner, restoreCalls, runTestsCwds } = makeRunner();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, makePersistence()));

    expect(result.ok).toBe(true);
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0].cwd).toBe('/work/ExampleApp.Security');
    expect(runTestsCwds[0]).toBe('/work/ExampleApp.Security');
  });

  it('does NOT fail the attempt when the scoped project built but has no runnable tests', async () => {
    const { runner } = makeRunner({
      testExitCode: 1,
      testStdout: 'Determining projects to restore...\nNo test is available in ExampleApp.Security. RunConfiguration.TreatNoTestsAsError',
    });
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    // Rescan is the gate; a no-tests scoped library still yields a PR.
    expect(result.ok).toBe(true);
    const failedTests = persistence.updateAttempt.mock.calls.find(
      ([, u]) => (u as { failureReason?: string })?.failureReason === 'tests_failed',
    );
    expect(failedTests).toBeUndefined();
  });

  it('still fails hard on a real compile error even when scoped', async () => {
    const { runner } = makeRunner({
      testExitCode: 1,
      testStdout: 'Engine.cs(12,5): error CS1002: ; expected\nBuild FAILED.',
    });
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, persistence));

    expect(result.ok).toBe(false);
    const failedTests = persistence.updateAttempt.mock.calls.find(
      ([, u]) => (u as { failureReason?: string })?.failureReason === 'tests_failed',
    );
    expect(failedTests).toBeDefined();
  });
});
