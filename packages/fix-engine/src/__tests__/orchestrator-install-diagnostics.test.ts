import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tar from 'tar-stream';
import type { NormalizedFinding, SerializedToolchain } from '@sutura/common';

// Regression for the install-failure DIAGNOSTICS-MASKING bug: .NET `dotnet
// restore` prints a HARMLESS "An issue was encountered verifying workloads"
// warning to STDERR (the SDK can't write its workload advertising manifest to
// the read-only rootfs) yet the real error -- the one that made restore exit
// non-zero -- lands on STDOUT. The orchestrator used `tail(stderr || stdout)`,
// so a non-empty stderr always masked the real stdout error, leaving the
// persisted failure output as the useless 98-byte workload warning. The fix
// records BOTH streams so the real cause survives.

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

vi.mock('@sutura/sandbox-runner', async () => {
  const actual = await vi.importActual<typeof import('@sutura/sandbox-runner')>(
    '@sutura/sandbox-runner',
  );
  return { ...actual, DockerSandboxRunner: class {} };
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
  testFilePattern: 'X/{base}SuturaTests.cs',
};

const WORKLOAD_WARNING =
  'An issue was encountered verifying workloads. For more information, run "dotnet workload update".';
const REAL_ERROR =
  '/work/ExampleAppWebAPI.sln : error NU1301: Unable to load the service index for source https://nuget.pkg.github.com/example-org/index.json.';

function makeRunner() {
  const runner = {
    getCacheVolumeManifest: vi.fn(async () => null),
    recreateCacheVolume: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => ({ id: 'ws', image: 'img', rootPath: '/work' })),
    applyPatch: vi.fn(async () => ({ ok: true, rejects: '', command: 'git apply' })),
    // Restore fails: the REAL error is on stdout, the harmless workload warning on stderr.
    restore: vi.fn(async () => ({
      exitCode: 1,
      stdout: `  Determining projects to restore...\n${REAL_ERROR}`,
      stderr: WORKLOAD_WARNING,
      durationMs: 1,
      timedOut: false,
      command: 'restore',
    })),
    runTests: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, command: 'test' })),
    assertDiskUnderCeiling: vi.fn(async () => {}),
    readFile: vi.fn(async () => 'content'),
    detectToolchain: vi.fn(async () => ({ testFramework: 'xunit', testFilePattern: 'x', restoreNeedsPatch: false })),
    writeFiles: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    cleanup: vi.fn(async () => {}),
  };
  return runner;
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
      maxAttempts: 1,
      repoToolchain: TOOLCHAIN,
    },
    persistence,
  };
}

describe('install-failure diagnostics', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    TARBALL = await makeTar({ 'package.json': '{"name":"acme"}', 'src/x.ts': 'x' });
  });

  it('records the real stdout error, not just the stderr workload warning', async () => {
    const runner = makeRunner();
    const persistence = makePersistence();
    const pipeline = new ValidatedFixPipeline(runner as never);

    await pipeline.execute(deps(runner as never, persistence));

    // Find the updateAttempt call that recorded the install failure.
    const failCall = persistence.updateAttempt.mock.calls.find(
      ([, updates]) => (updates as { failureReason?: string })?.failureReason === 'install_failed',
    );
    expect(failCall).toBeDefined();
    const output = (failCall![1] as { testOutput?: string }).testOutput ?? '';
    // The real cause (the stdout NU1301 error) must survive in the diagnostics.
    expect(output).toContain('NU1301');
    expect(output).toContain('nuget.pkg.github.com');
  });
});
