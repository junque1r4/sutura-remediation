/**
 * Sandbox hardening configuration.
 *
 * Centralizes the knobs that control how the validated-fix worker spawns its
 * sibling sandbox containers: container runtime (gVisor runsc vs runc), Docker
 * socket access (raw socket vs least-privilege proxy), egress policy
 * (no-egress network vs bridge + outbound proxy), and per-container caps.
 *
 * DESIGN: every knob is default-safe for dev/CI. With no env vars set and
 * NODE_ENV !== 'production' the resolved config keeps the historical behavior
 * (runc, bridge for install, isolated network for tests) so existing tests and
 * local runs work without gVisor, a socket proxy, or a real Docker daemon.
 *
 * The production guard only fires when NODE_ENV === 'production': it refuses to
 * boot a sandbox config that would run untrusted patches under the host's runc
 * with raw socket access -- a single sandbox escape would then be host root.
 */

export type SandboxRuntime = 'runsc' | 'runc';

export interface SandboxConfig {
  /** OCI runtime passed to dockerode HostConfig.Runtime. */
  runtime: SandboxRuntime;
  /**
   * dockerode connection target. When DOCKER_SOCKET_PROXY_URL is set we talk
   * to the least-privilege proxy over TCP; otherwise we fall back to a unix
   * socket path (raw daemon access). socketProxyUrl is mutually exclusive with
   * socketPath at the dockerode layer; the runner prefers the proxy when set.
   */
  socketProxyUrl?: string;
  /** Unix socket path used only when no proxy URL is configured. */
  socketPath: string;
  /**
   * When false (default), sandbox containers run on a no-egress bridge network
   * so even the install step cannot reach the internet unless an outbound proxy
   * is configured. When true, containers attach to the standard 'bridge'
   * network with full egress (legacy behavior).
   */
  enableEgress: boolean;
  /** Name of the user-defined no-egress network created by setup-sandbox.sh. */
  egressNetwork: string;
  /** Optional outbound proxy injected into sandbox env for allow-listed egress. */
  httpProxy?: string;
  httpsProxy?: string;
  /** Max number of processes per sandbox container (fork-bomb guard). */
  pidsLimit: number;
  /**
   * tmpfs size cap in MiB for $HOME (/work is a disk-backed anonymous volume
   * and needs no cap). The default suits node/python repos; heavyweight
   * toolchains (a .NET SDK install plus NuGet cache lives under $HOME) need
   * more. tmpfs is lazily allocated, so this is a cap, not a reservation --
   * but the pages ARE charged to the container memory limit, so raise
   * SUTURA_SANDBOX_MEMORY_BYTES alongside it.
   */
  homeTmpfsMb?: number;
  /**
   * Ceiling in MiB for /work usage. When set, the runner fails a step if /work
   * grows past it, so untrusted build code can't fill the host disk (the volume
   * is uncapped). Unset = no check.
   */
  workDiskCeilingMb?: number;
  /**
   * Hosts the restore phase is allowed to reach (e.g. nuget.org, npm registry,
   * the repo's private feed). Advisory unless an outbound filtering proxy is
   * configured (httpProxy/httpsProxy): with a proxy, this is injected as
   * NO_PROXY so only these hosts bypass it; build+test run with no network at
   * all regardless.
   */
  egressAllowlist?: string[];
}

const DEFAULT_EGRESS_NETWORK = 'no-egress-net';
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_HOME_TMPFS_MB = 1024;
const RAW_DOCKER_SOCKET = '/var/run/docker.sock';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the sandbox hardening config from the environment.
 *
 * Throws ONLY in production when the resolved config would be unsafe:
 *   - runtime is 'runc' (no gVisor isolation for untrusted patches), or
 *   - no socket proxy is configured and the unix socket is the raw daemon
 *     socket (full host Docker control from the backend container).
 *
 * In dev/CI it never throws, so unit tests and local runs work unchanged.
 */
