import { Worker } from 'bullmq';
import { getRedisConnection } from '../connection';
import { getConfig } from '../../config';
import { upsertIndex } from '../../db/codebase-indices';
import { logAction } from '../../db/audit-log';
import { indexRepository } from '@sutura/vector-indexer';
import type { IndexJobData } from '../queues';
import { decryptSecret } from '../../lib/secret-encryption';

export function startIndexWorker(): Worker {
  return new Worker<IndexJobData>(
    'index-queue',
    async (job) => {
      const { repo, branch, orgId } = job.data;
      // githubToken is encrypted in the Redis payload (see enqueueIndexJob).
      // decryptSecret tolerates plaintext for old in-flight jobs.
      const githubToken = decryptSecret(job.data.githubToken);
      const config = getConfig();

      // Run indexRepository
      const result = await indexRepository(repo, branch, githubToken, orgId, {
        voyageApiKey: config.VOYAGE_API_KEY,
        pineconeApiKey: config.PINECONE_API_KEY,
      });

      // Update codebase_indices via upsertIndex
      await upsertIndex({
        org_id: orgId,
        repo,
        branch,
        vector_namespace: result.namespace,
        file_count: result.fileCount,
        chunk_count: result.chunkCount,
      });

      // Log to audit_log
      await logAction({
        org_id: orgId,
        actor: 'index-worker',
        action: 'repository.indexed',
        resource_type: 'repository',
        resource_id: repo,
        metadata_json: {
          branch,
          fileCount: result.fileCount,
          chunkCount: result.chunkCount,
          namespace: result.namespace,
        },
      });

      return { fileCount: result.fileCount, chunkCount: result.chunkCount, namespace: result.namespace };
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );
}
