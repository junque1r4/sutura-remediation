// ---------------------------------------------------------------------------
// Code search rate limiter
// ---------------------------------------------------------------------------
// GitHub's /search/code endpoint has a hard limit of ~10 requests/minute —
// far below the general API limit. Every code-search dispatch funnels through
// a shared limiter that enforces a minimum spacing between requests and
// serialises concurrent callers, so a search-heavy analysis cannot burn the
// whole budget in a burst. The clock and sleep are injectable so tests never
// wait real time.

const CODE_SEARCH_MIN_SPACING_MS = 6_000; // ~10 requests/minute
const CODE_SEARCH_RETRY_WINDOW_MS = 60_000; // full rate window
const RETRY_DELAY_CAP_MS = 120_000;

export interface CodeSearchLimiterOptions {
  /** Minimum gap between code-search dispatches. */
  minSpacingMs?: number;
  /** Fallback wait before the single 403 retry when no header hints exist. */
  retryWindowMs?: number;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
  /** Injectable sleep (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export interface CodeSearchLimiter {
  minSpacingMs: number;
  retryWindowMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Runs `fn` once the spacing window allows; concurrent callers run FIFO, one at a time. */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
}

export function createCodeSearchLimiter(
  options: CodeSearchLimiterOptions = {},
): CodeSearchLimiter {
  const minSpacingMs = options.minSpacingMs ?? CODE_SEARCH_MIN_SPACING_MS;
  const retryWindowMs = options.retryWindowMs ?? CODE_SEARCH_RETRY_WINDOW_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastDispatchAt: number | null = null;
  let tail: Promise<void> = Promise.resolve();

  function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (lastDispatchAt !== null) {
        const waitMs = lastDispatchAt + minSpacingMs - now();
        if (waitMs > 0) await sleep(waitMs);
      }
      lastDispatchAt = now();
      return fn();
    });
    // Keep the queue alive even when a dispatch rejects.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { minSpacingMs, retryWindowMs, now, sleep, schedule };
}

interface RetryHeaders {
  get(name: string): string | null;
}

/**
 * How long to wait before retrying a 403 from code search. Honours
 * `retry-after` (seconds) and `x-ratelimit-reset` (epoch seconds) when GitHub
 * sends them; otherwise falls back to the configured rate window.
 */
export function retryDelayMs(headers: RetryHeaders, nowMs: number, fallbackMs: number): number {
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, RETRY_DELAY_CAP_MS);
  }
  const resetEpoch = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(resetEpoch) && resetEpoch > 0) {
    const deltaMs = resetEpoch * 1000 - nowMs;
    if (deltaMs > 0) return Math.min(deltaMs, RETRY_DELAY_CAP_MS);
  }
  return fallbackMs;
}

export interface CodeSearchResponseLike {
  status: number;
  headers: RetryHeaders;
}

/**
 * A 403 is only worth retrying when it is a rate limit, not a permissions
 * problem. Rate-limited responses carry `retry-after` or an exhausted
 * `x-ratelimit-remaining`; a 403 with budget remaining is a permission error
 * that a wait cannot fix. Header-less 403s are treated as rate limits so abuse
 * detection (which can omit headers) still gets its one retry.
 */
function isRateLimit403(headers: RetryHeaders): boolean {
  if (headers.get('retry-after') !== null) return true;
  const remaining = headers.get('x-ratelimit-remaining');
  return remaining === null || remaining === '0';
}

/**
 * Dispatches a code-search request through the limiter. On a rate-limit 403
 * waits out the rate window and retries exactly once; the retry response is
 * returned as-is so callers surface their usual error.
 */
export async function dispatchCodeSearch<R extends CodeSearchResponseLike>(
  doFetch: () => Promise<R>,
  limiter: CodeSearchLimiter,
): Promise<R> {
  const first = await limiter.schedule(doFetch);
  if (first.status !== 403 || !isRateLimit403(first.headers)) return first;
  await limiter.sleep(retryDelayMs(first.headers, limiter.now(), limiter.retryWindowMs));
  return limiter.schedule(doFetch);
}
