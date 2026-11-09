import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { NormalizedFinding } from '@sutura/common';
import { classifyRemediationClass } from '@sutura/common';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getFinding, getFindingByExternal, upsertFinding } from '../db/findings';
import { listAttemptsByFinding, getFixAttempt } from '../db/fix-attempts';
import { listSandboxLogs } from '../db/sandbox-logs';
import type { DbFinding } from '../db/types';
import { dbFixAttemptToApiResponse, dbSandboxLogToApiResponse } from '../db/types';
import { enqueueValidationJob, cancelValidationJob } from '../queue/enqueue';

export const validatedFixRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a "dashboard id" (either a backend UUID or a synthetic
 * `<scanner>-<externalId>` like `aikido-237990516`) to a DbFinding row.
 * Returns null when nothing matches; the caller can decide whether to upsert.
 */
async function resolveFinding(orgId: string, dashboardId: string): Promise<DbFinding | null> {
  if (UUID_RE.test(dashboardId)) {
    const f = await getFinding(dashboardId);
    return f && f.org_id === orgId ? f : null;
  }
  const dash = parseDashboardId(dashboardId);
  if (!dash) return null;
  return await getFindingByExternal(orgId, dash.scanner, dash.externalId);
}

function parseDashboardId(id: string): { scanner: string; externalId: string } | null {
  const idx = id.indexOf('-');
  if (idx <= 0) return null;
  const scanner = id.slice(0, idx);
  const externalId = id.slice(idx + 1);
  if (!externalId) return null;
  return { scanner, externalId };
}

/**
 * POST /api/findings/:id/validated-fix -- enqueue a validated-fix job.
 *
 * Accepts a `finding` body field (NormalizedFinding shape) so that
 * dashboard-side findings (which live in the user's Aikido cookie, not the
 * backend `findings` table) can be upserted here on first use. The fix_attempt
 * row needs a real findings.id FK, so we always resolve to a backend UUID
 * before enqueueing.
 */
validatedFixRouter.post(
  '/findings/:id/validated-fix',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const dashboardId = String(req.params.id);
      const body = (req.body ?? {}) as {
        targetBranch?: string;
        reviewers?: string[];
        maxAttempts?: number;
        aikidoApiKey?: string;
        anthropicApiKey?: string;
        priorAnalysis?: string;
        finding?: NormalizedFinding;
      };

      let finding = await resolveFinding(authReq.orgId, dashboardId);
      if (!finding && body.finding) {
        finding = await upsertFinding(authReq.orgId, body.finding);
      }
      if (!finding) {
        res.status(404).json({ error: 'Finding not found' });
        return;
      }

      if (
        classifyRemediationClass({ repo: finding.repo, rawPayload: finding.raw_payload }) ===
        'advisory'
      ) {
        res.status(400).json({
          error:
            'This finding is advisory (container/OS package) and has no source repo to patch. Upgrade the image or package instead.',
        });
        return;
      }

      const jobId = await enqueueValidationJob({
        findingId: finding.id,
        orgId: authReq.orgId,
        targetBranch: body.targetBranch,
        reviewers: body.reviewers,
        maxAttempts: body.maxAttempts,
        aikidoApiKey: body.aikidoApiKey,
        anthropicApiKey: body.anthropicApiKey,
        priorAnalysis: body.priorAnalysis,
      });
      res.status(202).json({ jobId, findingId: finding.id });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/findings/:id/validated-fix/status -- list attempts (chained).
 *
 * Returns an empty status (200) when the dashboard id doesn't yet correspond
 * to a backend `findings` row -- this is the normal case before the user
 * triggers their first validated fix on a cookie-only Aikido finding.
 */
validatedFixRouter.get(
  '/findings/:id/validated-fix/status',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const dashboardId = String(req.params.id);
      const finding = await resolveFinding(authReq.orgId, dashboardId);
      if (!finding) {
        res.json({ findingId: dashboardId, currentAttempt: 0, running: false, attempts: [] });
        return;
      }
      const attempts = await listAttemptsByFinding(finding.id);
      const last = attempts[attempts.length - 1];
      res.json({
        findingId: finding.id,
        currentAttempt: last?.attempt_number ?? 0,
        running: last?.status === 'running',
        attempts: attempts.map(dbFixAttemptToApiResponse),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/findings/:id/validated-fix/cancel -- best-effort cancellation.
 */
validatedFixRouter.post(
  '/findings/:id/validated-fix/cancel',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const dashboardId = String(req.params.id);
      const finding = await resolveFinding(authReq.orgId, dashboardId);
      if (!finding) {
        res.json({ cancelled: false });
        return;
      }
      const { jobId } = (req.body ?? {}) as { jobId?: string };
      if (!jobId) {
        res.status(400).json({ error: 'jobId is required' });
        return;
      }
      const cancelled = await cancelValidationJob(jobId);
      res.json({ cancelled });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/fix-attempts/:id/sandbox-logs
 */
validatedFixRouter.get(
  '/fix-attempts/:id/sandbox-logs',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = String(req.params.id);
      const attempt = await getFixAttempt(id);
      if (!attempt || attempt.org_id !== authReq.orgId) {
        res.status(404).json({ error: 'Fix attempt not found' });
        return;
      }
      const logs = await listSandboxLogs(id);
      res.json({ data: logs.map(dbSandboxLogToApiResponse) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/fix-attempts/:id/test-output -- convenience accessor for the UI.
 */
validatedFixRouter.get(
  '/fix-attempts/:id/test-output',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = String(req.params.id);
      const attempt = await getFixAttempt(id);
      if (!attempt || attempt.org_id !== authReq.orgId) {
        res.status(404).json({ error: 'Fix attempt not found' });
        return;
      }
      const logs = await listSandboxLogs(id);
      const testLog = logs.find((l) => l.step === 'tests');
      const scanLog = logs.find((l) => l.step === 'scan');
      res.json({
        testResult: attempt.test_result,
        validationStatus: attempt.validation_status,
        scanTool: attempt.scan_tool,
        testOutput: attempt.test_output,
        scanOutput: attempt.scan_output,
        testFilesAdded: attempt.test_files_added,
        durations: {
          testsMs: testLog?.duration_ms ?? null,
          scanMs: scanLog?.duration_ms ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
