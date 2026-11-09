import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DockerSandboxRunner } from '../docker-runner';
import type { SandboxConfig } from '../sandbox-config';
import type { DetectedToolchain, WorkspaceHandle } from '../types';

vi.mock('dockerode', () => ({
  default: class MockDocker {
    createContainer = vi.fn();
    listNetworks = vi.fn(async () => []);
    createNetwork = vi.fn(async () => ({}));
    getContainer = vi.fn();
    getNetwork = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    modem = { demuxStream: vi.fn() };
  },
}));

function devConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    runtime: 'runc',
    socketPath: '/var/run/docker.sock',
    enableEgress: false,
    egressNetwork: 'no-egress-net',
    pidsLimit: 256,
    ...overrides,
  };
}

const ws: WorkspaceHandle = { id: 'c1', image: 'sutura/sandbox-dotnet:latest', rootPath: '/work' };

const toolchain: DetectedToolchain = {
  language: 'unknown',
  image: 'sutura/sandbox-dotnet:latest',
  restoreCmd: ['sh', '-lc', 'dotnet restore'],
  installCmd: ['sh', '-lc', 'dotnet restore'],
  testCmd: (paths) => ['sh', '-lc', 'dotnet test', ...paths],
  cachePaths: ['/work/.nuget-packages'],
  restoreNeedsPatch: false,
  testFramework: 'xunit',
  testFilePattern: 'X/{base}SuturaTests.cs',
};

describe('network policy by phase', () => {
  let runner: DockerSandboxRunner;
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    vi.spyOn(runner, 'detectToolchain').mockResolvedValue(toolchain);
    execSpy = vi
      .spyOn(runner, 'exec')
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, command: '' });
  });

  it('restore() grants egress (isolateNetwork:false)', async () => {
    await runner.restore(ws);
    expect(execSpy).toHaveBeenCalledWith(
      ws,
      ['sh', '-lc', 'dotnet restore'],
      expect.any(Number),
      expect.objectContaining({ isolateNetwork: false }),
    );
  });

  it('runTests() never grants egress (isolateNetwork:true)', async () => {
    await runner.runTests(ws, ['X/FooSuturaTests.cs']);
    expect(execSpy).toHaveBeenCalledWith(
      ws,
      expect.arrayContaining(['dotnet test', 'X/FooSuturaTests.cs']),
      expect.any(Number),
      expect.objectContaining({ isolateNetwork: true }),
    );
  });

  it('restore({offline:true}) runs the package manager with NO egress (warm cache)', async () => {
    await runner.restore(ws, undefined, { offline: true });
    expect(execSpy).toHaveBeenCalledWith(
      ws,
      ['sh', '-lc', 'dotnet restore'],
      expect.any(Number),
      expect.objectContaining({ isolateNetwork: true }),
    );
  });

  it('install() is a deprecated alias of restore() and still grants egress', async () => {
    await runner.install(ws);
    expect(execSpy).toHaveBeenLastCalledWith(
      ws,
      ['sh', '-lc', 'dotnet restore'],
      expect.any(Number),
      expect.objectContaining({ isolateNetwork: false }),
    );
  });
});
