import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerSandboxRunner } from '../docker-runner';
import type { SandboxConfig } from '../sandbox-config';
import type { RunResult, WorkspaceHandle } from '../types';

/**
 * assertDiskUnderCeiling is the guard that stops untrusted build code from
 * filling the host disk: it `du`s /work and throws when usage exceeds the
 * configured ceiling, before the offline build runs. We stub the runner's exec
 * so no Docker daemon is touched -- the point is to lock the threshold logic
 * (throw when over, no-op when under, skip entirely when unset).
 */
function configWith(ceil?: number): SandboxConfig {
  return {
    runtime: 'runc',
    socketPath: '/var/run/docker.sock',
    enableEgress: false,
    egressNetwork: 'no-egress-net',
    pidsLimit: 256,
    workDiskCeilingMb: ceil,
  } as SandboxConfig;
}

const ws: WorkspaceHandle = { id: 'cid', image: 'sutura/sandbox-base:latest', rootPath: '/work' };

function duResult(mb: string): RunResult {
  return { exitCode: 0, stdout: mb, stderr: '', durationMs: 1, timedOut: false, command: 'du' };
}

let execSpy: ReturnType<typeof vi.fn>;
function runnerWithDu(ceil: number | undefined, du: RunResult) {
  const runner = new DockerSandboxRunner({ sandboxConfig: configWith(ceil) });
  execSpy = vi.fn(async () => du);
  vi.spyOn(runner, 'exec').mockImplementation(execSpy as never);
  return runner;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('assertDiskUnderCeiling', () => {
  it('throws when /work exceeds the ceiling', async () => {
    const runner = runnerWithDu(500, duResult('600'));
    await expect(runner.assertDiskUnderCeiling(ws)).rejects.toThrow(
      /exceeded the 500MB disk ceiling \(used 600MB\)/,
    );
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when /work is under the ceiling', async () => {
    const runner = runnerWithDu(500, duResult('499'));
    await expect(runner.assertDiskUnderCeiling(ws)).resolves.toBeUndefined();
  });

  it('does not throw when usage exactly equals the ceiling', async () => {
    const runner = runnerWithDu(500, duResult('500'));
    await expect(runner.assertDiskUnderCeiling(ws)).resolves.toBeUndefined();
  });

  it('is a no-op (no du exec) when no ceiling is configured', async () => {
    const runner = runnerWithDu(undefined, duResult('999999'));
    await expect(runner.assertDiskUnderCeiling(ws)).resolves.toBeUndefined();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('does not throw on unparseable du output (fails open, never blocks on noise)', async () => {
    const runner = runnerWithDu(500, duResult('du: cannot access'));
    await expect(runner.assertDiskUnderCeiling(ws)).resolves.toBeUndefined();
  });

  it('runs the du probe with the network isolated', async () => {
    const runner = runnerWithDu(500, duResult('1'));
    await runner.assertDiskUnderCeiling(ws);
    const opts = execSpy.mock.calls[0][3];
    expect(opts).toMatchObject({ isolateNetwork: true });
  });
});
