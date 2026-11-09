import Docker from 'dockerode';
import { Readable, PassThrough } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar-stream';
import { VALIDATION_LIMITS } from '@sutura/common';
import type {
  ApplyPatchResult,
  CreateWorkspaceOpts,
  ExecOpts,
  FileWrite,
  RunResult,
  SandboxRunner,
  WorkspaceHandle,
  DetectedToolchain,
} from './types';
import { detectToolchainFromManifests, MANIFEST_FILES } from './toolchain-detect';
import {
  readTopLevelManifestsFromTar,
  getCacheVolumeManifest,
  recreateCacheVolume,
} from './cache-volume';
import { toDetectedToolchain } from './toolchain-override';
import { recountUnifiedDiff, reconcileLeadingBom, stripReadFileLineNumbers } from './diff-normalize';
import { shellEscape } from './shell-escape';
import { getSandboxConfig, type SandboxConfig } from './sandbox-config';

const ROOT_PATH = '/work';
// Writable, exec-capable HOME for tools that insist on writing under $HOME
// (semgrep -> ~/.semgrep, gradle -> ~/.gradle + native libs). The rootfs is
// read-only and the default HOME=/root is therefore unwritable, which crashes
// those tools ("Read-only file system: '/root/.semgrep'"). Backed by a tmpfs
// mounted WITHOUT noexec so gradle can dlopen its bundled native library.
const HOME_PATH = '/home/sandbox';
// Mount point for the per-repo dependency cache volume. Lives OUTSIDE /work (an
// anonymous per-attempt volume) so the cache survives across attempts and is
// mounted read-only on attempts -- untrusted patch code under /work can read
// but never write it. Toolchains point package-manager caches here.
const CACHE_PATH = '/cache';
const SUTURA_LABEL = 'sutura.sandbox';

// Per-invocation git identity for snapshot/reset commits. Passed with `-c`
// because the sandbox runs as an unprivileged user with a tmpfs HOME, so the
// base image's global git config is not visible at runtime.
const GIT_IDENTITY =
  "-c user.email=sutura-sandbox@sutura.local -c user.name='Sutura Sandbox' -c core.autocrlf=false";

export interface DockerSandboxRunnerOpts {
  /** dockerode socket path; defaults to /var/run/docker.sock. */
  socketPath?: string;
  /** Override base workspace image (defaults are picked by toolchain). */
  defaultImage?: string;
  /** Container name prefix; useful for tests / debugging. */
  containerPrefix?: string;
  /**
   * Sandbox hardening config. Defaults to getSandboxConfig() (env-driven).
   * Injectable for unit tests that assert HostConfig assembly without Docker.
   */
  sandboxConfig?: SandboxConfig;
}

/**
 * Spawns sibling containers via the host's Docker socket and exec's commands
 * inside them. The workspace container stays alive across exec calls so that
 * /work persists between install -> tests -> scan.
 */
export class DockerSandboxRunner implements SandboxRunner {
  private docker: Docker;
  private defaultImage: string;
  private prefix: string;
  private config: SandboxConfig;
  /** Lazily ensure the no-egress network exists at most once per runner. */
  private noEgressNetworkReady?: Promise<void>;
  /** Per-workspace developer-taught toolchains (keyed by container id);
   *  consulted before manifest detection and dropped on cleanup. */
  private readonly toolchainOverrides = new Map<string, DetectedToolchain>();

  constructor(opts: DockerSandboxRunnerOpts = {}) {
    // Resolve hardening config first; getSandboxConfig() enforces the
    // production safety guard (no runc / raw socket in prod) but is a no-op in
    // dev/CI so the constructor never throws there.
    this.config = opts.sandboxConfig ?? getSandboxConfig();
    // Prefer the least-privilege socket proxy when configured; otherwise fall
    // back to the unix socket path. An explicit opts.socketPath wins for tests.
    const explicitSocket = opts.socketPath ?? this.config.socketPath;
    this.docker = this.config.socketProxyUrl
      ? new Docker(parseDockerHost(this.config.socketProxyUrl))
      : new Docker({ socketPath: explicitSocket });
    this.defaultImage = opts.defaultImage ?? 'sutura/sandbox-base:latest';
    this.prefix = opts.containerPrefix ?? 'sutura-sbx';
  }

