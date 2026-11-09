import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { loadConfig } from '../../config';

// A strong 32+ char key so encryption is deterministic across the suite.
const TEST_KEY = 'test-integration-encryption-key-0123456789abcdef';

beforeAll(() => {
  process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/test';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  loadConfig();
});

// Stub bullmq's Queue at the module level so getFix/Index/ValidationQueue
// build a fake queue (no Redis) and we can inspect both the per-queue config
// (defaultJobOptions) and the add() payload. vi.mock is hoisted; the registry
// is created lazily inside the factory and exposed via a getter import.
vi.mock('bullmq', () => {
  const constructed: Array<{ name: string; opts: any; add: ReturnType<typeof vi.fn> }> = [];
  class FakeQueue {
    name: string;
    opts: any;
    add = vi.fn().mockResolvedValue({ id: 'job-1' });
    constructor(name: string, opts: any) {
      this.name = name;
      this.opts = opts;
      constructed.push({ name, opts, add: this.add });
    }
  }
  return { Queue: FakeQueue, __constructed: constructed };
});

// Avoid a real Redis connection being created during getRedisConnection.
vi.mock('../connection', () => ({ getRedisConnection: () => ({}) }));

import { encryptSecret, decryptSecret } from '../../lib/secret-encryption';
import { enqueueIndexJob, enqueueValidationJob } from '../enqueue';
import { getIndexQueue, getValidationQueue } from '../queues';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as bullmq from 'bullmq';

const constructed = (bullmq as any).__constructed as Array<{
  name: string;
  opts: any;
  add: ReturnType<typeof vi.fn>;
}>;

function addCallsFor(queueName: string): any[] {
  const entry = constructed.find((c) => c.name === queueName);
  return entry ? entry.add.mock.calls : [];
}

beforeEach(() => {
  // Reset add() spies but keep the constructed queues (memoized singletons).
  for (const c of constructed) c.add.mockClear();
});

describe('secret-encryption', () => {
  it('round-trips encryptSecret -> decryptSecret', () => {
    const plain = 'ghp_super_secret_token_value';
    const enc = encryptSecret(plain);
    expect(enc).not.toBe(plain);
    expect(enc.split(':')).toHaveLength(3);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('returns a plaintext value unchanged (not in iv:ct:tag form)', () => {
    expect(decryptSecret('ghp_plain_token')).toBe('ghp_plain_token');
    expect(decryptSecret('client_id:client_secret')).toBe('client_id:client_secret');
    expect(decryptSecret('')).toBe('');
  });

  it('returns empty input unchanged from encryptSecret', () => {
    expect(encryptSecret('')).toBe('');
  });
});

describe('enqueueValidationJob encryption', () => {
  it('encrypts aikidoApiKey and anthropicApiKey in the queued payload', async () => {
    const aikido = 'aikido_client:aikido_secret';
    const anthropic = 'sk-ant-test-key';
    await enqueueValidationJob({
      findingId: 'finding-1',
      orgId: 'org-1',
      aikidoApiKey: aikido,
      anthropicApiKey: anthropic,
    });

    const payload = addCallsFor('validation-queue')[0][1];
    expect(payload.aikidoApiKey).not.toBe(aikido);
    expect(payload.anthropicApiKey).not.toBe(anthropic);
    expect(decryptSecret(payload.aikidoApiKey)).toBe(aikido);
    expect(decryptSecret(payload.anthropicApiKey)).toBe(anthropic);
    // Non-secret fields are left untouched.
    expect(payload.findingId).toBe('finding-1');
    expect(payload.orgId).toBe('org-1');
  });

  it('leaves absent credential fields absent', async () => {
    await enqueueValidationJob({ findingId: 'finding-2', orgId: 'org-1' });
    const payload = addCallsFor('validation-queue')[0][1];
    expect(payload.aikidoApiKey).toBeUndefined();
    expect(payload.anthropicApiKey).toBeUndefined();
  });
});

describe('enqueueIndexJob encryption', () => {
  it('encrypts githubToken in the queued payload', async () => {
    const token = 'ghp_index_token_value';
    await enqueueIndexJob({ repo: 'org/repo', branch: 'main', orgId: 'org-1', githubToken: token });

    const payload = addCallsFor('index-queue')[0][1];
    expect(payload.githubToken).not.toBe(token);
    expect(decryptSecret(payload.githubToken)).toBe(token);
    expect(payload.repo).toBe('org/repo');
  });
});

describe('queue TTL', () => {
  it('validation queue removeOnComplete age is <= 3600s', () => {
    // Force construction, then read the config the queue was built with.
    getValidationQueue();
    const entry = constructed.find((c) => c.name === 'validation-queue');
    expect(entry).toBeDefined();
    const age = entry!.opts.defaultJobOptions.removeOnComplete.age;
    expect(age).toBeLessThanOrEqual(3600);
  });

  it('index queue purges completed jobs within an hour', () => {
    getIndexQueue();
    const entry = constructed.find((c) => c.name === 'index-queue');
    expect(entry).toBeDefined();
    const age = entry!.opts.defaultJobOptions.removeOnComplete.age;
    expect(age).toBeLessThanOrEqual(3600);
  });
});