export function getSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const prod = env.NODE_ENV === 'production';

  const runtimeRaw = env.SANDBOX_RUNTIME?.trim();
  const runtime: SandboxRuntime =
    runtimeRaw === 'runsc' || runtimeRaw === 'runc'
      ? runtimeRaw
      : prod
        ? 'runsc'
        : 'runc';

  const socketProxyUrl = env.DOCKER_SOCKET_PROXY_URL?.trim() || undefined;
  const socketPath = env.DOCKER_SOCKET_PATH?.trim() || RAW_DOCKER_SOCKET;

  const enableEgress = parseBool(env.SANDBOX_ENABLE_EGRESS, false);
  const egressNetwork = env.SANDBOX_EGRESS_NETWORK?.trim() || DEFAULT_EGRESS_NETWORK;

  const httpProxy = env.HTTP_PROXY?.trim() || env.http_proxy?.trim() || undefined;
  const httpsProxy = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || undefined;

  const pidsLimit = parsePositiveInt(env.SANDBOX_PIDS_LIMIT, DEFAULT_PIDS_LIMIT);
  const homeTmpfsMb = parsePositiveInt(env.SANDBOX_HOME_TMPFS_MB, DEFAULT_HOME_TMPFS_MB);
  const workDiskCeilingMb = env.SANDBOX_WORK_DISK_CEILING_MB
    ? parsePositiveInt(env.SANDBOX_WORK_DISK_CEILING_MB, 0) || undefined
    : undefined;
  const egressAllowlist = env.SANDBOX_EGRESS_ALLOWLIST
    ? env.SANDBOX_EGRESS_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const config: SandboxConfig = {
    runtime,
    socketProxyUrl,
    socketPath,
    enableEgress,
    egressNetwork,
    httpProxy,
    httpsProxy,
    pidsLimit,
    homeTmpfsMb,
    workDiskCeilingMb,
    egressAllowlist,
  };

  if (prod) {
    assertProductionSafe(config);
  }

  return config;
}

/**
 * Production-only guard. Refuses configs that defeat sandbox isolation:
 *   - runc (no kernel isolation between untrusted patch code and the host), or
 *   - raw /var/run/docker.sock access with no least-privilege proxy in front.
 */
export function assertProductionSafe(config: SandboxConfig): void {
  if (config.runtime === 'runc') {
    throw new Error(
      'Unsafe sandbox config: SANDBOX_RUNTIME=runc in production. ' +
        'Use the gVisor runtime (SANDBOX_RUNTIME=runsc) so untrusted patches ' +
        'run under kernel isolation. See scripts/setup-sandbox.sh.',
    );
  }
  if (!config.socketProxyUrl && config.socketPath === RAW_DOCKER_SOCKET) {
    throw new Error(
      `Unsafe sandbox config: raw Docker socket (${RAW_DOCKER_SOCKET}) in production. ` +
        'Route container operations through the least-privilege docker-socket-proxy ' +
        '(set DOCKER_SOCKET_PROXY_URL) instead of bind-mounting the host daemon socket.',
    );
  }
}

/**
 * dockerode connection options derived from the sandbox config: the
 * least-privilege proxy (host/port over TCP) when DOCKER_SOCKET_PROXY_URL is
 * set, otherwise the unix socket path. Use this everywhere a Docker client is
 * constructed so the proxy and the production guard apply uniformly -- not just
 * inside DockerSandboxRunner.
 */
export interface DockerConnectionOptions {
  host?: string;
  port?: number;
  protocol?: 'http';
  socketPath?: string;
}

/** Build dockerode connection options from an already-resolved config. */
export function dockerConnectionFromConfig(config: SandboxConfig): DockerConnectionOptions {
  if (config.socketProxyUrl) {
    // dockerode accepts host/port for TCP; normalize tcp:// and http:// forms.
    const parsed = new URL(config.socketProxyUrl.replace(/^tcp:\/\//, 'http://'));
    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 2375,
      protocol: 'http',
    };
  }
  return { socketPath: config.socketPath };
}

/**
 * Resolve dockerode connection options straight from the environment. Routes
 * through the socket proxy when configured and enforces the production guard
 * (no raw socket in prod) via getSandboxConfig().
 */
export function getDockerConnectionOptions(
  env: NodeJS.ProcessEnv = process.env,
): DockerConnectionOptions {
  return dockerConnectionFromConfig(getSandboxConfig(env));
}

/** Exposed for tests and the production guard. */
export const SANDBOX_DEFAULTS = {
  egressNetwork: DEFAULT_EGRESS_NETWORK,
  pidsLimit: DEFAULT_PIDS_LIMIT,
  rawDockerSocket: RAW_DOCKER_SOCKET,
} as const;

export { isProduction as isSandboxProduction };
