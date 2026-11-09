import {
  cacheVolumeName,
  manifestFingerprintFromTar,
  EMPTY_MANIFESTS_FINGERPRINT,
  type SandboxRunner,
} from '@sutura/sandbox-runner';
import type { SerializedToolchain } from '@sutura/common';

/**
 * Per-repo dependency cache prewarm.
 *
 * Runs the toolchain's restore (the ONLY networked phase) ONCE on a clean
 * checkout, writing the package cache into a per-repo Docker volume. Every later
 * fix attempt then mounts that volume READ-ONLY (see createWorkspace's
 * cacheReadOnly), so the untrusted patch can read the packages it needs but can
 * neither poison the cache nor re-pay the restore -- which keeps the attempt
 * itself fully air-gapped (--network=none).
 *
 * The cache is keyed by (org, repo) and stamped with a fingerprint of the repo's
 * top-level dependency manifests. A warm cache whose fingerprint still matches is
 * reused as-is; a dependency bump changes the fingerprint and triggers a rebuild.
 */

export interface PrewarmDeps {
  runner: SandboxRunner;
  /** Clean repo tarball at the target ref (no patch applied). */
  tarball: Buffer;
  orgId: string;
  repo: string;
  /** Developer-taught toolchain (pins image + restoreCmd). */
  toolchainOverride?: SerializedToolchain;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface PrewarmResult {
  /** Name of the cache volume (mount this RO on attempts). */
  volume: string;
  /** True when this call ran a restore to (re)build the cache. */
  rebuilt: boolean;
  /** True when the cache is usable (already warm, or rebuilt successfully). */
  ok: boolean;
  durationMs: number;
  error?: string;
}

export async function ensureWarmCache(deps: PrewarmDeps): Promise<PrewarmResult> {
  const { runner, tarball, orgId, repo, toolchainOverride, timeoutMs, log } = deps;
  const startedAt = Date.now();
  const volume = cacheVolumeName(orgId, repo);

  let fingerprint: string;
  try {
    fingerprint = await manifestFingerprintFromTar(tarball);
  } catch (err) {
    // Can't fingerprint -> can't safely reuse a cache. Report not-ok; the
    // orchestrator falls back to per-attempt restore.
    return {
      volume,
      rebuilt: false,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: `fingerprint failed: ${String(err)}`,
    };
  }

  // No recognized top-level manifest (e.g. .NET, which uses a developer-taught
  // toolchain). The empty-set fingerprint can't key or invalidate this cache,
  // and -- critically -- the per-attempt restore against the prewarmed volume
  // runs OFFLINE (--network=none), which the .NET SDK can't satisfy: workload
  // verification needs the network and aborts ("An issue was encountered
  // verifying workloads"), so every attempt dies install_failed. Decline prewarm
  // for these ecosystems so the orchestrator uses its networked clean-tree
  // restore (still safe: the untrusted patch's build+test stays air-gapped).
  if (fingerprint === EMPTY_MANIFESTS_FINGERPRINT) {
    log?.(`[prewarm] no recognized manifest for ${repo}; using networked restore`);
    return {
      volume,
      rebuilt: false,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: 'no recognized dependency manifest; using networked restore',
    };
  }

  // Already warm for these exact manifests -> reuse without spending a restore.
  const existing = await runner.getCacheVolumeManifest(volume).catch(() => null);
  if (existing && existing === fingerprint) {
    log?.(`[prewarm] cache ${volume} already warm (${fingerprint.slice(0, 12)})`);
    return { volume, rebuilt: false, ok: true, durationMs: Date.now() - startedAt };
  }

  log?.(`[prewarm] (re)building cache ${volume} for ${repo}`);
  await runner.recreateCacheVolume(volume, fingerprint);

  // Populate the cache by running restore on a clean tree with the volume mounted
  // read-write. This is the only place the cache volume is writable.
  const ws = await runner.createWorkspace(tarball, {
    toolchainOverride,
    cacheVolume: volume,
    cacheReadOnly: false,
  });
  try {
    const res = await runner.restore(ws, timeoutMs);
    const ok = res.exitCode === 0 && !res.timedOut;
    if (!ok) {
      log?.(`[prewarm] restore failed (exit ${res.exitCode}, timedOut=${res.timedOut})`);
    }
    return {
      volume,
      rebuilt: true,
      ok,
      durationMs: Date.now() - startedAt,
      error: ok ? undefined : (res.stderr || res.stdout).slice(-2000),
    };
  } finally {
    await runner.cleanup(ws).catch(() => {});
  }
}
