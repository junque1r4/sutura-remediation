import { getFixQueue, getIndexQueue, getValidationQueue } from './queues';
import type { FixJobData, IndexJobData, ValidationJobData } from './queues';
import { encryptSecret } from '../lib/secret-encryption';

export async function enqueueFixJob(data: FixJobData): Promise<string> {
  const queue = getFixQueue();
  const job = await queue.add('fix', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  });
  return job.id!;
}

export async function enqueueIndexJob(data: IndexJobData): Promise<string> {
  const queue = getIndexQueue();
  // Encrypt the githubToken before it lands in Redis. The worker decrypts at
  // job start. decryptSecret tolerates plaintext, so this is backward safe.
  const payload: IndexJobData = { ...data, githubToken: encryptSecret(data.githubToken) };
  const job = await queue.add('index', payload, {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
  });
  return job.id!;
}

export async function enqueueValidationJob(data: ValidationJobData): Promise<string> {
  const queue = getValidationQueue();
  // Encrypt the forwarded credentials before they land in Redis. The worker
  // decrypts at job start; decryptSecret tolerates plaintext / absent values.
  const payload: ValidationJobData = {
    ...data,
    ...(data.aikidoApiKey ? { aikidoApiKey: encryptSecret(data.aikidoApiKey) } : {}),
    ...(data.anthropicApiKey ? { anthropicApiKey: encryptSecret(data.anthropicApiKey) } : {}),
  };
  const job = await queue.add('validate', payload, { attempts: 1 });
  return job.id!;
}

export async function cancelValidationJob(jobId: string): Promise<boolean> {
  const queue = getValidationQueue();
  const job = await queue.getJob(jobId);
  if (!job) return false;
  await job.remove().catch(() => {});
  return true;
}
