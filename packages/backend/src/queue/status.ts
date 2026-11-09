import { getFixQueue } from './queues';

export interface JobStatus {
  id: string;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  progress: number | object;
  result: unknown;
  error: string | undefined;
}

export async function getFixJobStatus(jobId: string): Promise<JobStatus> {
  const queue = getFixQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return {
      id: jobId,
      state: 'unknown',
      progress: 0,
      result: null,
      error: undefined,
    };
  }

  const state = await job.getState();
  const failedReason = job.failedReason;

  return {
    id: jobId,
    state: state as JobStatus['state'],
    progress: job.progress as number | object,
    result: job.returnvalue ?? null,
    error: failedReason || undefined,
  };
}
