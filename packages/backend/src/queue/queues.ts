import { Queue } from 'bullmq';
import { getRedisConnection } from './connection';

export interface FixJobData {
  findingId: string;
  orgId: string;
}

export interface IndexJobData {
  repo: string;
  branch: string;
  orgId: string;
  githubToken: string;
}

export interface ValidationJobData {
  findingId: string;
  orgId: string;
  /**
   * Aikido credential in `client_id:client_secret` form. Forwarded by the
   * dashboard (which reads it from the org-scoped integration_connections
   * store) so the validation worker can run Aikido's local CLI inside the
   * sandbox. When absent, the worker resolves it from the DB connection for
   * the org, falling back to `AIKIDO_API_KEY` env. Stored in Redis for the
   * lifetime of the job (~24h removeOnComplete).
   */
  aikidoApiKey?: string;
  /**
   * Anthropic API key forwarded from the dashboard's org-scoped
   * integration_connections store. The fix-engine pipeline needs this to
   * call Claude. When absent, the worker resolves it from the DB connection
   * for the org, falling back to the backend's `ANTHROPIC_API_KEY` env
   * (server-only / cron flows).
   */
  anthropicApiKey?: string;
  /**
   * Markdown of the dashboard's Analyze output (~5-15 KB). Threaded into the
   * fix prompt as priming context so the fix agent doesn't redo the
   * reasoning the user already paid for. Persisted in Redis for ~24h via
   * removeOnComplete.
   */
  priorAnalysis?: string;
  customPrompts?: Record<string, unknown>;
  maxAttempts?: number;
  /** Optional override for repo target branch. */
  targetBranch?: string;
  reviewers?: string[];
}

let _fixQueue: Queue<FixJobData> | null = null;
let _indexQueue: Queue<IndexJobData> | null = null;
let _validationQueue: Queue<ValidationJobData> | null = null;

export function getFixQueue(): Queue<FixJobData> {
  if (_fixQueue) return _fixQueue;
  _fixQueue = new Queue<FixJobData>('fix-queue', {
    connection: getRedisConnection(),
    // Completed jobs may carry credentials forwarded in the payload; purge
    // them quickly. Keep failures a little longer for debugging.
    defaultJobOptions: {
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 24 * 3600, count: 200 },
    },
  });
  return _fixQueue;
}

export function getIndexQueue(): Queue<IndexJobData> {
  if (_indexQueue) return _indexQueue;
  _indexQueue = new Queue<IndexJobData>('index-queue', {
    connection: getRedisConnection(),
    // index jobs carry an encrypted githubToken; purge completed payloads
    // promptly so secrets don't linger in Redis.
    defaultJobOptions: {
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 24 * 3600, count: 200 },
    },
  });
  return _indexQueue;
}

export function getValidationQueue(): Queue<ValidationJobData> {
  if (_validationQueue) return _validationQueue;
  _validationQueue = new Queue<ValidationJobData>('validation-queue', {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      // Tightened from 24h -> 1h: completed payloads carry forwarded
      // credentials, so purge them promptly even though they are encrypted.
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3600, count: 200 },
    },
  });
  return _validationQueue;
}
