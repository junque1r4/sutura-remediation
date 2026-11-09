import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFinding } from '@sutura/common';

// runSecurityScan is the only @sutura/sandbox-runner symbol the grader imports
// that needs to be controllable; the runner itself is passed in as a mock.
vi.mock('@sutura/sandbox-runner', () => ({
  runSecurityScan: vi.fn(),
}));

import { runAdversarialGrader } from '../pipeline/validated/grader';
import { runSecurityScan } from '@sutura/sandbox-runner';

const mockScan = vi.mocked(runSecurityScan);

const FINDING: NormalizedFinding = {
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'SQLi',
  description: 'bad',
  severity: 'high',
  repo: 'acme/api',
  rawPayload: {},
};

const GOOD_DIFF = '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-x\n+y';

function makeRunner() {
  return {
    createWorkspace: vi.fn(async () => ({ id: 'fresh-ws' })),
    applyPatch: vi.fn(async () => ({ ok: true, rejects: '', command: 'git apply' })),
    restore: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'restore' })),
    install: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: 'install' })),
    runTests: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, command: 'test' })),
    detectToolchain: vi.fn(async () => ({ testFramework: 'vitest', testFilePattern: '{base}.spec.ts', restoreNeedsPatch: false })),
    readFile: vi.fn(async () => 'content'),
    cleanup: vi.fn(async () => {}),
  } as never;
}

function scanResult(verdict: 'resolved' | 'still_vulnerable' | 'inconclusive', matched: string[] = []) {
  return { verdict, tool: 'mock', output: 'out', matched, timedOut: false, command: 'scan' };
}

describe('runAdversarialGrader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-verifies from a FRESH workspace built off the original tarball', async () => {
    mockScan.mockResolvedValue(scanResult('resolved'));
    const runner = makeRunner();
    const tarball = Buffer.from('original');

    const out = await runAdversarialGrader({
      tarball,
      generated: { diff: GOOD_DIFF },
      finding: FINDING,
      runner,
    });

    // A fresh workspace is created from the ORIGINAL tarball and the diff
    // re-applied independently.
    expect(runner.createWorkspace).toHaveBeenCalledTimes(1);
    expect(runner.createWorkspace).toHaveBeenCalledWith(tarball, undefined);
    expect(runner.applyPatch).toHaveBeenCalledWith({ id: 'fresh-ws' }, GOOD_DIFF);
    expect(runner.restore).toHaveBeenCalledTimes(1);
    expect(runner.runTests).toHaveBeenCalledTimes(1);
    expect(out.resolved).toBe(true);
    expect(out.verdict).toBe('pass');
    // Fresh workspace is always cleaned up.
    expect(runner.cleanup).toHaveBeenCalledTimes(1);
  });

  it('resolves only when scan is resolved AND tests pass', async () => {
    mockScan.mockResolvedValue(scanResult('resolved'));
    const runner = makeRunner();
    (runner.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 1,
      stdout: 'fail',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      command: 'test',
    });

    const out = await runAdversarialGrader({
      tarball: Buffer.from('t'),
      generated: { diff: GOOD_DIFF },
      finding: FINDING,
      runner,
    });

    expect(out.resolved).toBe(false);
    expect(out.verdict).toBe('fail');
  });

  it('disagrees (fail) when the independent scan still reports vulnerable', async () => {
    mockScan.mockResolvedValue(scanResult('still_vulnerable', ['CVE-1']));
    const runner = makeRunner();

    const out = await runAdversarialGrader({
      tarball: Buffer.from('t'),
      generated: { diff: GOOD_DIFF },
      finding: FINDING,
      runner,
    });

    expect(out.resolved).toBe(false);
    expect(out.verdict).toBe('fail');
    expect(out.evidence).toContain('still_vulnerable');
  });

  it('returns inconclusive (not crash) when the runner throws internally', async () => {
    const runner = makeRunner();
    (runner.restore as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('docker down'));

    const out = await runAdversarialGrader({
      tarball: Buffer.from('t'),
      generated: { diff: GOOD_DIFF },
      finding: FINDING,
      runner,
    });

    expect(out.resolved).toBe(false);
    expect(out.verdict).toBe('inconclusive');
    expect(out.evidence).toContain('internal error');
    // Even on error the fresh workspace is cleaned up.
    expect(runner.cleanup).toHaveBeenCalledTimes(1);
  });

  it('returns inconclusive when restore fails independently', async () => {
    mockScan.mockResolvedValue(scanResult('resolved'));
    const runner = makeRunner();
    (runner.restore as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'npm err',
      durationMs: 1,
      timedOut: false,
      command: 'restore',
    });

    const out = await runAdversarialGrader({
      tarball: Buffer.from('t'),
      generated: { diff: GOOD_DIFF },
      finding: FINDING,
      runner,
    });

    expect(out.verdict).toBe('inconclusive');
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('fails when the diff cannot be re-applied to a fresh workspace', async () => {
    const runner = makeRunner();
    (runner.applyPatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      rejects: 'hunk #1 failed',
      command: 'git apply',
    });

    const out = await runAdversarialGrader({
      tarball: Buffer.from('t'),
      generated: { diff: GOOD_DIFF },
      finding: FINDING,
      runner,
    });

    expect(out.resolved).toBe(false);
    expect(out.verdict).toBe('fail');
    expect(out.evidence).toContain('re-apply');
  });

  it('is inconclusive on an empty diff without touching the sandbox', async () => {
    const runner = makeRunner();

    const out = await runAdversarialGrader({
      tarball: Buffer.from('t'),
      generated: { diff: '' },
      finding: FINDING,
      runner,
    });

    expect(out.verdict).toBe('inconclusive');
    expect(runner.createWorkspace).not.toHaveBeenCalled();
  });
});
