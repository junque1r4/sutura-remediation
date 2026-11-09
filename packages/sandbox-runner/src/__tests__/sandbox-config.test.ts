import { describe, expect, it } from 'vitest';
import {
  assertProductionSafe,
  dockerConnectionFromConfig,
  getDockerConnectionOptions,
  getSandboxConfig,
  SANDBOX_DEFAULTS,
  type SandboxConfig,
} from '../sandbox-config';

/**
 * getSandboxConfig() takes an env object so we can exercise parsing and the
 * production guard without mutating process.env. None of these touch Docker.
 */

describe('getSandboxConfig - dev/CI defaults', () => {
  it('keeps legacy-safe defaults when nothing is set (NODE_ENV unset)', () => {
    const cfg = getSandboxConfig({});
    expect(cfg.runtime).toBe('runc');
    expect(cfg.enableEgress).toBe(false);
    expect(cfg.egressNetwork).toBe(SANDBOX_DEFAULTS.egressNetwork);
    expect(cfg.pidsLimit).toBe(SANDBOX_DEFAULTS.pidsLimit);
    expect(cfg.socketProxyUrl).toBeUndefined();
    expect(cfg.socketPath).toBe(SANDBOX_DEFAULTS.rawDockerSocket);
    expect(cfg.httpProxy).toBeUndefined();
    expect(cfg.httpsProxy).toBeUndefined();
  });

  it('does not throw in dev/CI even with runc + raw socket', () => {
    expect(() => getSandboxConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => getSandboxConfig({ NODE_ENV: 'test' })).not.toThrow();
  });
});

describe('getSandboxConfig - env parsing', () => {
  it('parses runtime, egress, network, pids, and proxies', () => {
    const cfg = getSandboxConfig({
      SANDBOX_RUNTIME: 'runsc',
      SANDBOX_ENABLE_EGRESS: 'true',
      SANDBOX_EGRESS_NETWORK: 'my-net',
      SANDBOX_PIDS_LIMIT: '512',
      HTTP_PROXY: 'http://proxy:3128',
      HTTPS_PROXY: 'http://proxy:3129',
      DOCKER_SOCKET_PROXY_URL: 'tcp://socket-proxy:2375',
    });
    expect(cfg.runtime).toBe('runsc');
    expect(cfg.enableEgress).toBe(true);
    expect(cfg.egressNetwork).toBe('my-net');
    expect(cfg.pidsLimit).toBe(512);
    expect(cfg.httpProxy).toBe('http://proxy:3128');
    expect(cfg.httpsProxy).toBe('http://proxy:3129');
    expect(cfg.socketProxyUrl).toBe('tcp://socket-proxy:2375');
  });

  it('accepts boolean-ish egress values and falls back on garbage', () => {
    expect(getSandboxConfig({ SANDBOX_ENABLE_EGRESS: '1' }).enableEgress).toBe(true);
    expect(getSandboxConfig({ SANDBOX_ENABLE_EGRESS: 'yes' }).enableEgress).toBe(true);
    expect(getSandboxConfig({ SANDBOX_ENABLE_EGRESS: '0' }).enableEgress).toBe(false);
    expect(getSandboxConfig({ SANDBOX_ENABLE_EGRESS: 'nope' }).enableEgress).toBe(false);
  });

  it('falls back to default pids limit on a non-positive value', () => {
    expect(getSandboxConfig({ SANDBOX_PIDS_LIMIT: 'abc' }).pidsLimit).toBe(
      SANDBOX_DEFAULTS.pidsLimit,
    );
    expect(getSandboxConfig({ SANDBOX_PIDS_LIMIT: '0' }).pidsLimit).toBe(
      SANDBOX_DEFAULTS.pidsLimit,
    );
  });

  it('ignores an invalid runtime value and falls back per environment', () => {
    expect(getSandboxConfig({ SANDBOX_RUNTIME: 'bogus' }).runtime).toBe('runc');
    expect(
      getSandboxConfig({ SANDBOX_RUNTIME: 'bogus', NODE_ENV: 'production', DOCKER_SOCKET_PROXY_URL: 'tcp://p:2375' })
        .runtime,
    ).toBe('runsc');
  });
});

describe('getSandboxConfig - production guard', () => {
  it('defaults to runsc in production', () => {
    const cfg = getSandboxConfig({
      NODE_ENV: 'production',
      DOCKER_SOCKET_PROXY_URL: 'tcp://socket-proxy:2375',
    });
    expect(cfg.runtime).toBe('runsc');
  });

  it('throws in production when runtime is runc', () => {
    expect(() =>
      getSandboxConfig({
        NODE_ENV: 'production',
        SANDBOX_RUNTIME: 'runc',
        DOCKER_SOCKET_PROXY_URL: 'tcp://socket-proxy:2375',
      }),
    ).toThrow(/runc/);
  });

  it('throws in production when using the raw docker socket with no proxy', () => {
    expect(() =>
      getSandboxConfig({
        NODE_ENV: 'production',
        SANDBOX_RUNTIME: 'runsc',
      }),
    ).toThrow(/raw Docker socket/);
  });

  it('passes in production with runsc + socket proxy', () => {
    expect(() =>
      getSandboxConfig({
        NODE_ENV: 'production',
        SANDBOX_RUNTIME: 'runsc',
        DOCKER_SOCKET_PROXY_URL: 'tcp://socket-proxy:2375',
      }),
    ).not.toThrow();
  });
});

describe('docker connection options', () => {
  it('uses the unix socket path when no proxy is configured', () => {
    const opts = getDockerConnectionOptions({});
    expect(opts.socketPath).toBe(SANDBOX_DEFAULTS.rawDockerSocket);
    expect(opts.host).toBeUndefined();
  });

  it('uses the proxy host/port when DOCKER_SOCKET_PROXY_URL is set', () => {
    const opts = getDockerConnectionOptions({ DOCKER_SOCKET_PROXY_URL: 'tcp://docker-socket-proxy:2375' });
    expect(opts).toEqual({ host: 'docker-socket-proxy', port: 2375, protocol: 'http' });
    expect(opts.socketPath).toBeUndefined();
  });

  it('defaults the proxy port to 2375 when omitted', () => {
    const opts = dockerConnectionFromConfig({
      runtime: 'runc',
      socketProxyUrl: 'tcp://proxy',
      socketPath: '/var/run/docker.sock',
      enableEgress: false,
      egressNetwork: 'no-egress-net',
      pidsLimit: 256,
    });
    expect(opts.host).toBe('proxy');
    expect(opts.port).toBe(2375);
  });
});

describe('assertProductionSafe', () => {
  const base: SandboxConfig = {
    runtime: 'runsc',
    socketProxyUrl: 'tcp://socket-proxy:2375',
    socketPath: '/var/run/docker.sock',
    enableEgress: false,
    egressNetwork: 'no-egress-net',
    pidsLimit: 256,
  };

  it('accepts a safe config', () => {
    expect(() => assertProductionSafe(base)).not.toThrow();
  });

  it('rejects runc', () => {
    expect(() => assertProductionSafe({ ...base, runtime: 'runc' })).toThrow(/runc/);
  });

  it('rejects raw socket without a proxy', () => {
    expect(() =>
      assertProductionSafe({ ...base, socketProxyUrl: undefined }),
    ).toThrow(/raw Docker socket/);
  });
});
