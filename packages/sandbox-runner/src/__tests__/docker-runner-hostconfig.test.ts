import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VALIDATION_LIMITS } from '@sutura/common';
import { DockerSandboxRunner } from '../docker-runner';
import { getSandboxConfig, type SandboxConfig } from '../sandbox-config';

/**
 * HostConfig-assembly guard. We mock dockerode entirely so these tests never
 * touch a real Docker daemon. The point is to assert that the hardened
 * HostConfig fields are derived correctly from the injected SandboxConfig.
 */

const createContainer = vi.fn();
const listNetworks = vi.fn(async () => []);
const createNetwork = vi.fn(async () => ({}));

vi.mock('dockerode', () => {
  return {
    default: class MockDocker {
      createContainer = createContainer;
      listNetworks = listNetworks;
      createNetwork = createNetwork;
      getContainer = vi.fn();
      getNetwork = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
      modem = { demuxStream: vi.fn() };
    },
  };
});

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

beforeEach(() => {
  createContainer.mockReset();
  listNetworks.mockReset().mockResolvedValue([]);
  createNetwork.mockReset().mockResolvedValue({});
});

describe('buildHostConfig', () => {
  it('drops all caps, sets readonly rootfs, pids limit, tmpfs, runtime', () => {
    const runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    const hc = runner.buildHostConfig();

    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.PidsLimit).toBe(256);
    expect(hc.SecurityOpt).toContain('no-new-privileges');
    expect(hc.Runtime).toBe('runc');
    expect(hc.Memory).toBe(VALIDATION_LIMITS.SANDBOX_MEMORY_BYTES);
    expect(hc.NanoCpus).toBe(VALIDATION_LIMITS.SANDBOX_CPUS * 1_000_000_000);

    // tmpfs: /tmp noexec; $HOME exec (Docker mounts tmpfs noexec by default
    // even with an explicit options string -- without exec nothing installed
    // under $HOME, e.g. a runtime dotnet SDK, can run).
    expect(hc.Tmpfs?.['/tmp']).toContain('noexec');
    expect(hc.Tmpfs?.['/tmp']).toContain('nosuid');
    expect(hc.Tmpfs?.['/home/sandbox']).toContain('exec');
    expect(hc.Tmpfs?.['/home/sandbox']).not.toContain('noexec');
    // /work is a disk-backed anonymous volume (writable under the readonly
    // rootfs, exec by default, no RAM charge), removed with the container.
    // /cache is likewise a writable anonymous volume by default so toolchains
    // that point package managers at /cache always have somewhere to write.
    expect(hc.Tmpfs?.['/work']).toBeUndefined();
    expect(hc.Mounts).toEqual([
      { Target: '/work', Type: 'volume', Source: '' },
      { Target: '/cache', Type: 'volume', Source: '' },
    ]);
  });

  it('uses the no-egress network when egress is disabled', () => {
    const runner = new DockerSandboxRunner({
      sandboxConfig: devConfig({ enableEgress: false, egressNetwork: 'no-egress-net' }),
    });
    expect(runner.buildHostConfig().NetworkMode).toBe('no-egress-net');
  });

  it('uses bridge when egress is enabled', () => {
    const runner = new DockerSandboxRunner({
      sandboxConfig: devConfig({ enableEgress: true }),
    });
    expect(runner.buildHostConfig().NetworkMode).toBe('bridge');
  });

  it('selects runsc when configured', () => {
    const runner = new DockerSandboxRunner({
      sandboxConfig: devConfig({ runtime: 'runsc' }),
    });
    expect(runner.buildHostConfig().Runtime).toBe('runsc');
  });

  it('honors a custom pids limit', () => {
    const runner = new DockerSandboxRunner({
      sandboxConfig: devConfig({ pidsLimit: 512 }),
    });
    expect(runner.buildHostConfig().PidsLimit).toBe(512);
  });

  it('appends a read-only cache mount at /cache when given a cache volume', () => {
    const runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    const hc = runner.buildHostConfig({ cacheVolume: 'sutura-cache-abc', cacheReadOnly: true });

    expect(hc.Mounts).toEqual([
      { Target: '/work', Type: 'volume', Source: '' },
      { Target: '/cache', Type: 'volume', Source: 'sutura-cache-abc', ReadOnly: true },
    ]);
  });

  it('mounts the cache writable for prewarm (cacheReadOnly false)', () => {
    const runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    const hc = runner.buildHostConfig({ cacheVolume: 'sutura-cache-abc', cacheReadOnly: false });

    expect(hc.Mounts).toContainEqual({
      Target: '/cache',
      Type: 'volume',
      Source: 'sutura-cache-abc',
      ReadOnly: false,
    });
  });

  it('mounts a writable anonymous /cache when no cache volume is given', () => {
    const runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    expect(runner.buildHostConfig().Mounts).toEqual([
      { Target: '/work', Type: 'volume', Source: '' },
      { Target: '/cache', Type: 'volume', Source: '' },
    ]);
  });
});

