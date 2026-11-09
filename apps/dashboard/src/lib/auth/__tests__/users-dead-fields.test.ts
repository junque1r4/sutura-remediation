import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub `server-only` so users.ts can be imported in a plain node test env.
vi.mock('server-only', () => ({}));

// Capture every SQL string + params that users.ts hands to the db layer, and
// drive the rows it gets back via a queue.
const calls: Array<{ sql: string; params: unknown[] }> = [];
let nextRows: unknown[] = [];

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { rows: nextRows, rowCount: nextRows.length };
  }),
}));

import {
  recordLoginSuccess,
  listMembersForOrg,
  getMemberDetail,
} from '../users';

afterEach(() => {
  calls.length = 0;
  nextRows = [];
});

const DEAD = /locked_until|failed_login_count/;

describe('dead lockout columns removed from users.ts', () => {
  it('recordLoginSuccess only updates last_login_at', async () => {
    await recordLoginSuccess('user-1');
    const last = calls.at(-1)!;
    expect(last.sql).toMatch(/last_login_at/);
    expect(last.sql).not.toMatch(DEAD);
  });

  it('listMembersForOrg does not select the dead columns', async () => {
    nextRows = [];
    await listMembersForOrg('org-1');
    const last = calls.at(-1)!;
    expect(last.sql).not.toMatch(DEAD);
  });

  it('getMemberDetail does not select or expose the dead columns', async () => {
    nextRows = [
      {
        user_id: 'u1',
        email: 'a@b.com',
        role: 'developer',
        joined_at: new Date(),
        invited_by_email: null,
        last_login_at: null,
        email_verified_at: null,
        created_at: new Date(),
        active_session_count: '0',
      },
    ];
    const detail = await getMemberDetail('u1', 'org-1');
    const last = calls.at(-1)!;
    expect(last.sql).not.toMatch(DEAD);
    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty('lockedUntil');
    expect(detail).not.toHaveProperty('failedLoginCount');
  });
});
