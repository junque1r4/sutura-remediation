import { Worker } from 'bullmq';
import { getRedisConnection } from '../connection';
import { getConfig } from '../../config';
import { getFinding, updateFindingStatus } from '../../db/findings';
import { getOrganization } from '../../db/organizations';
import { getConnectionSecret } from '../../db/connections';
import { createFixAttempt, updateFixAttempt } from '../../db/fix-attempts';
import { createTokenUsage } from '../../db/token-usage';
import { logAction } from '../../db/audit-log';
import { FixPipeline } from '@sutura/fix-engine';
import { DEFAULT_CLAUDE_MODEL } from '@sutura/common';
import type { NormalizedFinding } from '@sutura/common';
import type { DbFinding } from '../../db/types';
import type { FixJobData } from '../queues';

function dbFindingToNormalized(row: DbFinding): NormalizedFinding {
  let lineRange: [number, number] | undefined;
  if (row.line_range) {
    // Stored as "[start,end]" postgres int4range literal
    const match = row.line_range.match(/\[(\d+),(\d+)\]/);
    if (match) {
      lineRange = [parseInt(match[1], 10), parseInt(match[2], 10)];
    }
  }

  return {
    externalId: row.external_id,
    scanner: row.scanner_source as NormalizedFinding['scanner'],
    title: row.title,
    description: row.description ?? '',
    severity: row.severity,
    cvssScore: row.cvss_score ?? undefined,
    epssScore: row.epss_score ?? undefined,
    cweId: row.cwe_id ?? undefined,
    cveId: row.cve_id ?? undefined,
    filePath: row.file_path ?? undefined,
    lineRange,
    repo: row.repo,
    rawPayload: {},
  };
}

export function startFixWorker(): Worker {
  return new Worker<FixJobData>(
    'fix-queue',
    async (job) => {
      const { findingId, orgId } = job.data;
      const config = getConfig();

      // 1. Get finding and org from DB
      const finding = await getFinding(findingId);
      if (!finding) {
        throw new Error(`Finding ${findingId} not found`);
      }

      const org = await getOrganization(orgId);
      if (!org) {
        throw new Error(`Organization ${orgId} not found`);
      }

      // 2. Mark finding as 'fixing'
      await updateFindingStatus(findingId, 'fixing');

      // 3. Create initial fix_attempt record
      const fixAttempt = await createFixAttempt({
        finding_id: findingId,
        org_id: orgId,
        prompt_snapshot: '',
        claude_model: DEFAULT_CLAUDE_MODEL,
      });

      try {
        // 4. Build NormalizedFinding from DB row
        const normalizedFinding = dbFindingToNormalized(finding);

        // Resolve the Anthropic key from the org-scoped DB connection
        // (decrypted) and fall back to env config. No request cookie is
        // involved -- the worker reads the connection directly.
        const anthropicApiKey =
          (await getConnectionSecret(orgId, 'anthropic').catch(() => null)) ||
          config.ANTHROPIC_API_KEY;

        // 5. Run FixPipeline.execute()
        const pipeline = new FixPipeline({
          anthropicApiKey,
          voyageApiKey: config.VOYAGE_API_KEY,
          pineconeApiKey: config.PINECONE_API_KEY,
          githubToken: '', // org-level token not available here; submitter handles it
        });

        const result = await pipeline.execute(
          normalizedFinding,
          orgId,
          org.custom_prompts_json,
          org.settings_json?.autoFixSeverityThreshold,
        );

        // 6. Update fix_attempt with results
        await updateFixAttempt(fixAttempt.id, {
          generated_diff: result.fixAttempt.generatedDiff ?? null,
          test_result: result.fixAttempt.testResult ?? null,
          pr_url: result.fixAttempt.prUrl ?? null,
          pr_status: result.fixAttempt.prStatus ?? null,
          claude_tokens_used: result.fixAttempt.claudeTokensUsed,
          completed_at: new Date().toISOString(),
        });

        // 6b. Record token usage (non-fatal on failure).
        // Store BOTH the DB UUID and the scanner external_id so the dashboard
        // (which keys by external_id) can find it.
        if (result.tokenUsage) {
          await createTokenUsage({
            org_id: orgId,
            operation: 'fix_generation',
            model: result.tokenUsage.model,
            input_tokens: result.tokenUsage.inputTokens,
            output_tokens: result.tokenUsage.outputTokens,
            finding_id: finding.external_id,
            finding_title: finding.title,
            finding_severity: finding.severity,
            fix_attempt_id: fixAttempt.id,
            prompt: result.tokenUsage.prompt,
            response: result.tokenUsage.response,
          }).catch(() => {});
        }

        // 7. Update finding status
        await updateFindingStatus(findingId, result.skipped ? 'open' : 'fixed');

        // 8. Log to audit_log
        await logAction({
          org_id: orgId,
          actor: 'fix-worker',
          action: result.skipped ? 'fix.skipped' : 'fix.completed',
          resource_type: 'finding',
          resource_id: findingId,
          metadata_json: {
            fixAttemptId: fixAttempt.id,
            skipped: result.skipped,
            reason: result.reason,
            prUrl: result.fixAttempt.prUrl,
          },
        });

        return { fixAttemptId: fixAttempt.id, skipped: result.skipped };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Error handling: mark finding as 'failed', update attempt, log error
        await updateFindingStatus(findingId, 'failed').catch(() => {});
        await updateFixAttempt(fixAttempt.id, {
          completed_at: new Date().toISOString(),
        }).catch(() => {});

        await logAction({
          org_id: orgId,
          actor: 'fix-worker',
          action: 'fix.failed',
          resource_type: 'finding',
          resource_id: findingId,
          metadata_json: { fixAttemptId: fixAttempt.id, error: errorMessage },
        }).catch(() => {});

        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );
}
