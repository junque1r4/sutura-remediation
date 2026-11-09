import { getConfig } from '../config';
import { getSingletonOrgId } from '../db/organizations';
import { syncAll } from './scanner-sync';

/**
 * Start the outbound scanner-sync poll when SCANNER_SYNC_ENABLED. Runs syncAll
 * for the singleton org every SCANNER_SYNC_INTERVAL_MS, non-overlapping (a slow
 * sync defers the next tick rather than stacking), unref'd so it never keeps
 * the process alive, and never throws out of the timer -- a failed cycle is
 * logged and the loop continues. No-op (and returns) when the flag is off.
 */
export function startScannerSyncPoller(): void {
  const config = getConfig();
  if (!config.SCANNER_SYNC_ENABLED) return;

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const orgId = await getSingletonOrgId();
      const results = await syncAll(orgId);
      const summary = results
        .map((r) =>
          r.skipped
            ? `${r.provider}=skipped`
            : r.error
              ? `${r.provider}=error`
              : `${r.provider}=${r.upserted}/${r.fetched}`,
        )
        .join(' ');
      console.warn(`[scanner-sync] ${summary}`);
    } catch (err) {
      console.error('[scanner-sync] cycle failed', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, config.SCANNER_SYNC_INTERVAL_MS);
  timer.unref();
}