describe('createWorkspace passes hardened HostConfig to dockerode', () => {
  // The tar-over-exec uploader (private putArchive) needs a live exec session;
  // stub it -- these tests guard HostConfig assembly and container lifecycle,
  // not the upload mechanics.
  function stubUpload(runner: DockerSandboxRunner, error?: Error) {
    const target = runner as unknown as {
      putArchive: (...args: unknown[]) => Promise<void>;
    };
    const spy = vi.spyOn(target, 'putArchive');
    return error ? spy.mockRejectedValue(error) : spy.mockResolvedValue(undefined);
  }

  it('forwards buildHostConfig output and ensures the no-egress network', async () => {
    const start = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    createContainer.mockResolvedValue({ id: 'cid', start, remove });

    const runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    const upload = stubUpload(runner);
    // A tiny non-gzip tar so stripTopLevelDir runs without error.
    await runner.createWorkspace(Buffer.from(''));

    expect(createContainer).toHaveBeenCalledTimes(1);
    const arg = createContainer.mock.calls[0][0];
    expect(arg.HostConfig.CapDrop).toEqual(['ALL']);
    expect(arg.HostConfig.ReadonlyRootfs).toBe(true);
    expect(arg.HostConfig.NetworkMode).toBe('no-egress-net');
    // best-effort no-egress network setup ran.
    expect(createNetwork).toHaveBeenCalledTimes(1);
    expect(createNetwork.mock.calls[0][0]).toMatchObject({
      Name: 'no-egress-net',
      Internal: true,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('forwards a read-only cache mount to dockerode when given a cache volume', async () => {
    const start = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    createContainer.mockResolvedValue({ id: 'cid', start, remove });

    const runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    stubUpload(runner);
    await runner.createWorkspace(Buffer.from(''), {
      cacheVolume: 'sutura-cache-abc',
      cacheReadOnly: true,
    });

    const arg = createContainer.mock.calls[0][0];
    expect(arg.HostConfig.Mounts).toContainEqual({
      Target: '/cache',
      Type: 'volume',
      Source: 'sutura-cache-abc',
      ReadOnly: true,
    });
  });

  it('removes the just-created container when the workspace upload fails', async () => {
    const start = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    createContainer.mockResolvedValue({ id: 'cid', start, remove });

    const runner = new DockerSandboxRunner({ sandboxConfig: devConfig() });
    stubUpload(runner, new Error('upload died'));

    await expect(runner.createWorkspace(Buffer.from(''))).rejects.toThrow('upload died');
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });
});

describe('production guard via getSandboxConfig (no Docker)', () => {
  it('production never selects raw socket / runc', () => {
    // runc in prod throws.
    expect(() =>
      getSandboxConfig({
        NODE_ENV: 'production',
        SANDBOX_RUNTIME: 'runc',
        DOCKER_SOCKET_PROXY_URL: 'tcp://p:2375',
      }),
    ).toThrow(/runc/);
    // raw socket in prod throws.
    expect(() =>
      getSandboxConfig({ NODE_ENV: 'production', SANDBOX_RUNTIME: 'runsc' }),
    ).toThrow(/raw Docker socket/);
    // safe prod config selects runsc + proxy.
    const cfg = getSandboxConfig({
      NODE_ENV: 'production',
      SANDBOX_RUNTIME: 'runsc',
      DOCKER_SOCKET_PROXY_URL: 'tcp://p:2375',
    });
    expect(cfg.runtime).toBe('runsc');
    expect(cfg.socketProxyUrl).toBe('tcp://p:2375');
  });
});
