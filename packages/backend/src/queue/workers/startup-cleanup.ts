import Docker from 'dockerode';
import { getDockerConnectionOptions, gcCacheVolumes } from '@sutura/sandbox-runner';
import { getPool } from '../../db/client';

/**
 * Maximum age (ms) for a `running` fix_attempts row before we treat it as a
 * crash artifact and force-fail it. Must be greater than the BullMQ
 * lockDuration so a legitimate long-running job is never tagged early.
 */
const STALE_RUNNING_THRESHOLD_MS = 30 * 60_000;

/**
 * Container name prefix used by DockerSandboxRunner. Anything older than
 * STALE_CONTAINER_THRESHOLD_MS with this prefix is leaked from a dead worker.
 */
const SANDBOX_PREFIX = 'sutura-sbx-';
const STALE_CONTAINER_THRESHOLD_MS = STALE_RUNNING_THRESHOLD_MS;

/**
 * Age (ms) after which an unused per-repo dependency cache volume is reclaimed.
 * Cache volumes are meant to persist (that's the point), so the default is
 * generous; an active repo whose cache is reclaimed simply re-warms on its next
 * fix. Set SANDBOX_CACHE_TTL_DAYS=0 to disable cache GC entirely.
 */
function cacheTtlMs(): number {
  const raw = process.env.SANDBOX_CACHE_TTL_DAYS;
  // Default to 14 days only when UNSET or unparseable -- a parsed 0 must reach
  // gcCacheVolumes as 0 so the documented "0 disables cache GC" actually holds
  // (|| would have turned the falsy 0 back into the default).
  const days = raw == null || raw.trim() === '' ? 14 : Number.parseFloat(raw);
  return (Number.isFinite(days) ? days : 14) * 24 * 60 * 60_000;
}
const CACHE_TTL_MS = cacheTtlMs();

/**
 * Mark fix_attempts rows that have been `running` for longer than the worker
 * lock could possibly hold them as `failed`. Called on worker startup so the
 * UI doesn't show ghost-running attempts after a crash / rebuild / SIGKILL.
 */
async function failStaleRunningAttempts(): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE fix_attempts
        SET status = 'failed',
            failure_reason = 'worker_restart',
            completed_at = now()
      WHERE status = 'running'
        AND created_at < now() - ($1 || ' milliseconds')::interval`,
    [STALE_RUNNING_THRESHOLD_MS.toString()],
  );
  return rowCount ?? 0;
}

/**
 * Remove sutura-sbx-* containers from previous worker runs. The DockerSandboxRunner
 * normally cleans up in its `finally`, but a hard crash / rebuild leaks the
 * sibling container. Each leaked container holds ~120 MB of repo state on the
 * host and stays running indefinitely (`sleep infinity`).
 */
async function pruneLeakedSandboxContainers(): Promise<number> {
  // Route through the same proxy-aware connection DockerSandboxRunner uses so
  // leaked-container reaping keeps working in the hardened compose (where the
  // raw /var/run/docker.sock is no longer bind-mounted into the backend).
  const docker = new Docker(getDockerConnectionOptions());
  const now = Date.now();
  let removed = 0;
  try {
    const list = await docker.listContainers({ all: true });
    for (const info of list) {
      const name = (info.Names[0] ?? '').replace(/^\//, '');
      if (!name.startsWith(SANDBOX_PREFIX)) continue;
      const ageMs = now - info.Created * 1000;
      if (ageMs < STALE_CONTAINER_THRESHOLD_MS) continue;
      try {
        // v: true also removes the workspace's anonymous /work volume --
        // without it every crashed job leaks a multi-GB volume on disk.
        await docker.getContainer(info.Id).remove({ force: true, v: true });
        removed++;
      } catch (err) {
        console.warn('[startup-cleanup] failed to remove', name, err);
      }
    }
  } catch (err) {
    console.warn('[startup-cleanup] failed to list containers:', err);
  }
  return removed;
}

/**
 * One-shot cleanup invoked once per worker process boot. Best-effort: errors
 * are logged but never thrown, so a transient docker / db hiccup can't keep
 * the worker from coming up.
 */
export async function runStartupCleanup(): Promise<void> {
  try {
    const failedRows = await failStaleRunningAttempts();
    if (failedRows > 0) {
      console.warn(
        `[startup-cleanup] force-failed ${failedRows} stale 'running' fix_attempts row(s)`,
      );
    }
  } catch (err) {
    console.warn('[startup-cleanup] failStaleRunningAttempts failed:', err);
  }

  try {
    const removed = await pruneLeakedSandboxContainers();
    if (removed > 0) {
      console.warn(`[startup-cleanup] removed ${removed} leaked sandbox container(s)`);
    }
  } catch (err) {
    console.warn('[startup-cleanup] pruneLeakedSandboxContainers failed:', err);
  }

  try {
    const docker = new Docker(getDockerConnectionOptions());
    const reclaimed = await gcCacheVolumes(docker, CACHE_TTL_MS);
    if (reclaimed.length > 0) {
      console.warn(
        `[startup-cleanup] reclaimed ${reclaimed.length} stale dependency-cache volume(s)`,
      );
    }
  } catch (err) {
    console.warn('[startup-cleanup] gcCacheVolumes failed:', err);
  }
}
