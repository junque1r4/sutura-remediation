import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar-stream';
import type Docker from 'dockerode';
import { MANIFEST_FILES } from './toolchain-detect';

/**
 * Per-repo dependency cache, materialized as a Docker named volume. A prewarm
 * job populates it once (read-write) by running the toolchain's restoreCmd on a
 * clean checkout; every later fix attempt mounts it READ-ONLY so untrusted
 * patch code can neither poison it nor re-pay the restore.
 */

export const CACHE_VOLUME_PREFIX = 'sutura-cache-';
/** Volume label holding the dependency-manifest fingerprint the cache was built
 *  from. Prewarm rebuilds the cache only when this no longer matches the repo's
 *  current manifests, so a dependency bump invalidates stale caches. */
export const CACHE_MANIFEST_LABEL = 'sutura.manifest';

/** Deterministic, collision-resistant volume name for an (org, repo) pair.
 *  12 hex chars of sha256 -- ample for the handful of repos per org, and stable
 *  so the prewarm and the attempt agree without a lookup. */
export function cacheVolumeName(orgId: string, repo: string): string {
  const h = createHash('sha256').update(`${orgId}\0${repo}`).digest('hex').slice(0, 12);
  return `${CACHE_VOLUME_PREFIX}${h}`;
}

/** Hash of the dependency manifests so the cache can be invalidated when they
 *  change. Order-independent; null (absent) manifests are ignored. */
export function manifestHash(files: Record<string, string | null>): string {
  const h = createHash('sha256');
  for (const key of Object.keys(files).sort()) {
    const val = files[key];
    if (val == null) continue;
    h.update(key).update('\0').update(val).update('\0');
  }
  return h.digest('hex');
}

/** Fingerprint a repo produces when NONE of MANIFEST_FILES exist at its top
 *  level -- i.e. the hash of the empty manifest set (sha256 of no input). This
 *  is the case for ecosystems with no recognized top-level manifest, notably
 *  .NET (developer-taught toolchain). Prewarm uses it to detect "no manifest to
 *  fingerprint" and decline, so the orchestrator falls back to a networked
 *  restore rather than a doomed offline one. */
export const EMPTY_MANIFESTS_FINGERPRINT = manifestHash({});

export async function ensureCacheVolume(
  docker: Docker,
  name: string,
  manifestFingerprint?: string,
): Promise<void> {
  const Labels: Record<string, string> = { 'sutura.cache': 'true' };
  if (manifestFingerprint) Labels[CACHE_MANIFEST_LABEL] = manifestFingerprint;
  await docker.createVolume({ Name: name, Labels });
}

/** Read the manifest fingerprint a cache volume was built from. Returns null
 *  when the volume is absent or carries no fingerprint label (treat as a miss
 *  so prewarm rebuilds it). */
export async function getCacheVolumeManifest(
  docker: Docker,
  name: string,
): Promise<string | null> {
  try {
    const info = (await docker.getVolume(name).inspect()) as {
      Labels?: Record<string, string> | null;
    };
    return info.Labels?.[CACHE_MANIFEST_LABEL] ?? null;
  } catch {
    return null;
  }
}

/** Drop a stale cache and recreate it empty with the new fingerprint label.
 *  Used by prewarm when the manifests changed. */
export async function recreateCacheVolume(
  docker: Docker,
  name: string,
  manifestFingerprint: string,
): Promise<void> {
  await removeCacheVolume(docker, name);
  await ensureCacheVolume(docker, name, manifestFingerprint);
}

export async function listCacheVolumes(docker: Docker): Promise<string[]> {
  const res = (await docker.listVolumes()) as { Volumes?: Array<{ Name: string }> };
  return (res.Volumes ?? [])
    .map((v) => v.Name)
    .filter((n) => n.startsWith(CACHE_VOLUME_PREFIX))
    .sort();
}

export async function removeCacheVolume(docker: Docker, name: string): Promise<void> {
  try {
    await docker.getVolume(name).remove({ force: true });
  } catch {
    // Volume already gone (or in use by a dead container being reaped) -- the
    // caller's GC pass will retry next boot. Never throw from cleanup.
  }
}

/** Reclaim cache volumes whose CreatedAt is older than maxAgeMs. Cache volumes
 *  are meant to persist across runs, so GC is age-based and generous: an active
 *  repo whose cache is reclaimed simply re-warms on its next fix. Volumes in use
 *  by a live container can't be removed (Docker refuses; removeCacheVolume
 *  swallows it) so this never disrupts a running prewarm/attempt. A non-positive
 *  maxAgeMs disables GC. Returns the names removed. `now` is injectable for tests. */
export async function gcCacheVolumes(
  docker: Docker,
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<string[]> {
  if (!maxAgeMs || maxAgeMs <= 0) return [];
  const removed: string[] = [];
  for (const name of await listCacheVolumes(docker)) {
    try {
      const info = (await docker.getVolume(name).inspect()) as { CreatedAt?: string };
      const created = info.CreatedAt ? Date.parse(info.CreatedAt) : NaN;
      if (Number.isFinite(created) && now - created > maxAgeMs) {
        await removeCacheVolume(docker, name);
        removed.push(name);
      }
    } catch {
      // Volume vanished mid-pass or inspect failed; skip and retry next boot.
    }
  }
  return removed;
}

/** Fingerprint a repo tarball by its TOP-LEVEL dependency manifests only, so the
 *  cache is invalidated by a dependency bump but NOT by ordinary source edits
 *  (each fix run fetches a fresh HEAD tarball that changes constantly). Repos
 *  whose ecosystem has no top-level manifest in MANIFEST_FILES (e.g. .NET, which
 *  uses a developer-taught toolchain) hash to the empty-set constant -- their
 *  cache is then keyed by (org, repo) alone and only refreshed by GC. */
export async function manifestFingerprintFromTar(tarBuf: Buffer): Promise<string> {
  return manifestHash(await readTopLevelManifestsFromTar(tarBuf));
}

/** Stream a tarball and buffer ONLY its top-level MANIFEST_FILES (everything
 *  else is drained). Shared by image detection and cache fingerprinting so both
 *  read the same set. Absent manifests come back as null. */
export async function readTopLevelManifestsFromTar(
  tarBuf: Buffer,
): Promise<Record<string, string | null>> {
  const manifests: Record<string, string | null> = {};
  for (const f of MANIFEST_FILES) manifests[f] = null;

  const extract = tar.extract();
  // GitHub returns a gzipped tarball (0x1f 0x8b magic); a raw tar lacks it.
  // Gunzip on the fly so fingerprinting works on the real archive.
  const isGzip = tarBuf.length >= 2 && tarBuf[0] === 0x1f && tarBuf[1] === 0x8b;
  const source = Readable.from(tarBuf);
  if (isGzip) source.pipe(createGunzip()).pipe(extract);
  else source.pipe(extract);
  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const name = header.name.replace(/^\.\//, '');
      if (!name.includes('/') && (MANIFEST_FILES as readonly string[]).includes(name)) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          manifests[name] = Buffer.concat(chunks).toString('utf-8');
          next();
        });
        stream.on('error', () => next());
      } else {
        stream.resume();
        stream.on('end', next);
      }
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
  });

  return manifests;
}