  /**
   * Assemble the HostConfig for the long-lived workspace container from the
   * resolved sandbox config. Split out so unit tests can assert the hardened
   * fields (CapDrop, ReadonlyRootfs, PidsLimit, Tmpfs, Runtime, NetworkMode)
   * without touching Docker.
   */
  buildHostConfig(cache?: { cacheVolume?: string; cacheReadOnly?: boolean }): Docker.HostConfig {
    const mounts: Docker.MountSettings[] = [
      { Target: ROOT_PATH, Type: 'volume', Source: '' },
    ];
    if (cache?.cacheVolume) {
      // Warm path: the prewarmed per-repo cache, read-only on attempts.
      mounts.push({
        Target: CACHE_PATH,
        Type: 'volume',
        Source: cache.cacheVolume,
        ReadOnly: cache.cacheReadOnly ?? true,
      });
    } else {
      // No warm cache (prewarm off / failed / non-prewarm run): still expose a
      // WRITABLE /cache (disk-backed anonymous volume) so toolchains that point
      // package managers at /cache (e.g. NUGET_PACKAGES=/cache/nuget) work --
      // the networked restore populates it for this run; it's removed with the
      // container. Without this, /cache wouldn't exist under the read-only
      // rootfs and the restore would fail.
      mounts.push({ Target: CACHE_PATH, Type: 'volume', Source: '' });
    }
    return {
      AutoRemove: false,
      // No egress by default: untrusted patch code runs on a network with no
      // route off-host. Install (which needs the registry) opts into 'bridge'
      // only when SANDBOX_ENABLE_EGRESS is true.
      NetworkMode: this.config.enableEgress ? 'bridge' : this.config.egressNetwork,
      // gVisor (runsc) in production interposes a userspace kernel between the
      // sandbox and the host; runc (default) in dev/CI keeps existing behavior.
      Runtime: this.config.runtime,
      Memory: VALIDATION_LIMITS.SANDBOX_MEMORY_BYTES,
      // NanoCpus is an integer count of nanocores (1 CPU = 1e9). At 2 CPUs
      // this is 2e9, well within Number.MAX_SAFE_INTEGER, so no BigInt --
      // dockerode JSON.stringifies the body and chokes on BigInt.
      NanoCpus: VALIDATION_LIMITS.SANDBOX_CPUS * 1_000_000_000,
      // Fork-bomb guard.
      PidsLimit: this.config.pidsLimit,
      // Drop every Linux capability; the sandbox only needs to read/patch/build
      // files, none of which require privileged caps.
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      // Immutable rootfs: the only writable surfaces are /work (the workspace,
      // a tmpfs-backed writable layer via the anonymous mount below is not
      // needed because /work lives on the container's writable layer which we
      // keep writable by NOT marking it readonly) and /tmp (tmpfs, noexec).
      ReadonlyRootfs: true,
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=256m',
        // $HOME needs the explicit `exec` flag: Docker mounts tmpfs noexec by
        // default EVEN when an options string is given, which breaks anything
        // that executes from it -- gradle dlopens a native library from under
        // $HOME, and a runtime-installed dotnet SDK lives there. Isolation
        // comes from the container boundary (CapDrop, no-new-privileges,
        // gVisor in prod), not noexec. Sized via SANDBOX_HOME_TMPFS_MB:
        // toolchain caches (NuGet, semgrep settings) need far more than the
        // old 256m for heavyweight ecosystems. tmpfs pages are charged to the
        // container memory cap -- keep SUTURA_SANDBOX_MEMORY_BYTES above this.
        [HOME_PATH]: `rw,exec,nosuid,size=${this.config.homeTmpfsMb ?? 1024}m`,
      },
      // /work must be writable for putArchive + patch + build outputs (the
      // ReadonlyRootfs flag freezes the container's own writable layer). It
      // used to be tmpfs, but repo + node_modules + Release build artifacts
      // easily run to gigabytes, and tmpfs is RAM charged against the memory
      // cap. An anonymous volume is disk-backed, uncapped, exec-enabled by
      // default, and removed with the container (cleanup passes v: true).
      // Empty Source = anonymous volume (dockerode's type requires the field;
      // the daemon treats '' as "create one for me"). A per-repo cache volume
      // is appended above when one is supplied (read-only on attempts).
      Mounts: mounts,
    };
  }

  /**
   * Assemble the exec Env array. When an egress-granting step (install) runs
   * under the no-egress default and an outbound proxy is configured, inject
   * HTTP(S)_PROXY so the allow-listed proxy is the only route out. Caller env
   * always wins over the injected proxy vars.
   */
  private buildExecEnv(opts: ExecOpts, grantEgress: boolean): string[] | undefined {
    const merged: Record<string, string> = {};
    if (grantEgress) {
      if (this.config.httpProxy) {
        merged.HTTP_PROXY = this.config.httpProxy;
        merged.http_proxy = this.config.httpProxy;
      }
      if (this.config.httpsProxy) {
        merged.HTTPS_PROXY = this.config.httpsProxy;
        merged.https_proxy = this.config.httpsProxy;
      }
      // With an outbound proxy in place, the allowlist is the set of hosts that
      // bypass it (everything else has no route out). Without a proxy this is
      // advisory only -- build/test still run with no network regardless.
      if ((this.config.httpProxy || this.config.httpsProxy) && this.config.egressAllowlist?.length) {
        merged.NO_PROXY = this.config.egressAllowlist.join(',');
        merged.no_proxy = merged.NO_PROXY;
      }
    }
    if (opts.env) Object.assign(merged, opts.env);
    const entries = Object.entries(merged);
    return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`) : undefined;
  }

  async createWorkspace(repoTarball: Buffer, opts?: CreateWorkspaceOpts): Promise<WorkspaceHandle> {
    // Best-effort ensure the no-egress network exists before we attach to it.
    // Tolerates a missing/unavailable daemon (catch inside).
    if (!this.config.enableEgress) await this.ensureNoEgressNetwork();

    // Strip the GitHub tarball's single top-level dir so files land directly
    // under /work, then pick the workspace image from the repo's manifests
    // (package.json -> node, build.gradle -> java, ...). Every language image
    // extends sandbox-base, so the detected image is a strict superset;
    // resolveImage() falls back to base when that image isn't built on the host.
    const stripped = await stripTopLevelDir(repoTarball);
    // A developer-taught toolchain pins the image (already allowlist-validated
    // upstream); otherwise pick it from the repo's manifests.
    const image = await this.resolveImage(
      opts?.toolchainOverride
        ? opts.toolchainOverride.image
        : await detectImageFromTar(stripped).catch(() => this.defaultImage),
    );

    // Start a long-lived container that just sleeps; we'll exec commands into it.
    const name = `${this.prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const container = await this.docker.createContainer({
      name,
      Image: image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: ROOT_PATH,
      // Point HOME at the writable tmpfs so $HOME-writing tools (semgrep, gradle)
      // don't hit the read-only rootfs. Exec sessions inherit the container env.
      Env: [`HOME=${HOME_PATH}`],
      Labels: { [SUTURA_LABEL]: '1' },
      HostConfig: this.buildHostConfig({
        cacheVolume: opts?.cacheVolume,
        cacheReadOnly: opts?.cacheReadOnly,
      }),
    });
    await container.start();

    try {
      await this.putArchive(container, stripped, { path: ROOT_PATH });
    } catch (err) {
      // Upload failed -- remove the just-created container so a failed workspace
      // setup doesn't leak a running sandbox container on the host.
      await container.remove({ force: true, v: true }).catch(() => {});
      throw err;
    }

    if (opts?.toolchainOverride) {
      this.toolchainOverrides.set(container.id, toDetectedToolchain(opts.toolchainOverride));
    }

    return { id: container.id, image, rootPath: ROOT_PATH };
  }

  /**
   * Use the toolchain-specific image when it's actually present on the host,
   * otherwise fall back to the base image. Optional images (go/ruby/java) may
   * not be built on every host; falling back to base avoids a "No such image"
   * createContainer failure -- the step needing the missing tool then fails with
   * a clear error instead of the whole workspace setup blowing up.
   */
  private async resolveImage(preferred: string): Promise<string> {
    if (preferred === this.defaultImage) return preferred;
    try {
      await this.docker.getImage(preferred).inspect();
      return preferred;
    } catch {
      return this.defaultImage;
    }
  }

  async detectToolchain(ws: WorkspaceHandle): Promise<DetectedToolchain> {
    const override = this.toolchainOverrides.get(ws.id);
    if (override) return override;
    const manifests: Record<string, string | null> = {};
    for (const path of MANIFEST_FILES) {
      manifests[path] = await this.tryReadFile(ws, path);
    }
    return detectToolchainFromManifests(manifests);
  }

  async applyPatch(ws: WorkspaceHandle, unifiedDiff: string): Promise<ApplyPatchResult> {
    // Ensure trailing newline -- both `git apply` and `patch` reject diffs
    // that end mid-line ("malformed patch at line N: <body>"), and the LLM
    // sometimes drops the final \n. Then recompute the hunk-header counts:
    // the LLM also gets those wrong, and neither applier tolerates that
    // (see diff-normalize.ts for why `git apply --recount` is not the answer).
    const withNewline = unifiedDiff.endsWith('\n') ? unifiedDiff : unifiedDiff + '\n';
    return this.applyPatchInner(ws, recountUnifiedDiff(withNewline));
  }

  private async applyPatchInner(
    ws: WorkspaceHandle,
    unifiedDiff: string,
  ): Promise<ApplyPatchResult> {
    // Stage the diff to /tmp/sutura.patch then try two appliers in series.
    // The base image runs `git init -q .` at /work during build so we don't
    // re-init; we also skip `git add -A` (which on a 100+ MB workspace can
    // take minutes and exceed our exec timeout).
    //
    // Strategy (hunk counts are already corrected by recountUnifiedDiff --
    // do NOT add `git apply --recount`: it ignores the declared counts and in
    // multi-file patches absorbs the next `--- a/...` header into the prior
    // hunk, rejecting diffs that are otherwise perfect):
    //   1. `git apply --ignore-whitespace --whitespace=nowarn`
    //   2. `patch -p1 --batch --forward --no-backup-if-mismatch` (POSIX)
    //      -- recovers when git apply rejects on context drift.
    // Returns ok on first success; otherwise reports the *git* error since
    // it's usually the more actionable of the two.
    const GIT_CMD = 'git apply --ignore-whitespace --whitespace=nowarn /tmp/sutura.patch';
    const PATCH_CMD = 'patch -p1 --batch --forward --no-backup-if-mismatch < /tmp/sutura.patch';

    await this.writeFiles(ws, [{ path: '/tmp/sutura.patch', content: unifiedDiff }]);
    const gitRes = await this.exec(
      ws,
      ['sh', '-lc', GIT_CMD],
      VALIDATION_LIMITS.PATCH_TIMEOUT_MS,
    );
    if (gitRes.exitCode === 0) return { ok: true, command: GIT_CMD };

    const patchRes = await this.exec(
      ws,
      ['sh', '-lc', PATCH_CMD],
      VALIDATION_LIMITS.PATCH_TIMEOUT_MS,
    );
    if (patchRes.exitCode === 0) return { ok: true, command: PATCH_CMD };

    // Repair pass (fallback only): the fix agent mangles the diff body in two
    // recurring ways that make both appliers reject the whole patch --
    //   (1) it copies read_file's `<n>\t`/`<n>$\t` line-number prefix into the
    //       removed/context lines, and
    //   (2) it drops the file's leading UTF-8 BOM on the first line.
    // Strip the prefixes, then reconcile the BOM against the file's actual
    // first line, and retry. Self-validating: only runs after a real failure
    // and only accepted if an applier now succeeds, so a well-formed diff is
    // never altered and a mis-repair can't turn a pass into a fail.
    const lineStripped = stripReadFileLineNumbers(unifiedDiff);
    const firstLines = await this.firstLinesForDiff(ws, lineStripped);
    const repaired = reconcileLeadingBom(lineStripped, (p) => firstLines.get(p) ?? null);
    if (repaired !== unifiedDiff) {
      await this.writeFiles(ws, [{ path: '/tmp/sutura.patch', content: repaired }]);
      const gitRes2 = await this.exec(ws, ['sh', '-lc', GIT_CMD], VALIDATION_LIMITS.PATCH_TIMEOUT_MS);
      if (gitRes2.exitCode === 0) {
        return { ok: true, command: `${GIT_CMD} (after diff repair)` };
      }
      const patchRes2 = await this.exec(ws, ['sh', '-lc', PATCH_CMD], VALIDATION_LIMITS.PATCH_TIMEOUT_MS);
      if (patchRes2.exitCode === 0) {
        return { ok: true, command: `${PATCH_CMD} (after diff repair)` };
      }
    }

    const combined = [
      `git apply: ${`${gitRes.stdout}\n${gitRes.stderr}`.trim()}`,
      `patch: ${`${patchRes.stdout}\n${patchRes.stderr}`.trim()}`,
    ].join('\n---\n');
    return { ok: false, rejects: combined, command: `${GIT_CMD}; then ${PATCH_CMD}` };
  }

  /**
   * Read the actual first line (BOM preserved) of every file targeted by a
   * diff's `+++` headers. Used only by the BOM repair pass, so it runs at most
   * once per failed apply over the handful of files a fix touches. `sed -n '1p'`
   * is passed as argv (no shell), so paths are never interpolated into a command
   * string. A read failure maps to `null` (the reconcile pass treats it as "no
   * info" and leaves that section untouched).
   */
  private async firstLinesForDiff(
    ws: WorkspaceHandle,
    diff: string,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const paths = new Set<string>();
    for (const line of diff.split('\n')) {
      if (!line.startsWith('+++ ')) continue;
      const raw = line.slice(4).split('\t')[0].trim();
      if (!raw || raw === '/dev/null') continue;
      paths.add(raw.replace(/^b\//, ''));
    }
    for (const path of paths) {
      try {
        const res = await this.exec(ws, ['sed', '-n', '1p', path], VALIDATION_LIMITS.PATCH_TIMEOUT_MS);
        if (res.exitCode === 0) out.set(path, res.stdout.split('\n')[0] ?? '');
      } catch {
        // Treated as "no info" by the reconcile pass.
      }
    }
    return out;
  }

  async snapshotTree(ws: WorkspaceHandle): Promise<void> {
    // Commit the whole /work tree (the base image already ran `git init`). Taken
    // once after the clean restore so remediation rounds can revert to it. We
    // commit AFTER restore so resolved dependency/build caches are tracked and
    // survive `git reset --hard`. `-A` stages deletions too; `--allow-empty`
    // keeps it from failing on a pristine tree.
    //
    // The identity is passed per-invocation with `-c`: the sandbox runs as an
    // unprivileged user with a tmpfs HOME, so the image's *global* git identity
    // is not visible at runtime and a bare `git commit` aborts with "Please tell
    // me who you are". `core.autocrlf=false` keeps the snapshot byte-exact (and
    // silences CRLF normalization warnings on Windows-authored repos).
    const cmd =
      `git ${GIT_IDENTITY} add -A && ` +
      `git ${GIT_IDENTITY} commit -q -m sutura-round-snapshot --allow-empty --no-verify`;
    const res = await this.exec(ws, ['sh', '-lc', cmd], VALIDATION_LIMITS.PATCH_TIMEOUT_MS);
    if (res.exitCode !== 0) {
      throw new Error(`snapshotTree failed: ${`${res.stdout}\n${res.stderr}`.trim()}`);
    }
  }

  async resetTree(ws: WorkspaceHandle): Promise<void> {
    // Revert tracked source edits to the snapshot and remove untracked files the
    // round left behind (e.g. a newly added .cs the patch created, or fresh
    // build output). Tracked caches committed by snapshotTree are restored by
    // reset, so the tree stays warm.
    const cmd = `git ${GIT_IDENTITY} reset --hard -q HEAD && git ${GIT_IDENTITY} clean -fdq`;
    const res = await this.exec(ws, ['sh', '-lc', cmd], VALIDATION_LIMITS.PATCH_TIMEOUT_MS);
    if (res.exitCode !== 0) {
      throw new Error(`resetTree failed: ${`${res.stdout}\n${res.stderr}`.trim()}`);
    }
  }

  async writeFiles(ws: WorkspaceHandle, files: FileWrite[]): Promise<void> {
    if (files.length === 0) return;
    const container = this.docker.getContainer(ws.id);
    const pack = tar.pack();
    for (const f of files) {
      // putArchive paths are relative to the destination; for /tmp paths we
      // upload to / instead.
      pack.entry({ name: stripLeadingSlash(f.path), mode: 0o644 }, f.content);
    }
    pack.finalize();
    const buf = await streamToBuffer(pack);
    // Decide destination: if any path is absolute we upload to / .
    const allAbsolute = files.every((f) => f.path.startsWith('/'));
    const dest = allAbsolute ? '/' : ws.rootPath;
    await this.putArchive(container, buf, { path: dest });
  }

  /**
   * Upload a tar archive into the container by piping it to `tar -x` over the
   * command's stdin, instead of dockerode's `container.putArchive` (PUT
   * /archive). Docker rejects putArchive on a `ReadonlyRootfs: true` container
   * ("container rootfs is marked read-only") even when the destination is a
   * writable tmpfs/volume mount -- a tar process writing into that mount is not
   * subject to that check. Reuses `exec`, which already bounds the work with a
   * timeout and demuxes stdout/stderr, so a dead connection can't hang the job.
   */
  private async putArchive(
    container: Docker.Container,
    data: Buffer,
    opts: { path: string },
  ): Promise<void> {
    const ws: WorkspaceHandle = {
      id: container.id,
      image: this.defaultImage,
      rootPath: ROOT_PATH,
    };
    const res = await this.exec(
      ws,
      ['tar', '-xf', '-', '-C', opts.path],
      VALIDATION_LIMITS.PUT_ARCHIVE_TIMEOUT_MS,
      { input: data, cwd: '/' },
    );
    if (res.timedOut) {
      throw new Error(`tar upload to ${opts.path} timed out`);
    }
    if (res.exitCode !== 0) {
      throw new Error(
        `tar upload to ${opts.path} failed (exit ${res.exitCode}): ${res.stderr || res.stdout || 'no output'}`,
      );
    }
  }

  async readFile(ws: WorkspaceHandle, path: string): Promise<string> {
    const out = await this.exec(ws, ['cat', resolvePath(ws, path)], 10_000);
    if (out.exitCode !== 0) throw new Error(`readFile failed: ${out.stderr}`);
    return out.stdout;
  }

  /**
   * Dependency-resolution phase. Normally the ONLY runner method that grants
   * network egress (isolateNetwork:false): it runs the package manager
   * (restoreCmd) and nothing else -- build and test always go through
   * runTests() with the network isolated. Empty restoreCmd is an honest skip.
   *
   * With opts.offline (used when a prewarmed read-only cache is mounted at
   * /cache) the SAME restoreCmd runs with --network=none: the package manager
   * resolves entirely from the cache and the attempt stays fully air-gapped.
   */
  restore(
    ws: WorkspaceHandle,
    timeoutMs = VALIDATION_LIMITS.INSTALL_TIMEOUT_MS,
    opts?: { offline?: boolean; cwd?: string },
  ): Promise<RunResult> {
    return this.detectToolchain(ws).then((tc) => {
      if (tc.restoreCmd.length === 0) {
        return {
          exitCode: 0,
          stdout: '(no restore step for detected toolchain)',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          command: '(skipped: no restore step for detected toolchain)',
        };
      }
      return this.exec(ws, tc.restoreCmd, timeoutMs, {
        isolateNetwork: opts?.offline === true,
        cwd: opts?.cwd,
      });
    });
  }

  /** @deprecated Use restore(). Kept so in-flight callers compile during the
   *  install -> restore rename. */
  install(ws: WorkspaceHandle, timeoutMs = VALIDATION_LIMITS.INSTALL_TIMEOUT_MS): Promise<RunResult> {
    return this.restore(ws, timeoutMs);
  }

  /**
   * Fail the step (rather than let untrusted build code fill the host disk) if
   * /work exceeds the configured ceiling. No-op when unset. Runs isolated.
   */
  async assertDiskUnderCeiling(ws: WorkspaceHandle): Promise<void> {
    const ceil = this.config.workDiskCeilingMb;
    if (!ceil) return;
    const res = await this.exec(ws, ['sh', '-lc', 'du -sm /work 2>/dev/null | cut -f1'], 30_000, {
      isolateNetwork: true,
    });
    const usedMb = Number(res.stdout.trim());
    if (Number.isFinite(usedMb) && usedMb > ceil) {
      throw new Error(`/work exceeded the ${ceil}MB disk ceiling (used ${usedMb}MB)`);
    }
  }

  getCacheVolumeManifest(name: string): Promise<string | null> {
    return getCacheVolumeManifest(this.docker, name);
  }

  recreateCacheVolume(name: string, manifestFingerprint: string): Promise<void> {
    return recreateCacheVolume(this.docker, name, manifestFingerprint);
  }

  runTests(
    ws: WorkspaceHandle,
    paths: string[],
    timeoutMs = VALIDATION_LIMITS.TEST_TIMEOUT_MS,
    opts?: { cwd?: string },
  ): Promise<RunResult> {
    return this.detectToolchain(ws).then((tc) => {
      const cmd = tc.testCmd(paths);
      if (cmd.length === 0) {
        // No test framework detected and no `scripts.test`; skip rather than
        // fail. The scan step is still authoritative for fix validation.
        return Promise.resolve({
          exitCode: 0,
          stdout: '(no tests for detected toolchain; skipping)',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          command: '(skipped: no tests for detected toolchain)',
        });
      }
      return this.exec(ws, cmd, timeoutMs, { isolateNetwork: true, cwd: opts?.cwd });
    });
  }

  async exec(
    ws: WorkspaceHandle,
    cmd: string[],
    timeoutMs = 60_000,
    opts: ExecOpts = {},
  ): Promise<RunResult> {
    const container = this.docker.getContainer(ws.id);
    const start = Date.now();

    // Network policy is per-exec. The workspace container's base network is the
    // no-egress network (when egress is disabled), so "isolated" execs (tests)
    // need no change. Execs that explicitly want egress (install) attach the
    // container to 'bridge' for the duration, then detach afterwards so the
    // next isolated step is back on the no-egress network. When egress is
    // globally enabled (SANDBOX_ENABLE_EGRESS=true) the container is already on
    // 'bridge' and we leave the network untouched.
    const wantsEgress = opts.isolateNetwork === false;
    const grantEgress = wantsEgress && !this.config.enableEgress;
    if (grantEgress) await this.connectToBridge(container).catch(() => {});

    try {
      const hasInput = opts.input !== undefined;
      const exec = await container.exec({
        Cmd: cmd,
        WorkingDir: opts.cwd ?? ROOT_PATH,
        Env: this.buildExecEnv(opts, grantEgress),
        AttachStdin: hasInput,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });

      const stream = await exec.start({ hijack: true, stdin: hasInput });

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      this.docker.modem.demuxStream(stream, stdout, stderr);

      // Feed stdin bytes (e.g. a tar archive for uploads) then half-close the
      // write side so the command sees EOF and exits. The read side stays open
      // to collect stdout/stderr until the command finishes.
      if (hasInput) {
        stream.write(opts.input);
        stream.end();
      }

      const stdoutBuf = collectCapped(stdout, VALIDATION_LIMITS.MAX_LOG_BYTES);
      const stderrBuf = collectCapped(stderr, VALIDATION_LIMITS.MAX_LOG_BYTES);

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        // Best-effort kill of the exec session by killing the underlying stream.
        stream.destroy(new Error('exec timeout'));
      }, timeoutMs);

      try {
        await new Promise<void>((resolve) => {
          stream.on('end', () => resolve());
          stream.on('close', () => resolve());
          stream.on('error', () => resolve());
        });
      } finally {
        clearTimeout(timeoutTimer);
        // Force the demuxed PassThroughs to emit 'close' so collectCapped()
        // resolves. Without this, when the upstream is destroyed mid-flight
        // (e.g. timeout fires) the downstream PassThroughs stay open and the
        // `await stdoutBuf` below hangs forever.
        stdout.end();
        stderr.end();
      }

      const inspected = await exec.inspect().catch(() => ({ ExitCode: timedOut ? 124 : -1 }));
      return {
        exitCode: typeof inspected.ExitCode === 'number' ? inspected.ExitCode : -1,
        stdout: await stdoutBuf,
        stderr: await stderrBuf,
        durationMs: Date.now() - start,
        timedOut,
        command: formatExecCommand(cmd),
      };
    } finally {
      if (grantEgress) {
        // Detach from bridge so the next isolated step (tests / scan) runs back
        // on the no-egress network with no route off-host.
        await this.docker
          .getNetwork('bridge')
          .disconnect({ Container: ws.id, Force: true })
          .catch(() => {});
      }
    }
  }

  async cleanup(ws: WorkspaceHandle): Promise<void> {
    this.toolchainOverrides.delete(ws.id);
    const container = this.docker.getContainer(ws.id);
    try {
      await container.kill({ signal: 'SIGKILL' });
    } catch {
      // already stopped
    }
    try {
      await container.remove({ v: true, force: true });
    } catch {
      // already gone
    }
  }

  private async tryReadFile(ws: WorkspaceHandle, path: string): Promise<string | null> {
    const r = await this.exec(ws, ['sh', '-lc', `test -f ${shellEscape(path)} && cat ${shellEscape(path)} || true`], 5_000);
    if (r.exitCode !== 0 || r.stdout.length === 0) return null;
    return r.stdout;
  }

  /**
   * Idempotently ensure the user-defined no-egress network exists. The network
   * is created with internal=true so containers on it have no route off the
   * host (no NAT to the outside world). Best-effort: tolerates a missing or
   * unavailable Docker daemon (e.g. dev/CI without Docker) by swallowing
   * errors, so callers never crash on network setup. Runs at most once per
   * runner instance.
   */
  async ensureNoEgressNetwork(): Promise<void> {
    if (!this.noEgressNetworkReady) {
      this.noEgressNetworkReady = (async () => {
        const name = this.config.egressNetwork;
        try {
          // Already present? createNetwork would 409; check first.
          const existing = await this.docker.listNetworks({
            filters: { name: [name] },
          });
          if (existing.some((n) => n.Name === name)) return;
          await this.docker.createNetwork({
            Name: name,
            Driver: 'bridge',
            // internal=true => no external connectivity (no egress).
            Internal: true,
            CheckDuplicate: true,
            Labels: { [SUTURA_LABEL]: '1' },
          });
        } catch {
          // Best-effort: a concurrent create (409) or an unavailable daemon
          // must not crash the pipeline. If the network truly can't be created
          // the createContainer call will surface a clear error later.
        }
      })();
    }
    return this.noEgressNetworkReady;
  }

  private async connectToBridge(container: Docker.Container): Promise<void> {
    await this.docker.getNetwork('bridge').connect({ Container: container.id });
  }
}

