import { describe, it, expect } from 'vitest';
import {
  createCodeSearchLimiter,
  dispatchCodeSearch,
  retryDelayMs,
  type CodeSearchLimiter,
} from '../code-search-limiter';

/**
 * Fake clock: `sleep` records the requested duration and advances the clock
 * by exactly that amount, so tests never wait real time.
 */
function fakeTimers(startMs = 0) {
  let nowMs = startMs;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleeps,
    get nowMs() {
      return nowMs;
    },
  };
}

function makeLimiter(
  timers: ReturnType<typeof fakeTimers>,
  overrides: { minSpacingMs?: number; retryWindowMs?: number } = {},
): CodeSearchLimiter {
  return createCodeSearchLimiter({
    minSpacingMs: overrides.minSpacingMs ?? 6_000,
    retryWindowMs: overrides.retryWindowMs ?? 60_000,
    now: timers.now,
    sleep: timers.sleep,
  });
}

interface FakeResponse {
  status: number;
  headers: { get(name: string): string | null };
}

function res(status: number, headers: Record<string, string> = {}): FakeResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

describe('createCodeSearchLimiter', () => {
  it('dispatches the first call immediately without sleeping', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);

    const value = await limiter.schedule(async () => 'first');

    expect(value).toBe('first');
    expect(timers.sleeps).toEqual([]);
  });

  it('waits out the remaining spacing before the next dispatch', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);

    await limiter.schedule(async () => 'a'); // dispatched at t=0
    timers.advance(2_000);
    await limiter.schedule(async () => 'b');

    expect(timers.sleeps).toEqual([4_000]); // 6s spacing minus 2s elapsed
    expect(timers.nowMs).toBe(6_000);
  });

  it('does not sleep when the spacing window has already elapsed', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);

    await limiter.schedule(async () => 'a');
    timers.advance(7_000);
    await limiter.schedule(async () => 'b');

    expect(timers.sleeps).toEqual([]);
  });

  it('serialises concurrent calls in FIFO order', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = limiter.schedule(async () => {
      order.push('start-1');
      await firstGate;
      order.push('end-1');
      return 1;
    });
    const p2 = limiter.schedule(async () => {
      order.push('start-2');
      return 2;
    });

    // Let microtasks run: the second call must not start while the first is
    // still in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start-1']);

    releaseFirst();
    await expect(Promise.all([p1, p2])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });

  it('keeps serving the queue after a dispatch rejects', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);

    const failing = limiter.schedule(async () => {
      throw new Error('boom');
    });
    const following = limiter.schedule(async () => 'still works');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('still works');
  });

});

describe('retryDelayMs', () => {
  it('honours retry-after (seconds)', () => {
    expect(retryDelayMs(res(403, { 'retry-after': '12' }).headers, 0, 60_000)).toBe(12_000);
  });

  it('honours x-ratelimit-reset (epoch seconds) relative to now', () => {
    const nowMs = 100_000;
    const headers = res(403, { 'x-ratelimit-reset': '160' }).headers; // resets at t=160s
    expect(retryDelayMs(headers, nowMs, 60_000)).toBe(60_000);
  });

  it('falls back to the configured window when no headers are present', () => {
    expect(retryDelayMs(res(403).headers, 0, 60_000)).toBe(60_000);
  });

  it('ignores unparseable or stale header values', () => {
    expect(retryDelayMs(res(403, { 'retry-after': 'soon' }).headers, 0, 60_000)).toBe(60_000);
    // Reset timestamp already in the past.
    expect(retryDelayMs(res(403, { 'x-ratelimit-reset': '1' }).headers, 100_000, 60_000)).toBe(
      60_000,
    );
  });
});

describe('dispatchCodeSearch', () => {
  it('returns a successful response without retrying', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);
    let calls = 0;

    const response = await dispatchCodeSearch(async () => {
      calls += 1;
      return res(200);
    }, limiter);

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('does not retry non-403 errors', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);
    let calls = 0;

    const response = await dispatchCodeSearch(async () => {
      calls += 1;
      return res(422);
    }, limiter);

    expect(response.status).toBe(422);
    expect(calls).toBe(1);
  });

  it('does not retry a permission 403 (rate budget not exhausted)', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);
    let calls = 0;

    const response = await dispatchCodeSearch(async () => {
      calls += 1;
      return res(403, { 'x-ratelimit-remaining': '29' });
    }, limiter);

    expect(response.status).toBe(403);
    expect(calls).toBe(1);
    expect(timers.sleeps).toEqual([]);
  });

  it('retries a 403 whose rate budget is exhausted', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);
    const responses = [res(403, { 'x-ratelimit-remaining': '0' }), res(200)];
    let calls = 0;

    const response = await dispatchCodeSearch(async () => {
      calls += 1;
      return responses.shift()!;
    }, limiter);

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('retries once after a 403, waiting out retry-after', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);
    const responses = [res(403, { 'retry-after': '15' }), res(200)];
    let calls = 0;

    const response = await dispatchCodeSearch(async () => {
      calls += 1;
      return responses.shift()!;
    }, limiter);

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(timers.sleeps).toContain(15_000);
  });

  it('waits the configured window before retrying when no headers are present', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers, { retryWindowMs: 30_000 });
    const responses = [res(403), res(200)];

    await dispatchCodeSearch(async () => responses.shift()!, limiter);

    expect(timers.sleeps).toContain(30_000);
  });

  it('returns the second 403 as-is so the caller can surface its error', async () => {
    const timers = fakeTimers();
    const limiter = makeLimiter(timers);
    let calls = 0;

    const response = await dispatchCodeSearch(async () => {
      calls += 1;
      return res(403);
    }, limiter);

    expect(response.status).toBe(403);
    expect(calls).toBe(2); // exactly one retry, never more
  });
});
