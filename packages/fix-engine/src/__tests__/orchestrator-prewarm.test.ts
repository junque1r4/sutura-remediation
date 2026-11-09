import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as tar from 'tar-stream';
import type { NormalizedFinding, SerializedToolchain } from '@sutura/common';

// A valid tar so manifestFingerprintFromTar (real, not mocked) can fingerprint
// it. fetchRepoTarball is mocked to return it.
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

// Populated in beforeEach so the mock can return a real tar buffer.
let TARBALL: Buffer;

vi.mock('../pipeline/validated/repo-tarball', () => ({
  fetchRepoTarball: vi.fn(async () => ({ tarball: TARBALL, ref: 'main' })),
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
  runAdversarialGrader: vi.fn(async () => ({ resolved: true, verdict: 'pass', evidence: 'ok' })),
}));

vi.mock('../pipeline/validated/bypass-agent', () => ({
  runBypassAgent: vi.fn(async () => ({ bypassed: false, evidence: 'none' })),
}));

vi.mock('../pipeline/generator', () => ({
  generateFixAgentic: vi.fn(async () => ({
    diff: '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-x\n+y',
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

vi.mock('@sutura/sandbox-runner', async () => {
  // Keep the real cache-volume helpers (cacheVolumeName, manifestFingerprintFromTar)
  // so prewarm runs for real against the mock runner.
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
  title: 'SQLi',
  description: 'bad',
  severity: 'high',
  repo: 'acme/api',
  rawPayload: {},
};

const TOOLCHAIN: SerializedToolchain = {
  language: 'unknown',
  image: 'sutura/sandbox-dotnet:latest',
  restoreCmd: ['sh', '-lc', 'dotnet restore'],
  testCmd: ['sh', '-lc', 'dotnet test'],
  cachePaths: ['/cache/nuget'],
  restoreNeedsPatch: false,
  appendTestPaths: true,
  testFramework: 'xunit',
  testFilePattern: 'X/{base}SuturaTests.cs',
};

interface RestoreCall {
  offline: boolean | undefined;
}

function makeRunner() {
  const restoreCalls: RestoreCall[] = [];
  const createWorkspaceOpts: Array<Record<string, unknown> | undefined> = [];
  const runner = {
    getCacheVolumeManifest: vi.fn(async () => null),
    recreateCacheVolume: vi.fn(async () => {}),
    createWorkspace: vi.fn(async (_tar: Buffer, opts?: Record<string, unknown>) => {
      createWorkspaceOpts.push(opts);
      return { id: 'ws', image: 'img', rootPath: '/work' };
    }),
    applyPatch: vi.fn(async () => ({ ok: true, rejects: '', command: 'git apply' })),
    restore: vi.fn(async (_ws: unknown, _t?: number, opts?: { offline?: boolean }) => {
      restoreCalls.push({ offline: opts?.offline });
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'restore' };
    }),
    runTests: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, command: 'test' })),
    assertDiskUnderCeiling: vi.fn(async () => {}),
    readFile: vi.fn(async () => 'content'),
    detectToolchain: vi.fn(async () => ({ testFramework: 'xunit', testFilePattern: 'x', restoreNeedsPatch: false })),
    writeFiles: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    cleanup: vi.fn(async () => {}),
  };
  return { runner: runner as never, restoreCalls, createWorkspaceOpts };
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

function deps(runner: never, persistence: ReturnType<typeof makePersistence>, configOver = {}) {
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
      repoToolchain: TOOLCHAIN,
      ...configOver,
    },
    persistence,
  };
}

describe('ValidatedFixPipeline dependency-cache prewarm', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.SUTURA_PREWARM_DISABLED;
    TARBALL = await makeTar({ 'package.json': '{"name":"acme"}', 'src/x.ts': 'x' });
  });

  afterEach(() => {
    delete process.env.SUTURA_PREWARM_DISABLED;
  });

  it('prewarms once (networked), mounts the cache RO, and restores the attempt OFFLINE', async () => {
    const { runner, restoreCalls, createWorkspaceOpts } = makeRunner();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, makePersistence(), { prewarmCache: true }));

    expect(result.ok).toBe(true);
    // Prewarm built the cache once.
    expect((runner as { recreateCacheVolume: ReturnType<typeof vi.fn> }).recreateCacheVolume)
      .toHaveBeenCalledTimes(1);
    // Two createWorkspace calls: prewarm (RW) then the attempt (RO).
    const prewarmOpts = createWorkspaceOpts[0]!;
    const attemptOpts = createWorkspaceOpts[1]!;
    expect(prewarmOpts.cacheReadOnly).toBe(false);
    expect(attemptOpts.cacheReadOnly).toBe(true);
    expect(attemptOpts.cacheVolume).toBe(prewarmOpts.cacheVolume);
    // Two restores: networked prewarm, then the attempt restore runs OFFLINE
    // (--network=none) -- it regenerates the per-project restore state in /work
    // from the read-only cache without touching the network.
    expect(restoreCalls).toHaveLength(2);
    expect(restoreCalls[0].offline).toBeUndefined();
    expect(restoreCalls[1].offline).toBe(true);
  });

  it('does NOT prewarm or mount a cache by default (legacy networked restore)', async () => {
    const { runner, restoreCalls, createWorkspaceOpts } = makeRunner();
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, makePersistence()));

    expect(result.ok).toBe(true);
    expect((runner as { recreateCacheVolume: ReturnType<typeof vi.fn> }).recreateCacheVolume)
      .not.toHaveBeenCalled();
    // Single workspace (the attempt), no cache mount, restore is networked.
    expect(createWorkspaceOpts).toHaveLength(1);
    expect(createWorkspaceOpts[0]!.cacheVolume).toBeUndefined();
    expect(restoreCalls[0].offline).toBeUndefined();
  });

  it('respects the SUTURA_PREWARM_DISABLED kill-switch even when prewarmCache is on', async () => {
    process.env.SUTURA_PREWARM_DISABLED = '1';
    const { runner, restoreCalls } = makeRunner();
    const pipeline = new ValidatedFixPipeline(runner);

    await pipeline.execute(deps(runner, makePersistence(), { prewarmCache: true }));

    expect((runner as { recreateCacheVolume: ReturnType<typeof vi.fn> }).recreateCacheVolume)
      .not.toHaveBeenCalled();
    expect(restoreCalls[0].offline).toBeUndefined();
  });

  it('falls back to networked restore when prewarm restore fails', async () => {
    const { runner, restoreCalls, createWorkspaceOpts } = makeRunner();
    // Prewarm restore (first restore call) fails; attempt restore must be networked.
    (runner as { restore: ReturnType<typeof vi.fn> }).restore
      .mockImplementationOnce(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'no network',
        durationMs: 1,
        timedOut: false,
        command: 'restore',
      }))
      .mockImplementation(async (_ws: unknown, _t?: number, opts?: { offline?: boolean }) => {
        restoreCalls.push({ offline: opts?.offline });
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'restore' };
      });
    const pipeline = new ValidatedFixPipeline(runner);

    const result = await pipeline.execute(deps(runner, makePersistence(), { prewarmCache: true }));

    expect(result.ok).toBe(true);
    // The attempt did NOT mount a cache and restored networked.
    const attemptOpts = createWorkspaceOpts[createWorkspaceOpts.length - 1]!;
    expect(attemptOpts.cacheVolume).toBeUndefined();
    expect(restoreCalls[restoreCalls.length - 1].offline).toBeUndefined();
  });
});