// ---------------- helpers ----------------

/**
 * Peek at a stripped repo tarball and pick the workspace image from the
 * top-level manifest files it contains. Only the small manifest entries are
 * buffered; every other entry is drained. Caller catches errors and falls back
 * to the base image.
 */
async function detectImageFromTar(tarBuf: Buffer): Promise<string> {
  return detectToolchainFromManifests(await readTopLevelManifestsFromTar(tarBuf)).image;
}

/**
 * Parse a DOCKER_SOCKET_PROXY_URL (e.g. "tcp://docker-socket-proxy:2375" or
 * "http://docker-socket-proxy:2375") into dockerode connection options. The
 * proxy speaks the Docker HTTP API over TCP, so we hand dockerode host/port.
 */
function parseDockerHost(url: string): { host: string; port: number; protocol: 'http' } {
  // dockerode accepts host/port for TCP; normalize tcp:// and http:// forms.
  const normalized = url.replace(/^tcp:\/\//, 'http://');
  const parsed = new URL(normalized);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 2375,
    protocol: 'http',
  };
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

function resolvePath(ws: WorkspaceHandle, p: string): string {
  if (p.startsWith('/')) return p;
  return `${ws.rootPath}/${p}`;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function collectCapped(stream: NodeJS.ReadableStream, max: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (c: Buffer) => {
      total += c.length;
      if (total <= max) chunks.push(c);
      else if (chunks.length === 0 || total - c.length < max) {
        chunks.push(c.subarray(0, Math.max(0, max - (total - c.length))));
      }
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

/**
 * Render the exec'd argv as a single shell-style string for display.
 * Unwraps the `sh -lc <body>` wrapper so the dashboard shows the actual
 * command (e.g. `npm audit --json`) instead of the wrapper.
 */
function formatExecCommand(cmd: string[]): string {
  if (cmd.length === 3 && cmd[0] === 'sh' && (cmd[1] === '-lc' || cmd[1] === '-c')) {
    return cmd[2];
  }
  return cmd.join(' ');
}

/**
 * GitHub's tarball wraps everything inside a single top-level directory like
 * "owner-repo-<sha>/". Re-pack with that prefix stripped so files land at /work.
 *
 * Auto-detects gzip (GitHub returns tar.gz; raw tar lacks the 0x1f 0x8b
 * magic) and gunzips on the fly.
 */
async function stripTopLevelDir(buf: Buffer): Promise<Buffer> {
  const extract = tar.extract();
  const pack = tar.pack();

  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const source = Readable.from(buf);
  if (isGzip) {
    source.pipe(createGunzip()).pipe(extract);
  } else {
    source.pipe(extract);
  }

  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
  });

  extract.on('entry', (header, stream, next) => {
    const stripped = header.name.replace(/^[^/]+\/?/, '');
    if (!stripped) {
      stream.resume();
      stream.on('end', next);
      return;
    }
    const entryHeader = { ...header, name: stripped };
    const entry = pack.entry(entryHeader, (err) => {
      if (err) next(err);
      else next();
    });
    stream.pipe(entry);
  });

  extract.on('finish', () => pack.finalize());
  extract.on('error', (err) => pack.destroy(err));

  return done;
}
